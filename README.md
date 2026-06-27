# Sitecopy — Website Copier

A working tool to mirror a single web page — its HTML plus the CSS, JS,
images, and fonts it references — into a downloadable zip.

## Honest scope (read this first)

Browsers can't fetch another domain's raw source from client-side JS alone
(CORS blocks it). So this only works with the small Node backend included
here — there's no version of this that's "just open index.html and it works
against any site," and any tool that claims that is either lying or running
a server behind the scenes too.

What it does:
- Fetches the exact URL you give it.
- Downloads linked CSS, JS, images, icons, and fonts referenced by `url()`
  inside that CSS.
- Rewrites all those references to local relative paths.
- Zips it all up and sends it back.

What it doesn't do:
- Crawl other pages on the site — single page only.
- Execute the target page's JavaScript — anything rendered client-side
  after load (most React/Vue/etc. apps) won't show up in the copy.
- Get past logins, paywalls, or sites that actively block bots.

## Run it

```bash
cd server
npm install
npm start
```

Then open **http://localhost:3000** — the server hosts the frontend
itself, so there's nothing else to configure. Paste a URL, click "Copy
site," and a zip will download.

If you'd rather host `index.html` separately (e.g. a static host) and
point it at a backend running elsewhere, change `API_ENDPOINT` near the
top of the `<script>` block in `index.html` to your server's full URL,
e.g. `https://your-server.com/api/copy`. You'll also need to add CORS
headers on the server in that case (not included by default, since
same-origin is the simpler setup).

## Files

```
index.html          — the entire frontend (HTML + CSS + JS, single file)
server/server.js     — the Express backend that does the real fetching/zipping
server/package.json  — backend dependencies (express, cheerio, archiver, node-fetch)
```

## Notes on testing

This was built and syntax-checked in a sandboxed environment with no
outbound network access, so the live fetch-a-real-site path hasn't been
exercised end-to-end yet. The logic has been reviewed carefully, but please
run it against a couple of real URLs (try a simple static page first, e.g.
`https://example.com`, then something with more assets) and check the
resulting zip before relying on it for anything important.

Common things to watch for once you test live:
- Sites that return non-200 for bot-like User-Agents (some will 403 this
  tool — that's expected and surfaced as an error message, not a crash).
- Very asset-heavy pages may hit the `MAX_ASSETS` cap (60) and only
  partially mirror — increase the constant at the top of `server.js` if
  you need more.
- Modern JS-framework sites (React/Vue/Next/etc.) will download fine but
  the resulting `index.html` will look mostly empty when opened locally,
  since the real content was rendered by JavaScript Sitecopy doesn't run.
