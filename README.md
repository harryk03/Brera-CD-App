# Brera Stacker

A personal, single-user **PWA** (installable mobile web app) that mirrors the
CD setup in an Alfa Romeo Brera: a **10-CD rear boot stacker**, **1
hot-swappable dash slot**, and a **library of spare CDs** you own but aren't
currently in the car. It tracks which physical slot holds what, so you can
re-arrange the real stack to match the app (or vice versa) and always know
what's playable.

It works **fully offline** once installed and **persists all state** locally
(nothing resets on reload).

## Running it

It's a static app — no build step. Serve the folder over HTTP (a service
worker + PWA install require a served origin, not `file://`):

```bash
python3 -m http.server 8123
# then open http://localhost:8123 on your phone and "Add to Home Screen"
```

Host it anywhere static (GitHub Pages, Netlify, etc.) to install it on the car
phone.

> **Note:** iTunes lookups (artwork, tracklists, song search) require a live
> served origin with network access. Opening `index.html` directly as a
> `file://` URL blocks those `fetch` calls — everything else still works.

## Architecture

| File | Role |
|------|------|
| `index.html` | App shell, tab bar, watermark, sheet/toast mounts |
| `css/styles.css` | All styling; design tokens from the spec are treated as final |
| `js/app.js` | Views, state transitions, the container-transform tracklist animation, Add/Swap flows |
| `js/store.js` | IndexedDB persistence — app state + durable cover-image blobs |
| `js/itunes.js` | Zero-auth iTunes Search API + `(feat. …)` parsing + specific network errors |
| `js/util.js` | uuid, initials, palette, toast, helpers |
| `manifest.webmanifest`, `sw.js` | PWA install + offline app-shell cache |
| `icons/` | Generated app icons (`scripts/gen-icons.mjs`) |
| `assets/` | **`alfa-badge.png` must be supplied by you** — see `assets/README.md` |

### Persistence

Everything lives in **IndexedDB** (`brera-stacker`):
- `state` store — a single `AppState` record (`stacker[10]`, `dash`, `spares[]`).
- `images` store — cover-art **blobs**. Artwork fetched from iTunes or uploaded
  by you is copied into local storage, so covers render offline. Albums
  reference an image by id (`coverImageUri`), resolved to an object URL at
  render time.

### Key behaviors

- **Swap** moves a spare into a stacker slot or the dash; whatever was there
  returns to Spares. Filling an *empty* dash removes the spare outright (no
  `null` placeholder).
- **Eject** (dash only) returns the disc to Spares instantly, no confirm.
- **Delete** (spares only, at the bottom of a CD's tracklist) is the one
  destructive action — two-tap confirm.
- **Reorder mode** repositions within the 10 stacker slots (▲▼); it never
  touches Spares.
- **Add CD** — *Album* (iTunes album search → full tracklist) or *Burnt CD*
  (per-song search, each track keeps its own artist). Duplicate protection
  checks Stacker + Dash + Spares. New CDs always land in Spares.
- **Background artwork backfill** — on load, any album missing a cover is
  looked up on iTunes sequentially and cached; fails silently offline.

## Dev scripts (`scripts/`)

Optional tooling; needs Playwright (`npm i playwright`). Not required to run the app.

- `gen-icons.mjs` — render `icons/icon.svg` to the PWA PNGs.
- `smoke.mjs`, `smoke-add.mjs` — end-to-end smoke tests against a served copy.

## Deliberately not built

Spotify/Apple Music import, dark mode, per-album accent colors, and confirm
dialogs on swap/eject — all explicitly out of scope.
