// Práctica 12 · pruebas unitarias de las optimizaciones de la app:
//   src/services/reintento.js (espera progresiva con jitter) y la sincronización con concurrencia limitada (sync.js).
// Ejecutar: node --test tests/p12.unit.test.js
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = memStorage(); globalThis.sessionStorage = memStorage(); globalThis.location = { hash: '' };

const { esperaBase, crearReintento, esReintentable, BASE_MS, MAX_MS } = await import('../src/services/reintento.js');
const { enviarPendientes, CONCURRENCIA } = await import('../src/services/sync.js');
const { measurementsDao } = await import('../src/services/db.js');
const { api, ApiError } = await import('../src/services/api.js');
const { createMeasurement } = await import('../src/models/measurement.js');

// ---------- reintento ----------
test('P12-R1 espera base: 5, 10, 20 s y tope de 30 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map((n) => esperaBase(n)), [5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(esperaBase(0), 0);
  assert.equal(BASE_MS, 5000); assert.equal(MAX_MS, 30000);
});
test('P12-R2 reintento: no se intenta antes de que pase la espera; el éxito la reinicia', () => {
  let ahora = 0;
  const r = crearReintento({ ahora: () => ahora, aleatorio: () => 0.5 });   // 0.5 = sin variación
  assert.equal(r.puedeIntentar(), true);
  assert.equal(r.registrarFallo(), 5000);
  ahora = 4999; assert.equal(r.puedeIntentar(), false);
  ahora = 5000; assert.equal(r.puedeIntentar(), true);
  assert.equal(r.registrarFallo(), 10000);
  assert.equal(r.fallos, 2);
  r.registrarExito();
  assert.equal(r.fallos, 0); assert.equal(r.puedeIntentar(), true);
});
test('P12-R3 jitter: la espera queda dentro de ±20 % (valores límite del aleatorio 0 y 1)', () => {
  const bajo = crearReintento({ ahora: () => 0, aleatorio: () => 0 });
  const alto = crearReintento({ ahora: () => 0, aleatorio: () => 1 });
  assert.equal(bajo.registrarFallo(), 4000);
  assert.equal(alto.registrarFallo(), 6000);
});
test('P12-R4 qué errores se reintentan: red, 5xx y 429 sí; 400, 401, 403 y 404 no', () => {
  for (const s of [0, 500, 502, 503, 504, 429, undefined]) assert.equal(esReintentable({ status: s }), true, String(s));
  for (const s of [400, 401, 403, 404, 409]) assert.equal(esReintentable({ status: s }), false, String(s));
});

// ---------- sincronización con concurrencia limitada ----------
const USER = { id: 2, nombre: 'Juan Pérez', rol: 'usuario' };
const lectura = (hr = 80) => createMeasurement({ userId: 2, wearable: { heartRate: hr, spo2: 97, temperature: 36.6, steps: 1, calories: 1, battery: 90 }, activity: 'reposo' });
let cola, actualizar;
beforeEach(() => {
  localStorage.setItem('sm_session', JSON.stringify({ token: 'tok', user: USER, expiresAt: Date.now() + 3600_000 }));
  location.hash = '';
  cola = [];
  mock.method(measurementsDao, 'obtenerPendientes', async () => cola);
  actualizar = mock.method(measurementsDao, 'actualizar', async () => {});
});
afterEach(() => { mock.restoreAll(); localStorage.clear(); });

test('P12-S1 nunca hay más de 4 envíos en vuelo y todos se envían', async () => {
  cola = Array.from({ length: 12 }, (_, i) => lectura(70 + i));
  let enVuelo = 0, maximo = 0;
  mock.method(api, 'enviarMedicion', async (req) => { enVuelo++; maximo = Math.max(maximo, enVuelo); await new Promise((r) => setTimeout(r, 20)); enVuelo--; return { id: req.idLocal }; });
  const t = performance.now();
  assert.deepEqual(await enviarPendientes(), { total: 12, enviadas: 12, rechazadas: 0 });
  assert.equal(maximo, CONCURRENCIA);
  assert.ok(performance.now() - t < 12 * 20, 'debe tardar menos que enviar una por una');
});
test('P12-S2 401 a mitad: expira la sesión, se propaga y no se toman más lecturas', async () => {
  cola = Array.from({ length: 10 }, (_, i) => lectura(70 + i));
  let llamadas = 0;
  mock.method(api, 'enviarMedicion', async () => { const n = ++llamadas; await new Promise((r) => setTimeout(r, 5)); if (n === 2) throw new ApiError('HTTP 401', 401); return { id: n }; });
  await assert.rejects(enviarPendientes(), (e) => e.status === 401);
  assert.equal(location.hash, '/login');
  assert.ok(llamadas <= CONCURRENCIA + 1, `se hicieron ${llamadas} envíos`);
});
test('P12-S3 sin red: ninguna lectura se marca como enviada y el error se propaga', async () => {
  cola = Array.from({ length: 6 }, () => lectura());
  mock.method(api, 'enviarMedicion', async () => { throw new ApiError('Sin conexión con el servidor'); });
  await assert.rejects(enviarPendientes(), /Sin conexión/);
  assert.equal(actualizar.mock.calls.filter((c) => c.arguments[0].synced).length, 0);
});
test('P12-S4 400 en una lectura: se marca rechazada y las demás continúan', async () => {
  cola = Array.from({ length: 5 }, (_, i) => lectura(70 + i));
  let n = 0;
  mock.method(api, 'enviarMedicion', async () => { if (n++ === 1) throw new ApiError('HTTP 400', 400); return { id: n }; });
  assert.deepEqual(await enviarPendientes(), { total: 5, enviadas: 4, rechazadas: 1 });
});
