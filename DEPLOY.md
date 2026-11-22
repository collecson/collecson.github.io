# Collecson website: deploy notes (not deployed)

Static site, relative links, no build step, no analytics. Every page has `noindex,nofollow,noarchive` and `robots.txt` disallows all, so it stays out of search until you decide otherwise.

Layout
- `index.html` home · `features/` · `get-started/` · `examples/whisky/` · `examples/trainers/` · `examples/tractors/`
- `app/` the Collecson phone app (PWA, service worker scoped to /app/) · `guide/` setup guide PDF
- `assets/` CSS, self-hosted fonts (SIL OFL, licences in assets/fonts), logo, screenshots, SVG art
- `CNAME` = collecson.com · `.nojekyll` · `404.html` (uses absolute `/` links, fine on a custom domain)

GitHub Pages (later, from the new Collecson GitHub account only)
1. Create a repo under the Collecson account and push the *contents* of `ck_publish/` to its default branch root.
2. Settings → Pages → Deploy from branch → main / root. Custom domain: collecson.com (the CNAME file is already here). Tick Enforce HTTPS once the certificate is issued.
3. DNS at the registrar: apex A records 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153 (AAAA 2606:50c0:8000::153 … 8003::153 optional); `www` CNAME → the account's default GitHub Pages domain.
4. When ready to be found: remove the robots meta tags (rebuild with build_site.py) and change robots.txt.

Regenerate pages: `python3 /workspace/ck_work/site/build_site.py` (art: render_art.py, app screenshots: shoot_app.py against showcase_server.js).
All example collections use invented names, makers and figures.
