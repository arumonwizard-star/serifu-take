// IndexedDB 保存
const DB = 'serifu-take';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'env', 'asr', 'thumb', 'handles']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const put = (store, key, val) => tx(store, 'readwrite', s => s.put(val, key));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const clear = (store) => tx(store, 'readwrite', s => s.clear());
export const keys = (store) => tx(store, 'readonly', s => s.getAllKeys());
