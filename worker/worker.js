/**
 * Brera Stacker — Spotify playlist metadata proxy
 *
 * Deploy to Cloudflare Workers. Fetches the public Spotify embed page
 * server-side (no CORS restriction there) and returns clean JSON:
 *
 *   GET /?playlist=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 *   GET /?playlist=37i9dQZF1DXcBWIGoYBM5M
 *
 *   -> { id, name, trackCount, tracks: [ { title, artists, durationMs } ] }
 *
 * No Spotify account, client ID, secret, or login involved.
 * Reads PUBLIC playlists only — a private playlist returns 404.
 */

// Only these origins may call the worker. Add localhost while developing.
const ALLOWED_ORIGINS = new Set([
  'https://harryk03.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Use GET' }, 405, cors);
    }

    const url = new URL(request.url);
    const raw = url.searchParams.get('playlist');
    if (!raw) {
      return json({ error: 'Missing ?playlist= parameter' }, 400, cors);
    }

    const id = extractPlaylistId(raw);
    if (!id) {
      return json({ error: 'Could not parse a playlist ID from: ' + raw }, 400, cors);
    }

    // Serve from Cloudflare's edge cache when we can — playlists change rarely.
    const cacheKey = new Request('https://brera-cache/playlist/' + id, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    let html;
    try {
      const upstream = await fetch('https://open.spotify.com/embed/playlist/' + id, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!upstream.ok) {
        return json(
          { error: 'Spotify returned ' + upstream.status + ' for that playlist. It may be private or deleted.', id },
          upstream.status === 404 ? 404 : 502,
          cors
        );
      }
      html = await upstream.text();
    } catch (e) {
      return json({ error: 'Upstream fetch failed: ' + String(e) }, 502, cors);
    }

    const parsed = parseEmbed(html);
    if (!parsed || !parsed.tracks.length) {
      return json(
        {
          error:
            'No tracks found. The playlist is probably private, or Spotify changed the embed markup. ' +
            'Re-run with &debug=1 to inspect.',
          id,
          debug: url.searchParams.get('debug') ? html.slice(0, 4000) : undefined,
        },
        404,
        cors
      );
    }

    const payload = { id, ...parsed };
    const body = JSON.stringify(payload);

    const cacheable = new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
    await cache.put(cacheKey, cacheable.clone());

    return new Response(body, {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://harryk03.github.io';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...extra, 'Content-Type': 'application/json' },
  });
}

/** Accepts a full URL, a spotify: URI, or a bare 22-char base62 ID. */
function extractPlaylistId(input) {
  const s = String(input).trim();
  let m = s.match(/playlist[/:]([A-Za-z0-9]{22})/);
  if (m) return m[1];
  m = s.match(/^([A-Za-z0-9]{22})$/);
  if (m) return m[1];
  return null;
}

/**
 * Spotify server-renders the embed with a JSON blob in a <script> tag.
 * Rather than hard-coding a key path (which Spotify changes), we walk the
 * parsed JSON looking for the first array of track-shaped objects.
 */
function parseEmbed(html) {
  for (const blob of extractJsonScripts(html)) {
    let data;
    try {
      data = JSON.parse(blob);
    } catch {
      continue;
    }
    const tracks = findTrackList(data);
    if (tracks && tracks.length) {
      return {
        name: findPlaylistName(data) || 'Spotify playlist',
        trackCount: tracks.length,
        tracks,
      };
    }
  }
  return null;
}

function* extractJsonScripts(html) {
  const re = /<script[^>]*type=["']application\/json["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    if (end === -1) continue;
    yield html.slice(start, end);
  }
}

/** Depth-first search for an array whose members look like tracks. */
function findTrackList(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;

  if (Array.isArray(node)) {
    if (node.length && node.every(isTrackShaped)) {
      return node.map(normaliseTrack);
    }
    for (const child of node) {
      const found = findTrackList(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Prefer obvious keys first, then fall back to a full walk.
  for (const key of ['trackList', 'tracks', 'items', 'entity', 'data']) {
    if (key in node) {
      const found = findTrackList(node[key], depth + 1);
      if (found) return found;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (['trackList', 'tracks', 'items', 'entity', 'data'].includes(k)) continue;
    const found = findTrackList(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function isTrackShaped(o) {
  return (
    o &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    typeof o.title === 'string' &&
    o.title.length > 0 &&
    ('subtitle' in o || 'artists' in o)
  );
}

function normaliseTrack(o) {
  let artists = [];
  if (Array.isArray(o.artists)) {
    artists = o.artists.map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
  } else if (typeof o.subtitle === 'string' && o.subtitle) {
    // Embed markup joins artists with ", " in a single subtitle string.
    artists = o.subtitle.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return {
    title: o.title,
    artists,
    durationMs: typeof o.duration === 'number' ? o.duration : null,
  };
}

function findPlaylistName(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (!Array.isArray(node)) {
    // The playlist entity carries a name/title alongside its trackList.
    if (Array.isArray(node.trackList) && typeof node.name === 'string') return node.name;
    if (Array.isArray(node.trackList) && typeof node.title === 'string') return node.title;
  }
  const kids = Array.isArray(node) ? node : Object.values(node);
  for (const child of kids) {
    const found = findPlaylistName(child, depth + 1);
    if (found) return found;
  }
  return null;
}
