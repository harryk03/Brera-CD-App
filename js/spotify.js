/* ============================================================
   spotify.js — Spotify playlist metadata, no login.

   DROP-IN REPLACEMENT for the PKCE version. Same exported names,
   same return shapes, so app.js needs no changes.

   What changed and why:
   The Web API requires an access token on every endpoint, which
   means either shipping a secret (forbidden) or making the user
   sign in (friction). Spotify's own embed page, however, renders
   a public playlist's track list into the HTML with no auth at
   all. The browser can't read it directly — open.spotify.com
   sends no CORS headers, so fetch() dies with "Failed to fetch" —
   so a tiny Cloudflare Worker does that fetch server-side and
   hands back clean JSON.

   Trade-offs, stated plainly:
   - No sign-in, no Client ID, no secret, nothing to configure.
   - PUBLIC playlists only. A private one returns "not found".
     (Playlists you create are public by default; "Make private"
     is opt-in. Check by opening the link in a private window.)
   - Depends on Spotify's embed markup, which they can change
     without notice. The parser is written defensively, but this
     is not a supported API and may break one day.
   ============================================================ */

import { NetworkError } from './itunes.js';

// Your deployed Worker. Change if you rename it.
const PROXY = 'https://brera-spotify.hazzer-848.workers.dev';

/* ---- Config shims -------------------------------------------------
   The old build made you paste a Client ID. There's nothing to
   configure now, so these report "ready" and app.js skips straight
   to the "Paste a playlist link" field. */

export function getClientId() { return ''; }
export function setClientId() {}
export function clearClientId() {}
export function isConfigured() { return true; }
export function isConnected() { return true; }
export function disconnect() {}
export function redirectUri() { return new URL('./', location.href).href; }

/* No OAuth round-trip any more, so these are inert. Kept so any
   existing call site in app.js keeps working untouched. */
export async function beginAuth() {}
export async function handleRedirect() { return null; }

/* ---- Link parsing -------------------------------------------------
   Unchanged from the PKCE version. */

export function parsePlaylistId(input) {
  const s = (input || '').trim();
  let m = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/i);
  if (m) return m[1];
  m = s.match(/open\.spotify\.com\/(?:[A-Za-z-]+\/)?playlist\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

/* ---- Fetch --------------------------------------------------------
   Returns { name, tracks: [{ rawTitle, artists: [] }] } — exactly
   the shape the old fetchPlaylist returned, so the caller is
   unchanged. onProgress fires once: the Worker returns the whole
   playlist in a single response, there are no pages to walk. */

export async function fetchPlaylist(id, onProgress) {
  if (!navigator.onLine) {
    throw new NetworkError('No internet connection — connect to import a playlist.', 'offline');
  }

  let res;
  try {
    res = await fetch(`${PROXY}/?playlist=${encodeURIComponent(id)}`);
  } catch (_) {
    throw new NetworkError('Couldn’t reach the playlist service. Check your signal and try again.', 'fetch');
  }

  const body = await res.json().catch(() => ({}));

  if (res.status === 404) {
    throw new NetworkError(
      'Playlist not found. Make sure the link is public — private playlists can’t be read without signing in.',
      'http'
    );
  }
  if (res.status === 429) {
    throw new NetworkError('Too many requests — wait a moment and try again.', 'http');
  }
  if (!res.ok) {
    throw new NetworkError(body.error || `Playlist service returned HTTP ${res.status}.`, 'http');
  }

  const tracks = (body.tracks || [])
    .filter(t => t && t.title)
    .map(t => ({
      rawTitle: t.title,
      artists: Array.isArray(t.artists) ? t.artists.filter(Boolean) : [],
    }));

  if (!tracks.length) {
    throw new NetworkError('That playlist came back empty. It may be private or region-locked.', 'parse');
  }

  if (onProgress) onProgress(tracks.length, tracks.length);

  return { name: (body.name || '').trim() || 'Spotify playlist', tracks };
}
