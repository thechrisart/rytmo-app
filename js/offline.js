// Músicas baixadas no aparelho (modo offline).
// Os arquivos ficam no IndexedDB deste aparelho (app de Mac, iPhone/iPad ou navegador) e tocam
// sem internet. Também guarda a última biblioteca carregada, para o app abrir offline.
// Nada disso vai para o Drive: baixar e remover daqui não mexe nos arquivos originais.

let DB_NAME = 'rytmo-offline';
const TRACKS = 'tracks'; // trackId -> { blob, size, savedAt }
const META = 'meta'; // 'library' -> library.json da última vez que carregou

let dbPromise = null;
const ids = new Map(); // trackId -> tamanho em bytes (para saber o que está baixado sem abrir o banco)
const urls = new Map(); // trackId -> objectURL do blob salvo
const listeners = new Set();

function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(TRACKS);
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Sem espaço no aparelho'));
  });
}

const changed = () => listeners.forEach((fn) => fn());

// Banco separado (ex.: modo demo), chamado antes de qualquer outra função.
export function configure(suffix) {
  DB_NAME = `rytmo-offline-${suffix}`;
}

// Carrega a lista do que já está baixado. Chamar uma vez ao abrir o app.
export async function init() {
  try {
    await tx(TRACKS, 'readonly', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        ids.set(c.key, c.value.size || 0);
        c.continue();
      };
    });
  } catch (e) {
    console.warn('Offline indisponível', e);
  }
}

export const onChange = (fn) => listeners.add(fn);
export const has = (trackId) => ids.has(trackId);
export const count = () => ids.size;
export const totalSize = () => [...ids.values()].reduce((s, n) => s + n, 0);
export const downloadedIds = () => [...ids.keys()];

export async function save(trackId, blob) {
  await tx(TRACKS, 'readwrite', (s) => s.put({ blob, size: blob.size, savedAt: Date.now() }, trackId));
  ids.set(trackId, blob.size);
  // Pede ao navegador para não apagar estes arquivos quando faltar espaço.
  navigator.storage?.persist?.().catch(() => {});
  changed();
}

export async function remove(trackIds) {
  const list = [].concat(trackIds);
  await tx(TRACKS, 'readwrite', (s) => list.forEach((id) => s.delete(id)));
  for (const id of list) {
    ids.delete(id);
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.delete(id);
  }
  changed();
}

// URL para tocar a música baixada, ou null se ela não estiver no aparelho.
export async function url(trackId) {
  if (!ids.has(trackId)) return null;
  if (urls.has(trackId)) return urls.get(trackId);
  const rec = await tx(TRACKS, 'readonly', (s) => s.get(trackId));
  if (!rec?.blob) {
    ids.delete(trackId);
    return null;
  }
  const u = URL.createObjectURL(rec.blob);
  urls.set(trackId, u);
  return u;
}

export async function saveLibrary(library, key = 'library') {
  try { await tx(META, 'readwrite', (s) => s.put(library, key)); } catch {}
}

export async function loadLibrary(key = 'library') {
  try { return (await tx(META, 'readonly', (s) => s.get(key))) || null; } catch { return null; }
}

export function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}
