// Almacenamiento estructurado local con IndexedDB (equivalente web a SQLite/Room - Práctica 4).
// Versionado: al agregar campos/índices se sube DB_VERSION y se migra en onupgradeneeded.
const DB_NAME = 'safemotion';
const DB_VERSION = 1;
const STORE = 'measurements';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// DAO de mediciones (CRUD)
export const measurementsDao = {
  insertar: (m) => run('readwrite', (s) => s.add(m)),
  actualizar: (m) => run('readwrite', (s) => s.put(m)),
  eliminar: (id) => run('readwrite', (s) => s.delete(id)),
  // userId: solo las lecturas de ese usuario (en un teléfono compartido cada quien ve las suyas).
  async obtenerTodos(userId = null) {
    const all = await run('readonly', (s) => s.getAll());
    return all.filter((m) => userId == null || String(m.userId) === String(userId)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  },
  async obtenerPendientes(userId = null) {
    return (await this.obtenerTodos(userId)).filter((m) => !m.synced && !m.error);   // las rechazadas no se reintentan
  }
};
