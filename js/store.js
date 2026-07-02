/* ============================================================
   store.js — durable persistence.

   Everything must survive an app restart / browser close, so we
   use IndexedDB (not just in-memory). Two object stores:

     - "state"  : a single record { key: "app", data: AppState }
     - "images" : cover-art blobs keyed by a generated image id.

   Cover images fetched from iTunes or uploaded by the user are
   copied into the "images" store as Blobs so the app works fully
   offline once artwork has been fetched once. Album.coverImageUri
   holds the image id (a plain string) or null; it is resolved to a
   live object URL at render time (see imageUrl()).
   ============================================================ */

const DB_NAME = 'brera-stacker';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images'); // keyed explicitly by imageId
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------- AppState ---------- */

const DEFAULT_STATE = () => ({
  stacker: Array(10).fill(null), // index 0-9 -> Slot 1-10; null = empty slot
  dash: null,
  spares: [],
});

export async function loadState() {
  try {
    const rec = await tx('state', 'readonly', s => reqAsPromise(s.get('app')));
    if (rec && rec.data) {
      // defensively normalise shape
      const d = rec.data;
      if (!Array.isArray(d.stacker)) d.stacker = Array(10).fill(null);
      while (d.stacker.length < 10) d.stacker.push(null);
      d.stacker.length = 10;
      if (!Array.isArray(d.spares)) d.spares = [];
      if (d.dash === undefined) d.dash = null;
      return d;
    }
  } catch (e) {
    console.warn('loadState failed', e);
  }
  return DEFAULT_STATE();
}

export async function saveState(state) {
  await tx('state', 'readwrite', s => s.put({ key: 'app', data: state }));
}

/* ---------- Images ---------- */

const _urlCache = new Map(); // imageId -> object URL

export async function putImage(imageId, blob) {
  await tx('images', 'readwrite', s => s.put(blob, imageId));
  // invalidate any cached URL for this id
  if (_urlCache.has(imageId)) {
    URL.revokeObjectURL(_urlCache.get(imageId));
    _urlCache.delete(imageId);
  }
}

export async function getImageBlob(imageId) {
  return tx('images', 'readonly', s => reqAsPromise(s.get(imageId)));
}

export async function deleteImage(imageId) {
  if (!imageId) return;
  await tx('images', 'readwrite', s => s.delete(imageId));
  if (_urlCache.has(imageId)) {
    URL.revokeObjectURL(_urlCache.get(imageId));
    _urlCache.delete(imageId);
  }
}

/** Resolve an imageId to a live object URL (cached). Returns null if missing. */
export async function imageUrl(imageId) {
  if (!imageId) return null;
  if (_urlCache.has(imageId)) return _urlCache.get(imageId);
  const blob = await getImageBlob(imageId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _urlCache.set(imageId, url);
  return url;
}
