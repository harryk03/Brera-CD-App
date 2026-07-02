# assets/

## `alfa-badge.png` — **required, must be supplied by you**

The fixed top-right brand watermark references **`assets/alfa-badge.png`**.

This is a static brand asset — nothing in the app can generate or fetch it,
so it has to be dropped in here as a real file before it can render. Drop your
Alfa Romeo badge image in this folder with exactly that name.

Requirements for a clean result:
- **PNG with real alpha transparency** (the app relies on the image's own
  transparency, *not* CSS `mix-blend-mode`, which was unreliable on mobile).
- Roughly square; it is displayed at ~168px and bled off the top-right corner
  at ~0.17 opacity.

Until the file is present, the watermark simply doesn't render (the `<img>`
`onerror` hides it) — the rest of the app works normally. Once you add
`alfa-badge.png`, it appears automatically; no code change needed.
