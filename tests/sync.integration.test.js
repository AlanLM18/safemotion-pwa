// Evaluación de pruebas · Fase 3: pruebas de integración de la sincronización con componentes reales, sin mocks de la app:
//   auth.js -> sync.js -> db.js (IndexedDB) -> api.js (fetch real) -> servidor HTTP con el contrato de Spring Boot.
// IndexedDB es fake-indexeddb (implementación completa en memoria = base de datos de pruebas) y el backend es
// tests/support/servidorContrato.js (API de pruebas en 127.0.0.1). Ejecutar: npm run test:sync:int
import 'fake-indexeddb/auto';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorContrato } from './support/servidorContrato.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.location = { hash: '' };

const auth = await import('../src/services/auth.js');
const { api, createApi } = await import('../src/services/api.js');
const { measurementsDao } = await import('../src/services/db.js');
const { enviarPendientes } = await import('../src/services/sync.js');
const { createMeasurement } = await import('../src/models/measurement.js');

const lectura = (heartRate = 80) => createMeasurement({
  userId: 2, wearable: { heartRate, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 }, gyroscope: { x: 0.1, y: -0.2, z: 0.3 }, activity: 'caminando'
});
const guardar = async (...ms) => { for (const m of ms) await measurementsDao.insertar(m); return ms; };
const estados = async () => Object.fromEntries((await measurementsDao.obtenerTodos()).map((m) => [m.id, m]));

let srv;
before(async () => {
  srv = await iniciarServidorContrato();
  // La app usa el cliente HTTP real apuntando al servidor de pruebas (lo que haría VITE_API_URL).
  Object.assign(api, createApi({ baseUrl: srv.url, timeoutMs: 800 }));
});
after(() => srv.cerrar());
beforeEach(async () => {
  for (const m of await measurementsDao.obtenerTodos()) await measurementsDao.eliminar(m.id);
  localStorage.clear(); location.hash = ''; srv.limpiar();
  await auth.login('0000');                                          // login real por HTTP
});

test('I-01 flujo correcto: las lecturas de IndexedDB llegan al servidor y quedan Enviadas con su id del servidor', async () => {
  const [a, b] = await guardar(lectura(80), lectura(95));
  assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 2, rechazadas: 0 });
  const posts = srv.peticiones.filter((p) => p.path === '/api/mediciones');
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.auth === auth.getSession().token), 'cada POST lleva el token de la sesión');
  assert.deepEqual(srv.mediciones.map((m) => m.frecuenciaCardiaca).sort(), [80, 95]);
  const db = await estados();
  assert.equal(db[a.id].synced, true);
  assert.equal(db[b.id].synced, true);
  assert.deepEqual([db[a.id].serverId, db[b.id].serverId].sort(), [1, 2]);
  assert.equal((await enviarPendientes()).total, 0);                 // nada pendiente: no se reenvía
  assert.equal((await api.historial(auth.getSession().token)).length, 2);
});

test('I-02 error: el servidor falla (503) a mitad de la cola; al recuperarse se envía solo lo pendiente', async () => {
  await guardar(lectura(80), lectura(90), lectura(100));
  srv.fallar({}, { status: 503 });                                   // la 1.ª pasa, la 2.ª recibe 503
  await assert.rejects(enviarPendientes(), { status: 503 });
  assert.equal(srv.mediciones.length, 1);
  assert.equal((await measurementsDao.obtenerPendientes()).length, 2);
  assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 2, rechazadas: 0 });
  assert.equal(srv.mediciones.length, 3);                            // sin duplicados
});

test('I-03 error: un 400 real del servidor marca la lectura como Rechazada y no se reintenta', async () => {
  const [a, b] = await guardar(lectura(80), lectura(90));
  srv.fallar({ status: 400 });
  assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 1, rechazadas: 1 });
  const db = await estados();
  const rechazada = [db[a.id], db[b.id]].find((m) => m.error);
  assert.equal(rechazada.error, 'Rechazada por el servidor (400)');
  assert.equal((await enviarPendientes()).total, 0);
});

test('I-04 error: el servidor se reinicia y pierde las sesiones (401): se cierra la sesión y nada se pierde', async () => {
  await guardar(lectura(80));
  srv.reiniciarSesiones();
  await assert.rejects(enviarPendientes(), { status: 401 });
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(location.hash, '/login');
  assert.equal((await measurementsDao.obtenerPendientes()).length, 1);
  await auth.login('0000');
  assert.equal((await enviarPendientes()).enviadas, 1);              // tras volver a entrar se envía
});

test('I-05 error: el servidor no responde; el tiempo de espera corta la petición y la lectura sigue Pendiente', async () => {
  await guardar(lectura(80));
  srv.fallar({ colgar: true });
  const t0 = Date.now();
  await assert.rejects(enviarPendientes(), { status: 0, message: 'Sin conexión con el servidor' });
  assert.ok(Date.now() - t0 < 2000, `tardó ${Date.now() - t0} ms`);
  assert.equal((await measurementsDao.obtenerPendientes()).length, 1);
});

test('I-06 [D-02] si el servidor guarda pero la respuesta se pierde, el reintento no debe duplicar la medición', { todo: 'Defecto D-02 abierto: POST /api/mediciones no es idempotente' }, async () => {
  await guardar(lectura(80));
  srv.fallar({ perderRespuesta: true });                             // guarda y la respuesta nunca llega (timeout)
  await assert.rejects(enviarPendientes(), { status: 0 });
  await enviarPendientes();                                          // reintento automático del monitoreo
  assert.equal(srv.mediciones.length, 1, `el servidor tiene ${srv.mediciones.length} copias de la misma lectura`);
});

// Con API_URL, la misma cadena contra Spring Boot real (perfil h2):
//   API_URL=http://localhost:8080 npm run test:sync:int
const API_URL = process.env.API_URL;
const conSpring = { skip: !API_URL && 'Define API_URL para probar contra Spring Boot' };
async function contraSpring(fn) {
  const contrato = { ...api };
  Object.assign(api, createApi({ baseUrl: API_URL }));
  try { await auth.login('0000'); await fn(); } finally { Object.assign(api, contrato); }
}

test('I-07 Spring Boot real: las lecturas de IndexedDB quedan en el historial del servidor con el mismo id', conSpring, () => contraSpring(async () => {
  const [a, b] = await guardar(lectura(81), lectura(96));
  assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 2, rechazadas: 0 });
  const db = await estados();
  const historial = await api.historial(auth.getSession().token, 50);
  for (const m of [db[a.id], db[b.id]]) {
    const enServidor = historial.find((h) => h.id === m.serverId);
    assert.ok(enServidor, `el id ${m.serverId} no está en el historial de Spring Boot`);
    assert.equal(enServidor.frecuenciaCardiaca, m.wearable.heartRate);
    assert.equal(enServidor.usuario.nombre, 'Juan Pérez');
  }
}));

test('I-08 [D-03] Spring Boot real: una medición sin SpO2 debe rechazarse, no guardarse como 0 %', { ...conSpring, todo: 'Defecto D-03 abierto: MedicionRequest.java usa int primitivo y null se convierte en 0' }, () => contraSpring(async () => {
  const sinSpo2 = { frecuenciaCardiaca: 80, temperatura: 36.6, spo2: null, pasos: 0, calorias: 0, actividad: 'reposo', bateria: 90 };
  let guardada = null;
  try { guardada = await api.enviarMedicion(sinSpo2, auth.getSession().token); } catch (e) { assert.equal(e.status, 400); }
  assert.equal(guardada, null, `Spring Boot la guardó con id ${guardada?.id} y spo2 = ${guardada?.spo2} %`);
}));
