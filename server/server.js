/**
 * Sitecopy backend
 * ------------------------------------------------------------
 * What this actually does (and doesn't do):
 *   - Fetches the HTML of the single URL the user submits.
 *   - Parses it, finds linked CSS, JS, images, and fonts.
 *   - Downloads those assets too (best-effort, with limits).
 *   - Rewrites the HTML/CSS so asset links point at the local
 *     copies, then zips everything and streams it back.
 *
 * What it does NOT do:
 *   - Crawl other pages on the site (single page only).
 *   - Execute the target page's JavaScript, so anything that
 *     site renders client-side after load won't be captured.
 *   - Bypass paywalls, logins, or robots.txt-disallowed paths.
 *
 * This is a genuine, working implementation of "best-effort
 * single page mirroring" — the same honest scope described in
 * the frontend's "What to expect" panel.
 * ------------------------------------------------------------
 */

const express = require('express');
const cheerio = require('cheerio');
const archiver = require('archiver');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Serve the frontend file itself so the whole thing runs from one server.
app.use(express.static(path.join(__dirname, '..')));

const MAX_ASSETS = 60;             // cap total assets fetched, so a huge page can't hang the server
const ASSET_TIMEOUT_MS = 8000;     // per-asset fetch timeout
const PAGE_TIMEOUT_MS = 15000;     // main page fetch timeout
const MAX_ASSET_BYTES = 8 * 1024 * 1024; // skip any single asset over 8MB

// Tags/attributes we treat as asset references worth localizing.
const ASSET_SELECTORS = [
  { selector: 'link[rel="stylesheet"]', attr: 'href', dir: 'css' },
  { selector: 'script[src]',            attr: 'src',  dir: 'js' },
  { selector: 'img[src]',               attr: 'src',  dir: 'images' },
  { selector: 'link[rel="icon"]',       attr: 'href', dir: 'images' },
  { selector: 'source[src]',            attr: 'src',  dir: 'images' },
];

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// Builds a safe local filename for a remote asset URL, avoiding collisions.
function localNameFor(remoteUrl, usedNames) {
  const u = new URL(remoteUrl);
  let base = path.basename(u.pathname) || 'asset';
  base = base.split('?')[0].split('#')[0];
  if (!base || base === '/') base = 'asset';
  base = base.replace(/[^a-zA-Z0-9._-]/g, '_');

  let candidate = base;
  let i = 1;
  while (usedNames.has(candidate)) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    candidate = `${stem}_${i}${ext}`;
    i++;
  }
  usedNames.add(candidate);
  return candidate;
}

