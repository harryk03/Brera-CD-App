# Spotify playlist proxy (Cloudflare Worker)

`worker.js` is a tiny Cloudflare Worker that lets Brera Stacker import a
**public** Spotify playlist's track list without any Spotify account, Client
ID, secret, or sign-in.

The browser can't read Spotify's embed page directly (`open.spotify.com`
sends no CORS headers), so the Worker fetches
`https://open.spotify.com/embed/playlist/<id>` server-side, pulls the
track list out of the server-rendered JSON, and returns:

```json
{ "id": "…", "name": "Road Trip", "trackCount": 12,
  "tracks": [ { "title": "Work", "artists": ["Rihanna", "Drake"], "durationMs": 219000 } ] }
```

Private playlists return `404`. Results are cached at Cloudflare's edge for
an hour.

## Deploy

**Option A — Cloudflare dashboard (no tooling):**

1. Log in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Create Worker**.
2. Name it (e.g. `brera-spotify`) and click **Deploy** to get the starter.
3. Click **Edit code**, replace everything with the contents of `worker.js`,
   then **Deploy**.
4. Copy the Worker URL, e.g. `https://brera-spotify.<your-subdomain>.workers.dev`.

**Option B — Wrangler CLI:**

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler deploy worker.js --name brera-spotify
```

## Wire it into the app

1. Open `js/spotify.js` and set the `PROXY` constant to your Worker URL
   (no trailing slash).
2. If you host the app somewhere other than `https://harryk03.github.io`,
   add that origin to `ALLOWED_ORIGINS` at the top of `worker.js` and
   redeploy. `localhost:8000` / `127.0.0.1:8000` are already allowed for
   local testing.

## Test it

```
https://brera-spotify.<your-subdomain>.workers.dev/?playlist=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
```

If you get `No tracks found`, add `&debug=1` to see the first 4 KB of the
embed HTML — usually the playlist is private, or Spotify changed its markup.
