/**
 * Storage layer (IndexedDB)
 * ---------------------------------------------
 * Schema:
 *   sets:    { id, name, createdAt, interval, totalFrames, plannedFrames,
 *              cameraLabel, quality, width, height }
 *   frames:  { setId, index, blob }   primary key: [setId, index]
 */

const DB_NAME = 'timelapse-capture';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sets')) {
        const sets = db.createObjectStore('sets', {
          keyPath: 'id',
          autoIncrement: true,
        });
        sets.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('frames')) {
        const frames = db.createObjectStore('frames', {
          keyPath: ['setId', 'index'],
        });
        frames.createIndex('setId', 'setId');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => {
    const transaction = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((n) => [n, transaction.objectStore(n)]))
      : transaction.objectStore(storeNames);
    return { transaction, stores };
  });
}

function awaitReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* -------------------- Sets -------------------- */

export async function createSet(meta) {
  const { stores } = await tx('sets', 'readwrite');
  const record = {
    name: meta.name,
    createdAt: Date.now(),
    interval: meta.interval,
    totalFrames: 0,
    plannedFrames: meta.plannedFrames,
    cameraLabel: meta.cameraLabel || 'Unknown camera',
    quality: meta.quality,
    width: meta.width,
    height: meta.height,
  };
  const id = await awaitReq(stores.add(record));
  return { id, ...record };
}

export async function listSets() {
  const { stores } = await tx('sets');
  const all = await awaitReq(stores.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSet(id) {
  const { stores } = await tx('sets');
  return awaitReq(stores.get(id));
}

export async function updateSet(id, patch) {
  const { stores } = await tx('sets', 'readwrite');
  const existing = await awaitReq(stores.get(id));
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await awaitReq(stores.put(updated));
  return updated;
}

export async function deleteSet(id) {
  // Delete frames first, then the set record. Use a single transaction.
  const { transaction, stores } = await tx(['sets', 'frames'], 'readwrite');
  const framesIdx = stores.frames.index('setId');
  const cursorReq = framesIdx.openCursor(IDBKeyRange.only(id));
  await new Promise((resolve, reject) => {
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
  });
  stores.sets.delete(id);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/* -------------------- Frames -------------------- */

export async function addFrame(setId, index, blob) {
  const { stores } = await tx(['sets', 'frames'], 'readwrite');
  await awaitReq(stores.frames.put({ setId, index, blob }));
  // Bump totalFrames on the set
  const set = await awaitReq(stores.sets.get(setId));
  if (set) {
    set.totalFrames = Math.max(set.totalFrames, index + 1);
    await awaitReq(stores.sets.put(set));
  }
}

export async function getFrame(setId, index) {
  const { stores } = await tx('frames');
  const rec = await awaitReq(stores.get([setId, index]));
  return rec ? rec.blob : null;
}

/**
 * Iterate frames for a set in index order. Returns an array of { index, blob }.
 * For sets up to 500 frames at moderate quality this is fine to load all at once
 * during export; for playback we use getFrame() on demand.
 */
export async function listFrames(setId) {
  const { stores } = await tx('frames');
  const idx = stores.index('setId');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = idx.openCursor(IDBKeyRange.only(setId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ index: cursor.value.index, blob: cursor.value.blob });
        cursor.continue();
      } else {
        out.sort((a, b) => a.index - b.index);
        resolve(out);
      }
    };
  });
}

/* -------------------- Storage estimate -------------------- */

export async function getStorageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) {
    return null;
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
}
