// Crash-recovery copy of the project in IndexedDB. Only a safety net: the .pcam file is the
// real copy (AGENTS.md). Every call fails soft when IndexedDB is unavailable (e.g. file://
// in some browsers, private windows).

const DB = 'pcb-cammotion';
const STORE = 'autosave';
const KEY = 'current';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

/** @param {Uint8Array} bytes a complete .pcam */
export function saveAutosave(bytes) {
  return tx('readwrite', (s) => s.put({ bytes, savedAt: Date.now() }, KEY));
}

/** @returns {Promise<{bytes: Uint8Array, savedAt: number}|undefined>} */
export function loadAutosave() {
  return tx('readonly', (s) => s.get(KEY));
}

export function clearAutosave() {
  return tx('readwrite', (s) => s.delete(KEY));
}
