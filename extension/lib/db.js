// IndexedDB wrapper shared by the service worker, the offscreen document and
// the proving workers (all run on the extension's origin, so they share it).
//
// Large binary data never travels through chrome.runtime messages (which
// JSON-serialize everything): it is written here and only keys are messaged.

const DB_NAME = 'neptune-light';
const DB_VERSION = 1;

export const STORES = {
  kv: 'kv',               // settings, vault, activity (small values)
  snapshots: 'snapshots', // height -> { height, iv, data } encrypted wallet state
  sends: 'sends',         // id -> send record (prepared send is encrypted)
  jobs: 'jobs',           // `${sendId}:${i}` -> { iv, data } encrypted proof job
  proofs: 'proofs',       // `${sendId}:${i}` -> Uint8Array proof (public data)
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => {
          result = r;
        });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => req(s.get(key)));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => req(s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key)));
export const keys = (store) => tx(store, 'readonly', (s) => req(s.getAllKeys()));
export const clear = (store) => tx(store, 'readwrite', (s) => req(s.clear()));

/** Write several entries in one transaction: all of them, or none. */
export const putMany = (store, entries) =>
  tx(store, 'readwrite', (s) => Promise.all(entries.map(([k, v]) => req(s.put(v, k)))));

/** Delete every key in `store` that starts with `prefix`. */
export async function delPrefix(store, prefix) {
  const all = await keys(store);
  await Promise.all(all.filter((k) => String(k).startsWith(prefix)).map((k) => del(store, k)));
}

/** Wipe everything except `kv` keys starting with one of `keepPrefixes`. */
export async function wipeExcept(keepPrefixes) {
  await Promise.all(Object.values(STORES).filter((s) => s !== STORES.kv).map((s) => clear(s)));
  const all = await keys(STORES.kv);
  const drop = all.filter((k) => !keepPrefixes.some((p) => String(k).startsWith(p)));
  await tx(STORES.kv, 'readwrite', (s) => Promise.all(drop.map((k) => req(s.delete(k)))));
}

/** Wipe everything (wallet reset). */
export async function wipe() {
  await Promise.all(Object.values(STORES).map((s) => clear(s)));
}
