// Private records live only in this origin's IndexedDB. There is no server or
// localStorage fallback: a failed write must be visible to the person using it.
export function createBrowserStore({ indexedDB = globalThis.indexedDB, name = '123-reputation-private-v1' } = {}) {
  let opening;
  const failure = () => new Error('Browser storage is unavailable or full. Allow site storage in this browser and try again. Nothing was saved to our server.');
  async function database() {
    if (!indexedDB) throw failure();
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
      request.onerror = () => { opening = null; reject(failure()); };
      request.onblocked = () => { opening = null; reject(new Error('Close other tabs for this toolkit, then try again.')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    return opening;
  }
  async function transaction(mode, work) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let result, thrown;
      const tx = db.transaction('records', mode), records = tx.objectStore('records');
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(thrown || failure());
      try { work(records, value => { result = value; }, error => { thrown = error; tx.abort(); }); }
      catch (error) { thrown = error; tx.abort(); }
    });
  }
  const key = (kind, id) => `${kind}:${id}`;
  return {
    get: (kind, id) => transaction('readonly', (records, done) => {
      const request = records.get(key(kind, id));
      request.onsuccess = () => done(request.result?.value);
    }),
    put: (kind, id, value) => transaction('readwrite', (records, done) => {
      records.put({ key: key(kind, id), kind, value }); done(value);
    }),
    update: (kind, id, mutate) => transaction('readwrite', (records, done, fail) => {
      const request = records.get(key(kind, id));
      request.onsuccess = () => {
        if (!request.result) { done(undefined); return; }
        try {
          const value = mutate(request.result.value);
          if (value?.then) throw new Error('Storage updates must be synchronous.');
          records.put({ ...request.result, value }); done(value);
        } catch (error) { fail(error); }
      };
    }),
    remove: (kind, id) => transaction('readwrite', records => { records.delete(key(kind, id)); }),
    list: (kind) => transaction('readonly', (records, done) => {
      const request = records.getAll();
      request.onsuccess = () => done(request.result.filter(row => !kind || row.kind === kind).map(row => ({ kind: row.kind, ...row.value })));
    }),
    clear: () => transaction('readwrite', records => { records.clear(); }),
  };
}
