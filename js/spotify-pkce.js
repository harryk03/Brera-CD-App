/* ============================================================
   spotify.js — Spotify Web API, metadata only.

   Reads a playlist's track list (title + artists) through the
   official Web API so a whole playlist can be turned into a burnt
   disc without typing every song. Nothing here touches audio:
   only the Get Playlist / Get Playlist Items endpoints are used.

   Auth is the Authorization Code + PKCE flow. This app has no
   backend, so the Client-Credentials flow (which needs the client
   SECRET) can't be used safely — the secret would ship in public
   JavaScript, which Spotify's terms forbid. PKCE needs only the
   public Client ID: the user signs in to Spotify once, and the
   refresh token keeps it working silently after that.

   Setup (one-time, no code changes): create a free app at
   developer.spotify.com, paste its Client ID into the app, and
   register the Redirect URI the app shows you.
   ============================================================ */

import { NetworkError } from './itunes.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

/* Optional: hardcode a Client ID here instead of entering it in-app.
   The Client ID is public by design (PKCE), so committing it is fine. */
const CLIENT_ID_FALLBACK = '';

/* Reading private/collaborative playlists you own needs these scopes;
   public playlists need none. Requesting them lets both kinds import. */
const SCOPES = 'playlist-read-private playlist-read-collaborative';

const LS = {
  clientId: 'brera.spotify.clientId',
  tokens:   'brera.spotify.tokens',
  verifier: 'brera.spotify.verifier',
  pending:  'brera.spotify.pendingLink',
};

const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (_) {} };

/* ---------- configuration ---------- */

export function getClientId() {
  return (lsGet(LS.clientId) || CLIENT_ID_FALLBACK).trim();
}
export function setClientId(id) { lsSet(LS.clientId, (id || '').trim()); }
export function clearClientId() { lsDel(LS.clientId); disconnect(); }
export function isConfigured() { return getClientId().length > 0; }

/** The URI Spotify sends the user back to — must be registered verbatim
 *  in the developer dashboard. Always the app's directory URL, so it is
 *  the same whether the app was opened via "/" or "/index.html". */
export function redirectUri() {
  return new URL('./', location.href).href;
}

/* ---------- tokens ---------- */

function loadTokens() {
  try { return JSON.parse(lsGet(LS.tokens) || 'null'); } catch (_) { return null; }
}
function saveTokens(t) { lsSet(LS.tokens, JSON.stringify(t)); }

export function isConnected() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}
export function disconnect() { lsDel(LS.tokens); }

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch (_) {
    throw new NetworkError('Couldn’t reach Spotify. Check your signal and try again.', 'fetch');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = json.error_description || json.error || `HTTP ${res.status}`;
    throw new NetworkError(`Spotify sign-in failed: ${why}.`, 'http');
  }
  const prev = loadTokens() || {};
  return {
    access_token: json.access_token,
    // A refresh response may omit the refresh token; keep the old one.
    refresh_token: json.refresh_token || prev.refresh_token || null,
    // Refresh a minute early so a request never races the expiry.
    expires_at: Date.now() + ((json.expires_in || 3600) * 1000) - 60_000,
  };
}

async function accessToken() {
  const t = loadTokens();
  if (!t || !t.refresh_token) throw new NetworkError('Connect Spotify first.', 'auth');
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  try {
    const fresh = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: getClientId(),
    });
    saveTokens(fresh);
    return fresh.access_token;
  } catch (_) {
    disconnect();
    throw new NetworkError('Your Spotify session expired — import again to reconnect.', 'auth');
  }
}

/* ---------- PKCE sign-in ---------- */

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Send the user to Spotify to sign in. `pendingLink` (the playlist they
 *  pasted) is remembered so the import resumes automatically on return. */
export async function beginAuth(pendingLink) {
  if (!isConfigured()) throw new NetworkError('Add your Spotify Client ID first.', 'auth');
  const verifier = randomString(64);
  lsSet(LS.verifier, verifier);
  if (pendingLink) lsSet(LS.pending, pendingLink); else lsDel(LS.pending);
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
    scope: SCOPES,
  });
  location.assign(`${ACCOUNTS}/authorize?${params}`);
}

