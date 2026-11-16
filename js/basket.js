/* The "basket": files waiting to be merged, kept in IndexedDB so they survive the page
   reloading each time another app shares a file in. Used by both the page and sw.js. */
(function (root) {
  'use strict';
  const DB = 'pdf-creator', STORE = 'basket';
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function run(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  root.Basket = {
    newKey,
    /** files: File[] (or [{file, key}]) → returns the stored records */
    async add(files) {
      const t = Date.now();
      const recs = files.map((f, i) => {
        const file = f.file || f;
        return { key: f.key || newKey(), added: t + i, name: file.name || 'shared-file',
          type: file.type || '', lastModified: file.lastModified || t, blob: file };
      });
      if (recs.length) await run('readwrite', (s) => recs.forEach((r) => s.put(r)));
      return recs;
    },
    all: () => run('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => x.added - y.added)),
    remove: (key) => run('readwrite', (s) => { s.delete(key); }),
    clear: () => run('readwrite', (s) => { s.clear(); }),
  };
})(typeof self !== 'undefined' ? self : window);
