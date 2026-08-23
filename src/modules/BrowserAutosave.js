export const BROWSER_AUTOSAVE_FILE_ID = 'active-drawing';
export const BROWSER_AUTOSAVE_DATABASE = 'paramagic-browser-files';
export const BROWSER_AUTOSAVE_STORE = 'files';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || new Error('Browser file request failed.'));
  });
}

function openBrowserFileDatabase(indexedDb, databaseName) {
  if (!indexedDb?.open) return Promise.reject(new Error('Browser autosave is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BROWSER_AUTOSAVE_STORE)) {
        request.result.createObjectStore(BROWSER_AUTOSAVE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Browser autosave could not be opened.'));
  });
}

export function normalizeBrowserAutosaveFile(file = {}) {
  return {
    id: BROWSER_AUTOSAVE_FILE_ID,
    name: String(file.name || 'Untitled Drawing'),
    content: String(file.content || ''),
    mimeType: String(file.mimeType || 'application/vnd.paramagic+json'),
    fileHandle: file.fileHandle?.kind === 'file' ? file.fileHandle : null,
    updatedAt: Number.isFinite(Number(file.updatedAt)) ? Number(file.updatedAt) : Date.now(),
  };
}

export function createIndexedDbBrowserFileStore({
  indexedDb = globalThis.indexedDB,
  databaseName = BROWSER_AUTOSAVE_DATABASE,
} = {}) {
  let databasePromise = null;
  const database = () => {
    databasePromise ||= openBrowserFileDatabase(indexedDb, databaseName);
    return databasePromise;
  };

  return {
    async load() {
      const db = await database();
      const transaction = db.transaction(BROWSER_AUTOSAVE_STORE, 'readonly');
      return requestResult(transaction.objectStore(BROWSER_AUTOSAVE_STORE).get(BROWSER_AUTOSAVE_FILE_ID));
    },
    async save(file) {
      const db = await database();
      const transaction = db.transaction(BROWSER_AUTOSAVE_STORE, 'readwrite');
      const normalized = normalizeBrowserAutosaveFile(file);
      await requestResult(transaction.objectStore(BROWSER_AUTOSAVE_STORE).put(normalized));
      return normalized;
    },
  };
}

export function createBrowserAutosaveController({
  store,
  capture,
  delay = 400,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!store?.load || !store?.save) throw new Error('A browser file store is required.');
  if (typeof capture !== 'function') throw new Error('A browser autosave capture function is required.');
  let timer = null;
  let saveQueue = Promise.resolve();

  const saveNow = () => {
    if (timer) clearTimer(timer);
    timer = null;
    const file = normalizeBrowserAutosaveFile(capture());
    const queued = saveQueue.catch(() => null).then(() => store.save(file));
    saveQueue = queued.catch((error) => {
      onError(error);
      return null;
    });
    return saveQueue;
  };

  const schedule = () => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      saveNow();
    }, delay);
  };

  return {
    load: () => store.load(),
    saveNow,
    schedule,
    flush() {
      if (!timer) return saveQueue;
      return saveNow();
    },
    destroy() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