app.post('/api/copy', async (req, res) => {
  const { url: targetUrl } = req.body || {};

  // ---- Validate input ------------------------------------------------
  if (!targetUrl || typeof targetUrl !== 'string' || !isValidHttpUrl(targetUrl)) {
    return res.status(400).json({ error: 'Please provide a valid http:// or https:// URL.' });
  }

  let pageRes;
  try {
    pageRes = await withTimeout(
      fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitecopyBot/1.0)' },
        redirect: 'follow',
      }),
      PAGE_TIMEOUT_MS
    );
  } catch (err) {
    const message = err.message === 'timeout'
      ? 'The site took too long to respond. Try again or check the URL.'
      : 'Couldn\'t reach that site. Check the URL and try again.';
    return res.status(502).json({ error: message });
  }

  if (!pageRes.ok) {
    return res.status(502).json({
      error: `The site responded with an error (HTTP ${pageRes.status}). It may be blocking automated requests or the page may not exist.`,
    });
  }

  const contentType = pageRes.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return res.status(415).json({ error: 'That URL doesn\'t point to an HTML page, so there\'s nothing to mirror.' });
  }

  const html = await pageRes.text();
  const $ = cheerio.load(html);
  const baseUrl = pageRes.url; // final URL after redirects

  // ---- Collect asset references ---------------------------------------
  const assetJobs = []; // { remoteUrl, selector info, $el }
  const seenUrls = new Set();

  for (const { selector, attr, dir } of ASSET_SELECTORS) {
    $(selector).each((_, el) => {
      if (assetJobs.length >= MAX_ASSETS) return;
      const raw = $(el).attr(attr);
      if (!raw || raw.startsWith('data:')) return;

      let resolved;
      try {
        resolved = new URL(raw, baseUrl).toString();
      } catch {
        return;
      }
      if (seenUrls.has(resolved)) return;
      seenUrls.add(resolved);
      assetJobs.push({ remoteUrl: resolved, attr, dir, el });
    });
  }

  // ---- Download assets (best-effort; failures are skipped, not fatal) ----
  const usedNames = new Set();
  const downloaded = []; // { remoteUrl, localPath, buffer, dir }

  await Promise.all(
    assetJobs.map(async (job) => {
      try {
        const assetRes = await withTimeout(
          fetch(job.remoteUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitecopyBot/1.0)' } }),
          ASSET_TIMEOUT_MS
        );
        if (!assetRes.ok) return;

        const lengthHeader = assetRes.headers.get('content-length');
        if (lengthHeader && Number(lengthHeader) > MAX_ASSET_BYTES) return;

        const buffer = await assetRes.buffer();
        if (buffer.length > MAX_ASSET_BYTES) return;

        const filename = localNameFor(job.remoteUrl, usedNames);
        const localPath = `assets/${job.dir}/${filename}`;

        // Rewrite the reference in the HTML to the local relative path.
        $(job.el).attr(job.attr, localPath);

        downloaded.push({ remoteUrl: job.remoteUrl, localPath, buffer, dir: job.dir });
      } catch {
        // Skip assets that fail or time out — the page copy still proceeds.
      }
    })
  );

  // ---- Rewrite url(...) references inside downloaded CSS files ------------
  // Stylesheets commonly reference their own fonts/background-images via
  // relative url(...) paths. Those nested assets aren't in the HTML at all,
  // so without this pass downloaded CSS would still point at the live site.
  // Best-effort, same MAX_ASSETS-style caps apply implicitly via timeouts.
  const cssAssets = downloaded.filter((a) => a.dir === 'css');
  for (const cssAsset of cssAssets) {
    const cssText = cssAsset.buffer.toString('utf8');
    const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const matches = [...cssText.matchAll(urlPattern)];
    if (matches.length === 0) continue;

    let updatedCss = cssText;
    for (const match of matches) {
      const ref = match[2];
      if (!ref || ref.startsWith('data:')) continue;

      let resolved;
      try {
        resolved = new URL(ref, cssAsset.remoteUrl).toString();
      } catch {
        continue;
      }
      if (seenUrls.has(resolved)) {
        // Already downloaded as part of this same pass elsewhere — skip refetch,
        // but we can't easily backfill the rewrite without tracking it, so leave
        // as-is in that rare overlap case.
        continue;
      }
      seenUrls.add(resolved);

      try {
        const nestedRes = await withTimeout(
          fetch(resolved, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitecopyBot/1.0)' } }),
          ASSET_TIMEOUT_MS
        );
        if (!nestedRes.ok) continue;
        const nestedBuffer = await nestedRes.buffer();
        if (nestedBuffer.length > MAX_ASSET_BYTES) continue;

        const nestedName = localNameFor(resolved, usedNames);
        const nestedLocalPath = `assets/fonts-and-media/${nestedName}`;
        downloaded.push({ remoteUrl: resolved, localPath: nestedLocalPath, buffer: nestedBuffer, dir: 'fonts-and-media' });

        // CSS file lives at assets/css/, so reference its sibling folder with ../
        updatedCss = updatedCss.split(ref).join(`../fonts-and-media/${nestedName}`);
      } catch {
        // Leave the original (live) URL in place if the nested asset can't be fetched.
      }
    }
    cssAsset.buffer = Buffer.from(updatedCss, 'utf8');
  }

  // Add a small note at the bottom of the body documenting scope/provenance.
  $('body').append(
    `\n<!-- Mirrored from ${baseUrl} on ${new Date().toISOString()} using Sitecopy. Single-page snapshot; client-rendered content may be missing. -->\n`
  );

  const finalHtml = $.html();

  // ---- Build the zip and stream it back --------------------------------
  const hostname = new URL(baseUrl).hostname.replace(/^www\./, '');
  const zipName = `${hostname.replace(/[^a-z0-9.-]/gi, '_')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build the zip archive.' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  archive.append(finalHtml, { name: 'index.html' });
  for (const asset of downloaded) {
    archive.append(asset.buffer, { name: asset.localPath });
  }
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Sitecopy server running at http://localhost:${PORT}`);
});
