// Prácticas 13 y 14 · Fase 3: pruebas de integración automatizadas (se ejecutan en CI en cada push y pull request).
// Une módulos reales: el cliente REST de la app (src/services/api.js), la cola local en IndexedDB (src/services/db.js,
// con fake-indexeddb), la sincronización (src/services/sync.js), el backend Spring Boot y Firestore (emulador).
// Requiere: emulador de Firebase (auth + firestore) y el backend Spring conectado a él. En CI lo levanta
// tests/aut/ci-integracion.sh; en local:
//   API_URL=http://localhost:8080 FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --test tests/aut/integracion.test.js
import 'fake-indexeddb/auto';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = memStorage(); globalThis.sessionStorage = memStorage(); globalThis.location = { hash: '' };

const { api, createApi, ApiError } = await import('../../src/services/api.js');
const { login, getSession } = await import('../../src/services/auth.js');
const { enviarPendientes } = await import('../../src/services/sync.js');
const { measurementsDao } = await import('../../src/services/db.js');
const { createMeasurement, toMedicionRequest } = await import('../../src/models/measurement.js');
const { entornoFirebase, prepararEmulador } = await import('../support/firebaseCuentas.js');

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const fb = entornoFirebase();
if (!fb.emulador) throw new Error('Faltan FIRESTORE_EMULATOR_HOST y FIREBASE_AUTH_EMULATOR_HOST (las pruebas de integración usan el emulador)');
const real = createApi({ baseUrl: API, timeoutMs: 15_000 });
Object.assign(api, real);   // la app (auth.js, sync.js) habla con el backend Spring real

const lectura = (userId, heartRate = 80) => createMeasurement({
  userId, wearable: { heartRate, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 }, gyroscope: { x: 0.1, y: -0.2, z: 0.3 }, activity: 'caminando'
});
// Lectura directa de Firestore (emulador, permisos de administrador): comprueba lo que de verdad quedó guardado.
const docFirestore = async (ruta) => {
  const r = await fetch(`http://${fb.emulador.firestore}/v1/projects/${fb.config.projectId}/databases/(default)/documents/${ruta}`, { headers: { Authorization: 'Bearer owner' } });
  return r.status === 404 ? null : r.json();
};
const listaFirestore = async (ruta) => {
  const r = await fetch(`http://${fb.emulador.firestore}/v1/projects/${fb.config.projectId}/databases/(default)/documents/${ruta}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
  return (await r.json()).documents ?? [];
};
const limpiarIndexedDB = async () => { for (const m of await measurementsDao.obtenerTodos()) await measurementsDao.eliminar(m.id); };

let cuentas;
before(async () => {
  cuentas = await prepararEmulador(fb);
  const e = await real.estado();   // el backend ya respondió (en CI el script espera a que arranque)
  assert.ok(e, 'el backend no respondió /api/sistema/estado');
});
beforeEach(async () => { localStorage.clear(); await limpiarIndexedDB(); });

describe('AUT-04 · App ↔ API Spring: envío y recepción de datos', () => {
  test('I1 login con PIN real devuelve token y el perfil desde Firestore (200)', async () => {
    const u = await login('0000');
    assert.equal(u.id, cuentas.juan.uid);
    assert.equal(u.rol, 'usuario');
    assert.ok(getSession().token.length > 100, 'token de Firebase');
  });
  test('I2 PIN inexistente → 401 traducido a "Credenciales inválidas" y no crea sesión', async () => {
    await assert.rejects(login('9876'), (e) => e.message === 'Credenciales inválidas' && e.status === 401);
    assert.equal(getSession(), null);
  });
  test('I3 lectura válida → 201 y el mismo dato vuelve en GET /api/mediciones/historial', async () => {
    const { token } = await real.login('0000');
    const req = toMedicionRequest(lectura(cuentas.juan.uid, 77));
    const guardada = await real.enviarMedicion(req, token);
    assert.equal(guardada.id, req.idLocal);
    const h = await real.historial(token, 50);
    assert.equal(h.find((m) => m.id === req.idLocal)?.frecuenciaCardiaca, 77);
  });
  test('I4 el backend rechaza lo que la app no debe mandar: FC 300 → 400 y sin token → 401', async () => {
    const { token } = await real.login('0000');
    const req = { ...toMedicionRequest(lectura(cuentas.juan.uid)), frecuenciaCardiaca: 300 };
    await assert.rejects(real.enviarMedicion(req, token), (e) => e instanceof ApiError && e.status === 400);
    await assert.rejects(real.enviarMedicion(toMedicionRequest(lectura(cuentas.juan.uid)), ''), (e) => e.status === 401);
  });
});

describe('AUT-05 · Servidor que no responde o falla', () => {
  let colgado, url;
  before(async () => {
    // Acepta la conexión y nunca contesta: simula a Render "dormido" o una red que se queda colgada.
    colgado = http.createServer(() => {}); await new Promise((ok) => colgado.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${colgado.address().port}`;
  });
  after(() => { colgado.closeAllConnections(); colgado.close(); });

  test('I5 sin respuesta: el cliente corta en el tiempo límite y responde "Sin conexión" (status 0)', async () => {
    const t0 = Date.now();
    await assert.rejects(createApi({ baseUrl: url, timeoutMs: 500 }).estado(), (e) => e.status === 0 && e.message === 'Sin conexión con el servidor');
    assert.ok(Date.now() - t0 < 3000, 'no se queda esperando indefinidamente');
  });
  test('I6 con el servidor colgado la cola local se conserva: las lecturas siguen pendientes y luego se envían', async () => {
    const s = await real.login('0000');
    localStorage.setItem('sm_session', JSON.stringify({ token: s.token, user: s.usuario, expiresAt: Date.now() + 3600_000 }));
    for (const hr of [70, 71, 72]) await measurementsDao.insertar(lectura(s.usuario.id, hr));
    Object.assign(api, createApi({ baseUrl: url, timeoutMs: 500 }));
    try { await assert.rejects(enviarPendientes(), (e) => e.status === 0); }
    finally { Object.assign(api, real); }
    assert.equal((await measurementsDao.obtenerPendientes(s.usuario.id)).length, 3, 'nada se pierde ni se marca como enviado');
    const r = await enviarPendientes();   // vuelve la conexión
    assert.deepEqual(r, { total: 3, enviadas: 3, rechazadas: 0 });
  });
  test('I7 token revocado/inválido → 401: la app cierra la sesión y conserva las lecturas', async () => {
    localStorage.setItem('sm_session', JSON.stringify({ token: 'token-invalido', user: { id: cuentas.juan.uid }, expiresAt: Date.now() + 3600_000 }));
    await measurementsDao.insertar(lectura(cuentas.juan.uid));
    await assert.rejects(enviarPendientes(), (e) => e.status === 401);
    assert.equal(getSession(), null);
    assert.equal(location.hash, '/login');
    assert.equal((await measurementsDao.obtenerPendientes(cuentas.juan.uid)).length, 1);
  });
});

