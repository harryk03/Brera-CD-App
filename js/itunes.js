/* ============================================================
   itunes.js — free, no-auth iTunes Search API.

   Endpoints used:
     - album search : /search?entity=album
     - tracklist    : /lookup?id=<collectionId>&entity=song
     - song search  : /search?entity=song

   All calls surface SPECIFIC, useful errors (offline vs. HTTP vs.
   parse) so failures are diagnosable — CDs get added standing at
   the car with poor signal, so a clear "no connection" state
   matters. The background artwork fetch (see app.js) swallows
   these; interactive Add-CD flows show them.
   ============================================================ */

const BASE = 'https://itunes.apple.com';

class NetworkError extends Error {
  constructor(message, kind) { super(message); this.name = 'NetworkError'; this.kind = kind; }
}
export { NetworkError };

async function apiGet(path) {
  if (!navigator.onLine) {
    throw new NetworkError('No internet connection — connect to add or look up CDs.', 'offline');
  }
  let res;
  try {
    res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  } catch (e) {
    // Thrown for DNS/connection failures, CORS on file://, etc.
    throw new NetworkError(
      'Couldn’t reach the iTunes catalogue (network request failed). Check your signal and try again.',
      'fetch'
    );
  }
  if (!res.ok) {
    throw new NetworkError(`iTunes returned HTTP ${res.status}. Try again in a moment.`, 'http');
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new NetworkError('iTunes sent back an unreadable response. Try again.', 'parse');
  }
  return json;
}

/* ---------- feat. parsing ---------- */

const FEAT_RE = /[\(\[]\s*feat(?:uring|\.)?\s+([^\)\]]+?)\s*[\)\]]/i;

/** Split "Song (feat. X)" -> { title: "Song", feat: "X" | null } */
export function parseFeat(rawTitle) {
  if (!rawTitle) return { title: '', feat: null };
  const m = rawTitle.match(FEAT_RE);
  if (m) {
    const feat = m[1].trim();
    const title = rawTitle.replace(FEAT_RE, '').replace(/\s{2,}/g, ' ').trim();
    return { title, feat };
  }
  return { title: rawTitle.trim(), feat: null };
}

/** iTunes artwork comes back at 100x100; request a larger square. */
export function upscaleArtwork(url, size = 600) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)/, `/${size}x${size}bb.$1`);
}

/* ---------- Public queries ---------- */

export async function searchAlbums(term, limit = 24) {
  const q = encodeURIComponent(term.trim());
  const data = await apiGet(`/search?term=${q}&entity=album&limit=${limit}`);
  return (data.results || []).map(r => ({
    collectionId: r.collectionId,
    title: r.collectionName,
    artist: r.artistName,
    artwork: r.artworkUrl100 || null,
    year: r.releaseDate ? r.releaseDate.slice(0, 4) : '',
    trackCount: r.trackCount,
  }));
}

/** Full ordered tracklist for an album by collectionId. */
export async function lookupAlbumTracks(collectionId) {
  const data = await apiGet(`/lookup?id=${collectionId}&entity=song`);
  const results = data.results || [];
  // First result is the collection itself; songs follow.
  const songs = results
    .filter(r => r.wrapperType === 'track' && r.kind === 'song')
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return songs.map(s => ({ rawTitle: s.trackName, artist: s.artistName }));
}

export async function searchSongs(term, limit = 24) {
  const q = encodeURIComponent(term.trim());
  const data = await apiGet(`/search?term=${q}&entity=song&limit=${limit}`);
  return (data.results || []).map(r => ({
    trackId: r.trackId,
    rawTitle: r.trackName,
    artist: r.artistName,
    album: r.collectionName,
    artwork: r.artworkUrl100 || null,
  }));
}

/**
 * Background artwork lookup for an album that has no cover yet.
 * Strips any "(Disc N)" suffix from the query. Returns an upscaled
 * artwork URL or null. Never throws to the caller's UI (caller
 * decides), but does propagate NetworkError so the caller can bail
 * the whole sequential run when offline.
 */
export async function findArtwork(artist, title) {
  const cleanTitle = (title || '').replace(/\(\s*disc\s*\d+\s*\)/i, '').trim();
  const term = [artist, cleanTitle].filter(Boolean).join(' ');
  const q = encodeURIComponent(term);
  const data = await apiGet(`/search?term=${q}&entity=album&limit=1`);
  const first = (data.results || [])[0];
  return first ? upscaleArtwork(first.artworkUrl100, 600) : null;
}

/** Fetch a remote image URL and return it as a Blob for local storage. */
export async function fetchImageBlob(url) {
  if (!navigator.onLine) throw new NetworkError('Offline — cannot download artwork.', 'offline');
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new NetworkError('Couldn’t download the artwork image.', 'fetch');
  }
  if (!res.ok) throw new NetworkError(`Artwork download failed (HTTP ${res.status}).`, 'http');
  return res.blob();
}
