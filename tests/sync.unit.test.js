// Evaluación de pruebas · Fase 2: pruebas unitarias de la sincronización de mediciones (src/services/sync.js).
// La unidad es la lógica de enviarPendientes(); IndexedDB (measurementsDao) y el servidor (api.enviarMedicion)
// se reemplazan con dobles de prueba (mock.method de node:test), así no hay base de datos, red ni navegador.
// Ejecutar: npm run test:sync
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Entorno de navegador mínimo: la sesión vive en localStorage y expireSession() cambia location.hash.
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.location = { hash: '' };

const { enviarPendientes } = await import('../src/services/sync.js');
const { measurementsDao } = await import('../src/services/db.js');
const { api, ApiError } = await import('../src/services/api.js');
const { createMeasurement } = await import('../src/models/measurement.js');

const JUAN = { id: 2, nombre: 'Juan Pérez', rol: 'usuario' };
const iniciarSesion = (user = JUAN) => localStorage.setItem('sm_session', JSON.stringify({ token: `tok-${user.id}`, user, expiresAt: Date.now() + 3600_000 }));
const lectura = (heartRate = 80, userId = 2) => createMeasurement({
  userId, wearable: { heartRate, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 }, gyroscope: { x: 0.1, y: -0.2, z: 0.3 }, activity: 'caminando'
});

// Dobles: la cola pendiente es un arreglo en memoria; el servidor responde con un id consecutivo.
let cola, dao, servidor;
beforeEach(() => {
  iniciarSesion();
  location.hash = '';
  cola = [];
  dao = {
    obtenerPendientes: mock.method(measurementsDao, 'obtenerPendientes', async () => cola),
    actualizar: mock.method(measurementsDao, 'actualizar', async () => {})
  };
  let n = 0;
  servidor = mock.method(api, 'enviarMedicion', async (req) => ({ id: ++n, ...req }));
});
afterEach(() => { mock.restoreAll(); localStorage.clear(); });

const actualizadas = () => dao.actualizar.mock.calls.map((c) => c.arguments[0]);

test('U-01 válido: dos lecturas pendientes se envían con el token de la sesión y se marcan Enviadas', async () => {
  cola = [lectura(80), lectura(95)];
  const r = await enviarPendientes();
  assert.deepEqual(r, { total: 2, enviadas: 2, rechazadas: 0 });
  assert.equal(servidor.mock.callCount(), 2);
  const [req, token] = servidor.mock.calls[0].arguments;
  assert.equal(token, 'tok-2');
  assert.equal(req.frecuenciaCardiaca, 80);                          // se envía como MedicionRequest
  assert.equal(req.actividad, 'caminando');
  assert.deepEqual(actualizadas().map((m) => [m.id, m.synced, m.serverId]), [[cola[0].id, true, 1], [cola[1].id, true, 2]]);
});

test('U-02 límite: con la cola vacía no se llama al servidor ni se modifica la base local', async () => {
  assert.deepEqual(await enviarPendientes(), { total: 0, enviadas: 0, rechazadas: 0 });
  assert.equal(servidor.mock.callCount(), 0);
  assert.equal(dao.actualizar.mock.callCount(), 0);
});

test('U-03 límite: FC 30 y 220 se envían; FC 221 se rechaza localmente sin llamar al servidor', async () => {
  cola = [lectura(30), lectura(220), lectura(221)];
  assert.deepEqual(await enviarPendientes(), { total: 3, enviadas: 2, rechazadas: 1 });
  assert.deepEqual(servidor.mock.calls.map((c) => c.arguments[0].frecuenciaCardiaca), [30, 220]);
  const rechazada = actualizadas().find((m) => m.id === cola[2].id);
  assert.equal(rechazada.synced, false);
  assert.equal(rechazada.error, 'frecuenciaCardiaca fuera de rango (30-220)');
});

test('U-04 inválido: sin sesión activa la sincronización se rechaza y no consulta la cola', async () => {
  localStorage.clear();
  await assert.rejects(enviarPendientes(), { message: 'Sin sesión' });
  assert.equal(dao.obtenerPendientes.mock.callCount(), 0);
  assert.equal(servidor.mock.callCount(), 0);
});

test('U-05 error: un 400 del servidor marca esa lectura como Rechazada y continúa con las demás', async () => {
  cola = [lectura(80), lectura(90)];
  servidor.mock.mockImplementationOnce(async () => { throw new ApiError('HTTP 400', 400); });
  assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 1, rechazadas: 1 });
  const [primera, segunda] = actualizadas();
  assert.equal(primera.error, 'Rechazada por el servidor (400)');
  assert.equal(segunda.synced, true);
});

// Práctica 12: la sincronización envía hasta 4 lecturas en paralelo (sync.CONCURRENCIA). Con 3 pendientes las tres
// salen a la vez, así que el contrato ya no es "la tercera no se intenta" sino: el error se propaga, la lectura que
// falló queda Pendiente y solo se marcan como enviadas las que el servidor sí confirmó.
test('U-06 error: sin conexión a mitad de la cola se propaga y lo no enviado queda Pendiente', async () => {
  cola = [lectura(80), lectura(90), lectura(100)];
  servidor.mock.mockImplementationOnce(async () => { throw new ApiError('Sin conexión con el servidor', 0); }, 1);
  await assert.rejects(enviarPendientes(), { status: 0, message: 'Sin conexión con el servidor' });
  assert.ok(servidor.mock.callCount() <= 3);
  const marcadas = actualizadas();
  assert.ok(!marcadas.some((m) => m.id === cola[1].id));           // la que falló no cambia de estado
  assert.ok(marcadas.every((m) => m.synced === true));              // ninguna se marca con error ni en falso
});

test('U-07 error: un 401 cierra la sesión local, redirige a Login y no marca ninguna lectura', async () => {
  cola = [lectura(80)];
  servidor.mock.mockImplementation(async () => { throw new ApiError('HTTP 401', 401); });
  await assert.rejects(enviarPendientes(), { status: 401 });
  assert.equal(localStorage.getItem('sm_session'), null);
  assert.equal(location.hash, '/login');
  assert.equal(dao.actualizar.mock.callCount(), 0);
});

test('U-08 concurrencia: dos llamadas simultáneas comparten la misma sincronización (sin envíos dobles)', async () => {
  cola = [lectura(80), lectura(90)];
  const [a, b] = await Promise.all([enviarPendientes(), enviarPendientes()]);
  assert.equal(a, b);
  assert.equal(servidor.mock.callCount(), 2);
});

test('U-09 [D-01, corregido] una lectura de otro usuario en la cola no se envía con el token de la sesión actual', async () => {
  cola = [lectura(80, 2), lectura(85, 4)];                            // la segunda la capturó María (id 4) en el mismo teléfono
  await enviarPendientes();
  const enviadas = servidor.mock.calls.map((c) => c.arguments[0].frecuenciaCardiaca);
  assert.deepEqual(enviadas, [80], `se enviaron con el token de Juan las FC ${enviadas.join(', ')}`);
});