describe('AUT-06 · Persistencia: el registro guarda los datos (IndexedDB → Spring → Firestore)', () => {
  test('I8 la lectura guardada en el teléfono llega a usuarios/{uid}/mediciones/{idLocal} con sus valores', async () => {
    const u = await login('1111');
    const m = lectura(u.id, 88);
    await measurementsDao.insertar(m);
    assert.equal((await measurementsDao.obtenerPendientes(u.id)).length, 1);
    assert.deepEqual(await enviarPendientes(), { total: 1, enviadas: 1, rechazadas: 0 });
    const local = (await measurementsDao.obtenerTodos(u.id)).find((x) => x.id === m.id);
    assert.equal(local.synced, true);
    assert.equal(local.serverId, m.id);
    const doc = await docFirestore(`usuarios/${u.id}/mediciones/${m.id}`);
    assert.ok(doc, 'el documento existe en Firestore');
    assert.equal(Number(doc.fields.frecuenciaCardiaca.integerValue), 88);
    assert.equal(doc.fields.actividad.stringValue, 'caminando');
  });
  test('I9 idempotencia: reenviar la misma lectura (reintento tras corte) no crea un duplicado', async () => {
    const { token, usuario } = await real.login('1111');
    const req = toMedicionRequest(lectura(usuario.id, 66));
    const antes = (await listaFirestore(`usuarios/${usuario.id}/mediciones`)).length;
    const resultados = await Promise.all([1, 2, 3].map(() => real.enviarMedicion(req, token)));
    assert.ok(resultados.every((r) => r.id === req.idLocal));
    assert.equal((await listaFirestore(`usuarios/${usuario.id}/mediciones`)).length, antes + 1);
  });
  test('I10 la lectura rechazada por validación queda marcada en el teléfono y NO llega a Firestore', async () => {
    const u = await login('1111');
    const m = createMeasurement({ userId: u.id, phoneSteps: 50 });   // solo el teléfono, sin datos del wearable
    await measurementsDao.insertar(m);
    assert.deepEqual(await enviarPendientes(), { total: 1, enviadas: 0, rechazadas: 1 });
    assert.match((await measurementsDao.obtenerTodos(u.id))[0].error, /requerido/);
    assert.equal(await docFirestore(`usuarios/${u.id}/mediciones/${m.id}`), null);
  });
});