/** Call once on boot. If the page was opened by Spotify's redirect, this
 *  exchanges the code for tokens and cleans the URL. Returns null when the
 *  page load is not a redirect; otherwise { connected, pendingLink, error }. */
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (!code && !err) return null;

  const verifier = lsGet(LS.verifier);
  const pendingLink = lsGet(LS.pending) || null;
  lsDel(LS.verifier);
  lsDel(LS.pending);

  // Strip the one-shot params so a refresh can't replay the exchange.
  ['code', 'error', 'state'].forEach(k => url.searchParams.delete(k));
  history.replaceState(null, '', url.pathname + url.search + url.hash);

  if (err) {
    const msg = err === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed (${err}).`;
    return { connected: false, pendingLink, error: msg };
  }
  if (!verifier) {
    return { connected: false, pendingLink, error: 'Spotify sign-in session expired — try the import again.' };
  }
  try {
    saveTokens(await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: getClientId(), code_verifier: verifier,
    }));
    return { connected: true, pendingLink, error: null };
  } catch (e) {
    return { connected: false, pendingLink, error: e.message };
  }
}

/* ---------- API ---------- */

async function apiGet(path) {
  if (!navigator.onLine) {
    throw new NetworkError('No internet connection — connect to import a playlist.', 'offline');
  }
  const token = await accessToken();
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (_) {
    throw new NetworkError('Couldn’t reach Spotify. Check your signal and try again.', 'fetch');
  }
  if (res.status === 401) {
    disconnect();
    throw new NetworkError('Your Spotify session expired — import again to reconnect.', 'auth');
  }
  if (res.status === 403) {
    throw new NetworkError('Spotify refused access. If your Spotify app is in Development Mode, add this Spotify account under “User Management” in the developer dashboard.', 'http');
  }
  if (res.status === 404) {
    throw new NetworkError('Playlist not found. Check the link and make sure it’s public (or one you own). Playlists made by Spotify itself can’t be read by third-party apps.', 'http');
  }
  if (res.status === 429) {
    throw new NetworkError('Spotify is rate-limiting requests — wait a moment and try again.', 'http');
  }
  if (!res.ok) throw new NetworkError(`Spotify returned HTTP ${res.status}. Try again in a moment.`, 'http');
  try { return await res.json(); }
  catch (_) { throw new NetworkError('Spotify sent back an unreadable response. Try again.', 'parse'); }
}

/** Accepts a share link (open.spotify.com/playlist/…, with or without a
 *  locale segment or ?si= suffix), a spotify:playlist: URI, or a bare id. */
export function parsePlaylistId(input) {
  const s = (input || '').trim();
  let m = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/i);
  if (m) return m[1];
  m = s.match(/open\.spotify\.com\/(?:[A-Za-z-]+\/)?playlist\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

/** Full ordered track list: { name, tracks: [{ rawTitle, artists: [] }] }.
 *  Pages through the playlist 100 items at a time; `onProgress(done, total)`
 *  is called after each page so the UI can show a count. */
export async function fetchPlaylist(id, onProgress) {
  const meta = await apiGet(`/playlists/${encodeURIComponent(id)}?fields=name,tracks.total`);
  const total = (meta.tracks && meta.tracks.total) || 0;
  const tracks = [];
  let offset = 0;
  for (;;) {
    const page = await apiGet(
      `/playlists/${encodeURIComponent(id)}/tracks?limit=100&offset=${offset}` +
      `&fields=next,items(track(name,type,artists(name)))`
    );
    const items = page.items || [];
    for (const it of items) {
      const t = it && it.track;
      // Null = removed/unavailable; non-"track" = podcast episode. Skip both.
      if (!t || t.type !== 'track' || !t.name) continue;
      tracks.push({ rawTitle: t.name, artists: (t.artists || []).map(a => a.name).filter(Boolean) });
    }
    offset += items.length;
    if (onProgress) onProgress(Math.min(offset, total || offset), total || offset);
    if (!page.next || items.length === 0) break;
  }
  return { name: (meta.name || '').trim() || 'Spotify playlist', tracks };
}
