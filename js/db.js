/**
 * Tiny IndexedDB layer — offline audio, parsed ID3 (cover + lyrics).
 * Two stores, keyed by Drive file id.
 */

const DB_NAME = 'niji-voice';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('parsed')) db.createObjectStore('parsed');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function get(store, key) {
  return tx(store, 'readonly', (os) => {
    const r = os.get(key);
    return { __req: r };
  });
}

export function put(store, key, value) {
  return tx(store, 'readwrite', (os) => { os.put(value, key); return true; });
}

export function del(store, key) {
  return tx(store, 'readwrite', (os) => { os.delete(key); return true; });
}

export function keys(store) {
  return tx(store, 'readonly', (os) => {
    const r = os.getAllKeys();
    return { __req: r };
  });
}

export function all(store) {
  return tx(store, 'readonly', (os) => {
    const r = os.getAll();
    return { __req: r };
  });
}

export function clear(store) {
  return tx(store, 'readwrite', (os) => { os.clear(); return true; });
}

export function count(store) {
  return tx(store, 'readonly', (os) => {
    const r = os.count();
    return { __req: r };
  });
}

/** Approximate bytes used by the audio store. */
export async function audioUsage() {
  const rows = await all('audio');
  let bytes = 0;
  for (const r of rows) {
    bytes += r.blob?.size || r.size || 0;
  }
  return { count: rows.length, bytes };
}
