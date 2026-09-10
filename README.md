# EvolvedCV

**An interactive, data-driven CV for people who have too many skills to fit on one page.**

A linear résumé rewards a single, legible specialization. It quietly punishes the
opposite: the T-shaped people, the polymaths, the ones whose honest answer to
"what do you do?" is a list. Their CV reads as *unfocused* — not because the work
is weak, but because the **format** flattens range into noise. Plenty of strong
profiles get filtered out by the shape of the page, never by the substance.

EvolvedCV is a small experiment in fixing that. Instead of one frozen ordering,
the whole CV is **navigable**: the visitor filters your experience by the skills
*they* care about, and the page re-composes to show exactly the slice that's
relevant to them. "Knows too many things" stops being a liability and becomes
something you can explore.

> **Live example:** a CV built with EvolvedCV → **https://ecv.2two.cloud**
>
> **The story behind it:** why it exists, how it was built, screenshots and the mobile version → **https://w-interaction.com/EC2.html** (Winteraction Lab, IT/EN)
>
> The data in *this* repository is **fictitious sample data** (a made-up person,
> "Christina Debug") whose skills span five overlapping fields — just enough to
> show what the filter is for. Swap it for your own.

---

## What's inside

- **WebGL hero** — a particle field (Three.js) that assembles into your name and
  reacts as you move through the page; degrades gracefully to a clean static CV
  when WebGL or reduced-motion is unavailable.
- **Skill filter** — pick skills and the Experience section re-packs to the
  matching roles, with the headline adapting to what you've selected.
- **Fully data-driven** — all content lives in two JSON files. Change the JSON,
  change the site. No components to edit, no build step.
- **Bilingual** — every text field is `{ en, it }` (easy to update on your own or
  with the help of an LLM); the UI switches language live.
- **Print / PDF** — a tuned print stylesheet turns the page into a clean,
  recruiter-friendly PDF.
- **Local editor** — a small GUI to edit the JSON with live preview, so you never
  hand-write the data files.
- **Responsive** — built for phone and desktop.

PS. Testing so far hasn't turned up any functional bugs. That said, I can't rule out
100% the odd display quirk depending on the device used.

## Data model

Two files under `site/` are the single source of truth:

- **`cv_data.json`** — textual content: profile, experience, education, the skill
  taxonomy (domains → skills) and the dynamic-title rules.
- **`cv_ui.json`** — everything non-textual: theme colors, per-domain colors,
  particle and glass settings, layout knobs.

A tiny zero-dependency script regenerates the inlined snapshots the site reads:

```bash
node tools/sync-data.mjs
```

Run it after editing either JSON (the local editor does it for you on save).

## Quick start

No dependencies, no build. You just need Node.js (for the dev servers).

```bash
# 1. Serve the site
node tools/serve.mjs            # → http://localhost:8741

# 2. (optional) Open the local editor — edit JSON with a live preview
node server/dev-server.mjs      # → http://localhost:8765/editor/
```

Then edit `site/cv_data.json` / `site/cv_ui.json` (or use the editor), run
`node tools/sync-data.mjs`, and refresh.

## Make it yours

1. Replace `site/cv_data.json` with your content (the local editor is the easy
   way), and your photo in `site/assets/`.
2. Tune colors and effects in `site/cv_ui.json`.
3. `node tools/sync-data.mjs`.
4. Deploy the static `site/` folder anywhere. A worked example (Caddy + a small
   contact endpoint) is in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Project layout

```
site/        the static site (HTML/CSS/JS, the two JSON files, assets)
editor/      the local editor UI
server/      tiny dev backend for the editor (read/write JSON + sync)
tools/       sync, local server, OG-image generator, tests
deploy/      example reverse-proxy config
docs/        deploy guide
```

## License

Code is released under the **MIT License** — see [`LICENSE`](LICENSE). The sample
CV content is fictitious and provided only to demonstrate the template; it is not
covered as reusable "content" — bring your own.

---

*Built with EvolvedCV. If the linear CV ever filtered you out for doing too much,
this is for you — take it, fork it, make it yours.*
