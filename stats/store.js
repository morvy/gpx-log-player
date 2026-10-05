// The statistics keep every drive in this browser: nothing is uploaded, and
// next week only the new logs need adding.

const NAME = "gpx-log-player";
const STORES = ["files", "summaries", "settings", "inbox", "charges"];

function open(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(NAME, version) : indexedDB.open(NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { autoIncrement: store === "inbox" });
    };
    req.onsuccess = () => {
      // Another tab upgrading the database waits for this one to let go.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * The database with every store in it. A database that exists without them -
 * opened somewhere without a version, which creates an empty version 1 - is
 * reopened one version up so the stores get made, instead of failing forever.
 */
export async function openDb() {
  const db = await open();
  if (STORES.every(store => db.objectStoreNames.contains(store))) return db;
  const next = db.version + 1;
  db.close();
  return open(next);
}

// A failed request aborts its transaction, and only then is the error known.
const failed = tx => new Error(tx.error?.message || "Storing in this browser failed.");

const read = (db, store, work) => new Promise((resolve, reject) => {
  const tx = db.transaction(store, "readonly");
  const req = work(tx.objectStore(store));
  tx.oncomplete = () => resolve(req.result);
  tx.onabort = () => reject(failed(tx));
});

export const getAll = (db, store) => read(db, store, s => s.getAll());
// The inbox is keyed automatically, so emptying it means asking what its keys are.
export const getAllKeys = (db, store) => read(db, store, s => s.getAllKeys());
export const get = (db, store, key) => read(db, store, s => s.get(key));

/**
 * Puts ({ store, key, value }) and deletes ({ store, key }) in one transaction:
 * all of them are stored, or none - a file never ends up without some of its drives.
 */
export const change = (db, ops) => new Promise((resolve, reject) => {
  // A transaction over no store throws; nothing to change is simply done.
  if (!ops.length) return resolve();
  const tx = db.transaction([...new Set(ops.map(op => op.store))], "readwrite");
  for (const op of ops) {
    const store = tx.objectStore(op.store);
    if ("value" in op) store.put(op.value, op.key); else store.delete(op.key);
  }
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(failed(tx));
});
