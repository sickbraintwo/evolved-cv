# Deploy — EvolvedCV

The site is **fully static** (`site/`), so production = serve `site/` with any
web server (Caddy, nginx, Apache, Netlify, etc.). No build step. CDN deps
(Three.js, GSAP, Google Fonts) load at runtime from the internet.
Only `site/` ships — never `server/`, `editor/`, `tools/`.

## Prerequisites (one-time)

1. **DNS** — add an `A` record pointing your domain at your server's public IP.
2. **Web server mount** — if using Caddy in Docker, make sure `/path/to/evolved-cv/site`
   is visible inside the container (add a bind mount in your `docker-compose.yml`).
   See `deploy/Caddyfile.example` for a ready-to-paste Caddy config block.

## First deploy

```bash
# 1. Push the files (from the repo root, in Git Bash or any POSIX shell):
DEPLOY_SSH=user@your-server.example ./tools/deploy-ecv.sh
#    → packs site/ (minus test.html, js/test-suite.js, proposals/), streams it
#      over SSH, and refills the remote directory IN PLACE (preserves the
#      directory inode so a Docker bind mount keeps working — no restart needed).

# 2. Add the Caddy block (paste deploy/Caddyfile.example into your Caddyfile,
#    replacing "your-domain.example" and "/path/to/evolved-cv/site"), then:
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload   --config /etc/caddy/Caddyfile
```

Caddy provisions a Let's Encrypt TLS certificate automatically once DNS resolves.
First load may take a few seconds while the cert is issued.

## Later deploys

Just re-run the push — the web server needs nothing more:

```bash
DEPLOY_SSH=user@your-server.example ./tools/deploy-ecv.sh
```

## Verify

```bash
curl -sI https://your-domain.example/                         # → 200, text/html
curl -s  https://your-domain.example/cv_data.json | head      # → JSON loads
curl -sI https://your-domain.example/test.html                # → 404 (dev file blocked)
```

Then open `https://your-domain.example` on desktop + phone: intro deflagration →
name composes, scroll through sections, open the Experience filter on mobile.

## Known gap — contact form

The contact form POSTs `{email, message}` to **`/api/contact`**, which has **no
backend yet** (`site/js/ui-renderer.js`, endpoint in `site/cv_ui.json`). Until a
handler exists, submitting shows *"Couldn't send right now."*

Planned fix: route `your-domain.example/api/contact` via Caddy `reverse_proxy`
to an automation webhook (e.g. n8n, Make, Zapier) that relays the mail — the
`deploy/Caddyfile.example` already has a placeholder block for this. The endpoint
must be same-origin (no CORS) and should include rate-limiting; a honeypot field
is already present in the form HTML.
