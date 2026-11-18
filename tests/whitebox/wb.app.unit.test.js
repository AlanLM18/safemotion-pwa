// Práctica 11 · Fase 2: pruebas White Box de la aplicación (PWA SafeMotion).
// Cada caso ejecuta un camino independiente del grafo de flujo de control del método (ver informe).
//   M1 validación   -> validateMedicionRequest()  src/models/measurement.js:70-85   V(G) = 15
//   M2 cálculo      -> classify() + createActivityClassifier().push()  src/services/activity.js:6-25   V(G) = 3 + 4
//   M3 comunicación -> request() / login() de createApi()  src/services/api.js:20-56   V(G) = 8 (+3 en login)
//                      sincronizar()  src/services/sync.js:15-41   V(G) = 9
// Ejecutar:  npm run test:wb   (con cobertura: npm run test:wb:cov)
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Entorno de navegador mínimo para auth.js / sync.js (sesión en localStorage).
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.location = { hash: '' };

const { validateMedicionRequest, toMedicionRequest, createMeasurement } = await import('../../src/models/measurement.js');
const { classify, createActivityClassifier, UMBRAL_CAMINANDO, UMBRAL_CORRIENDO } = await import('../../src/services/activity.js');
const { createApi, ApiError, api } = await import('../../src/services/api.js');
const { enviarPendientes } = await import('../../src/services/sync.js');
const { measurementsDao } = await import('../../src/services/db.js');
const { isValidPin } = await import('../../src/services/auth.js');

// Lectura válida de referencia: todos los campos en rango.
const base = () => ({ frecuenciaCardiaca: 80, temperatura: 36.6, spo2: 97, bateria: 90, pasos: 120, calorias: 5, actividad: 'caminando' });

// ───────────────────────── M1 · validateMedicionRequest ─────────────────────────
describe('M1 validateMedicionRequest (validación)', () => {
  test('C1 camino feliz: lectura válida -> sin errores (todas las decisiones en F)', () => {
    assert.deepEqual(validateMedicionRequest(base()), []);
  });
  test('C2 spo2 ausente (null) y opcional -> continue (D2 = V, C1 = V, C2 = V)', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), spo2: null }), []);
  });
  test('C3 campo obligatorio ausente: FC null -> D2 = F por C2 = F, D3 = V por C3 (no es number)', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: null }), ['frecuenciaCardiaca requerido']);
  });
  test('C4 FC = NaN -> D3 = V por C4. DEFECTO WB-D03: también entra a D6 y duplica el error del mismo campo', () => {
    // Esperado: ['frecuenciaCardiaca requerido']. Observado en la 1.a corrida: dos mensajes para el mismo campo.
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: NaN }), ['frecuenciaCardiaca requerido', 'frecuenciaCardiaca debe ser entero']);
  });
  test('C5 FC en texto ("80") -> requerido (no se acepta conversión implícita)', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: '80' }), ['frecuenciaCardiaca requerido']);
  });
  test('C6 límite inferior: FC 29 rechaza (C5 = V), FC 30 acepta', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: 29 }), ['frecuenciaCardiaca fuera de rango (30-220)']);
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: 30 }), []);
  });
  test('C7 límite superior: FC 221 rechaza (C5 = F, C6 = V), FC 220 acepta', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: 221 }), ['frecuenciaCardiaca fuera de rango (30-220)']);
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: 220 }), []);
  });
  test('C8 temperatura: 29.9 y 43.1 fuera; 30.0 y 43.0 dentro (valores límite decimales)', () => {
    for (const t of [29.9, 43.1]) assert.deepEqual(validateMedicionRequest({ ...base(), temperatura: t }), ['temperatura fuera de rango (30-43)']);
    for (const t of [30, 43]) assert.deepEqual(validateMedicionRequest({ ...base(), temperatura: t }), []);
  });
  test('C9 spo2 y batería: -1 y 101 fuera; 0 y 100 dentro', () => {
    for (const campo of ['spo2', 'bateria']) {
      assert.deepEqual(validateMedicionRequest({ ...base(), [campo]: -1 }), [`${campo} fuera de rango (0-100)`]);
      assert.deepEqual(validateMedicionRequest({ ...base(), [campo]: 101 }), [`${campo} fuera de rango (0-100)`]);
      assert.deepEqual(validateMedicionRequest({ ...base(), [campo]: 0 }), []);
      assert.deepEqual(validateMedicionRequest({ ...base(), [campo]: 100 }), []);
    }
  });
  test('C10 decimal en campo entero -> D6 = V (C7 = V, C8 = V)', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), frecuenciaCardiaca: 80.5 }), ['frecuenciaCardiaca debe ser entero']);
    assert.deepEqual(validateMedicionRequest({ ...base(), pasos: 1.5 }), ['pasos debe ser entero']);
  });
  test('C11 pasos -1 -> D7 = V; pasos 0 (límite) -> D7 = F', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), pasos: -1 }), ['pasos inválido']);
    assert.deepEqual(validateMedicionRequest({ ...base(), pasos: 0 }), []);
  });
  test('C12 calorías ausentes (undefined) -> D8 = V', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), calorias: undefined }), ['calorias inválido']);
  });
  test('C13 actividad vacía "" -> D9 = V por C9; actividad "   " -> D9 = V por C10', () => {
    assert.deepEqual(validateMedicionRequest({ ...base(), actividad: '' }), ['actividad requerida']);
    assert.deepEqual(validateMedicionRequest({ ...base(), actividad: '   ' }), ['actividad requerida']);
  });
  test('C14 objeto vacío -> acumula todos los errores (no se detiene en el primero)', () => {
    const e = validateMedicionRequest({});
    assert.deepEqual(e, ['frecuenciaCardiaca requerido', 'temperatura requerido', 'bateria requerido', 'pasos inválido', 'calorias inválido', 'actividad requerida']);
  });
  test('C15 excepción: entrada null lanza TypeError (el método no protege contra null)', () => {
    assert.throws(() => validateMedicionRequest(null), TypeError);
  });
  test('C16 integración con toMedicionRequest: lectura solo del teléfono (sin wearable) no pasa la validación', () => {
    const m = createMeasurement({ userId: 2, gyroscope: { x: 0, y: 0, z: 0 }, phoneSteps: 10, activity: 'caminando' });
    const req = toMedicionRequest(m);
    assert.equal(req.spo2, null);
    assert.deepEqual(validateMedicionRequest(req), ['frecuenciaCardiaca requerido', 'temperatura requerido', 'bateria requerido']);
  });
});

// ───────────────────────── M2 · classify / ActivityClassifier.push ─────────────────────────
describe('M2 classify + ActivityClassifier.push (cálculo)', () => {
  test('C1 classify: std < 0.6 -> reposo (D1 = V)', () => assert.equal(classify(0), 'reposo'));
  test('C2 classify: límites 0.599 / 0.6 -> reposo / caminando (D1 = F, D2 = V)', () => {
    assert.equal(classify(UMBRAL_CAMINANDO - 0.001), 'reposo');
    assert.equal(classify(UMBRAL_CAMINANDO), 'caminando');
  });
  test('C3 classify: límites 3.499 / 3.5 -> caminando / corriendo (D2 = F)', () => {
    assert.equal(classify(UMBRAL_CORRIENDO - 0.001), 'caminando');
    assert.equal(classify(UMBRAL_CORRIENDO), 'corriendo');
  });
  test('C4 classify: NaN no es < umbral -> "corriendo" (defecto: un sensor que entrega NaN se clasifica como carrera)', () => {
    assert.equal(classify(NaN), 'corriendo');
  });
  test('C5 push: menos de minSamples -> D(if) = F, conserva "reposo" aunque haya movimiento', () => {
    const c = createActivityClassifier({ minSamples: 10 });
    for (let i = 0; i < 9; i++) assert.equal(c.push(0, 0, i % 2 ? 20 : 0, i * 20), 'reposo');
  });
  test('C6 push: 10 muestras constantes (std = 0) -> calcula y clasifica reposo', () => {
    const c = createActivityClassifier({ minSamples: 10 });
    let r; for (let i = 0; i < 10; i++) r = c.push(0, 0, 9.81, i * 20);
    assert.equal(r, 'reposo');
  });
  test('C7 push: oscilación ±1 m/s² (std = 1) -> caminando', () => {
    const c = createActivityClassifier({ minSamples: 10 });
    let r; for (let i = 0; i < 20; i++) r = c.push(0, 0, 9.81 + (i % 2 ? 1 : -1), i * 20);
    assert.equal(r, 'caminando');
  });
  test('C8 push: oscilación ±5 m/s² (std = 5) -> corriendo', () => {
    const c = createActivityClassifier({ minSamples: 10 });
    let r; for (let i = 0; i < 20; i++) r = c.push(0, 0, 9.81 + (i % 2 ? 5 : -5), i * 20);
    assert.equal(r, 'corriendo');
  });
  test('C9 ventana deslizante: el while descarta muestras viejas (> windowMs) y vuelve a reposo', () => {
    const c = createActivityClassifier({ windowMs: 2000, minSamples: 10 });
    for (let i = 0; i < 20; i++) c.push(0, 0, 9.81 + (i % 2 ? 5 : -5), i * 20);          // corriendo
    let r; for (let i = 0; i < 120; i++) r = c.push(0, 0, 9.81, 400 + i * 20);         // 2.4 s quieto
    assert.equal(r, 'reposo');
  });
  test('C10 reset() regresa al estado inicial', () => {
    const c = createActivityClassifier({ minSamples: 2 });
    c.push(0, 0, 0, 0); c.push(0, 0, 20, 10);
    assert.equal(c.current, 'corriendo');
    c.reset();
    assert.equal(c.current, 'reposo');
  });
});

// ───────────────────────── M3 · request()/login() (comunicación) ─────────────────────────
describe('M3 createApi().request y login (comunicación con el servicio)', () => {
  let fetchOriginal;
  beforeEach(() => { fetchOriginal = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = fetchOriginal; });
  const responder = (status, cuerpo = '') => {
    const llamadas = [];
    globalThis.fetch = async (url, init) => { llamadas.push({ url, init }); return new Response(cuerpo === null ? null : cuerpo, { status }); };
    return llamadas;
  };
  const cliente = (timeoutMs = 8000) => createApi({ baseUrl: 'http://srv.test', timeoutMs });

  test('C1 200 con JSON + token: envía Authorization sin "Bearer" y devuelve el objeto (D1 V, D3 F, D5 V)', async () => {
    const ll = responder(200, '{"id":7}');
    assert.deepEqual(await cliente().enviarMedicion(base(), 'tok-1'), { id: 7 });
    assert.equal(ll[0].init.headers.Authorization, 'tok-1');
    assert.equal(ll[0].init.method, 'POST');
    assert.equal(JSON.parse(ll[0].init.body).frecuenciaCardiaca, 80);
  });
  test('C2 204 sin cuerpo y sin token -> null, sin cabecera Authorization (D1 F, D2 F, D5 F)', async () => {
    const ll = responder(204, null);
    assert.equal(await cliente().logout(undefined), null);
    assert.equal('Authorization' in ll[0].init.headers, false);
  });
  test('C3 409 con cuerpo JSON -> ApiError con status y datos (D3 V, D4 V)', async () => {
    responder(409, '{"actual":{"estado":"ATENDIDA"}}');
    await assert.rejects(cliente().atenderEmergencia(1, 't'), (e) => e instanceof ApiError && e.status === 409 && e.datos.actual.estado === 'ATENDIDA');
  });
  test('C4 403 sin cuerpo -> ApiError status 403, datos null (D3 V, D4 F)', async () => {
    responder(403, '');
    await assert.rejects(cliente().conversaciones('t'), (e) => e.status === 403 && e.datos === null);
  });
  test('C5 500 con HTML (no JSON) -> el catch interno se traga el error de parseo y conserva el 500 (E1)', async () => {
    responder(500, '<html>Whitelabel Error Page</html>');
    await assert.rejects(cliente().historial('t'), (e) => e.status === 500 && e.datos === null);
  });
  test('C6 excepción de red (fetch lanza TypeError) -> "Sin conexión con el servidor", status 0 (D6 F)', async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(cliente().estado(), (e) => e instanceof ApiError && e.status === 0 && e.message === 'Sin conexión con el servidor');
  });
  test('C7 timeout: el AbortController cancela a los N ms y se informa sin conexión', async () => {
    globalThis.fetch = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    const t0 = Date.now();
    await assert.rejects(cliente(50).estado(), (e) => e.status === 0);
    assert.ok(Date.now() - t0 < 1000);
  });
  test('C8 DEFECTO: 200 con cuerpo que no es JSON se reporta como "Sin conexión" (oculta el error real)', async () => {
    responder(200, 'OK');
    await assert.rejects(cliente().estado(), (e) => e.message === 'Sin conexión con el servidor' && e.status === 0);
  });
  test('C9 login: 401 y 400 se traducen a "Credenciales inválidas" (decisión con 2 condiciones)', async () => {
    responder(401, '{"mensaje":"PIN incorrecto"}');
    await assert.rejects(cliente().login('9999'), (e) => e.message === 'Credenciales inválidas' && e.status === 401);
    responder(400, '');
    await assert.rejects(cliente().login('12'), (e) => e.message === 'Credenciales inválidas' && e.status === 400);
  });
  test('C10 login: 500 no se confunde con credenciales inválidas (ambas condiciones en F)', async () => {
    responder(500, '');
    await assert.rejects(cliente().login('1234'), (e) => e.message === 'HTTP 500');
  });
  test('C10b login: 403 (cuenta deshabilitada) conserva el mensaje del backend, distinto de credenciales inválidas', async () => {
    responder(403, '{"status":403,"error":"Esta cuenta está deshabilitada"}');
    await assert.rejects(cliente().login('4444'), (e) => e.status === 403 && e.message === 'Esta cuenta está deshabilitada');
    responder(403, '');
    await assert.rejects(cliente().login('4444'), (e) => e.status === 403 && e.message === 'Esta cuenta está deshabilitada');
  });
  test('C11 isValidPin: valores límite de longitud y tipo', () => {
    assert.equal(isValidPin('1234'), true);
    for (const p of ['123', '12345', '12a4', '', ' 1234', 1234, null]) assert.equal(isValidPin(p), false, String(p));
  });
});

// ───────────────────────── M3b · sincronizar() (cola local -> servidor) ─────────────────────────
describe('M3b sincronizar() (comunicación app -> API con cola local)', () => {
  const USER = { id: 2, nombre: 'Juan Pérez', rol: 'usuario' };
  const lectura = (hr = 80, userId = 2) => createMeasurement({ userId, wearable: { heartRate: hr, spo2: 97, temperature: 36.6, steps: 10, calories: 1, battery: 90 }, activity: 'caminando' });
  let cola, actualizar, enviar;
  beforeEach(() => {
    localStorage.setItem('sm_session', JSON.stringify({ token: 'tok', user: USER, expiresAt: Date.now() + 3600_000 }));
    cola = [];
    mock.method(measurementsDao, 'obtenerPendientes', async () => cola);
    actualizar = mock.method(measurementsDao, 'actualizar', async () => {});
    let n = 0;
    enviar = mock.method(api, 'enviarMedicion', async () => ({ id: ++n }));
  });
  afterEach(() => { mock.restoreAll(); localStorage.clear(); location.hash = ''; });

  test('C1 sin sesión -> lanza "Sin sesión" (D1 V)', async () => {
    localStorage.clear();
    await assert.rejects(enviarPendientes(), /Sin sesión/);
  });
  test('C2 cola vacía -> el for no itera, total 0', async () => {
    assert.deepEqual(await enviarPendientes(), { total: 0, enviadas: 0, rechazadas: 0 });
  });
  test('C3 lectura de otro usuario se filtra (no se envía)', async () => {
    cola = [lectura(80, 99)];
    assert.deepEqual(await enviarPendientes(), { total: 0, enviadas: 0, rechazadas: 0 });
    assert.equal(enviar.mock.callCount(), 0);
  });
  test('C4 lectura inválida (FC 250) -> se marca con error local y continue, sin red', async () => {
    cola = [lectura(250)];
    assert.deepEqual(await enviarPendientes(), { total: 1, enviadas: 0, rechazadas: 1 });
    assert.equal(enviar.mock.callCount(), 0);
    assert.match(actualizar.mock.calls[0].arguments[0].error, /fuera de rango/);
  });
  test('C5 lectura válida -> se envía y se marca synced con serverId', async () => {
    cola = [lectura(80)];
    assert.deepEqual(await enviarPendientes(), { total: 1, enviadas: 1, rechazadas: 0 });
    assert.equal(actualizar.mock.calls[0].arguments[0].synced, true);
    assert.equal(actualizar.mock.calls[0].arguments[0].serverId, 1);
  });
  test('C6 servidor responde 401 -> expira la sesión y propaga el error', async () => {
    cola = [lectura(80)];
    enviar.mock.mockImplementation(async () => { throw new ApiError('HTTP 401', 401); });
    await assert.rejects(enviarPendientes(), (e) => e.status === 401);
    assert.equal(location.hash, '/login');
  });
  test('C7 servidor responde 400 -> se marca rechazada y continúa con la siguiente', async () => {
    cola = [lectura(80), lectura(81)];
    let i = 0;
    enviar.mock.mockImplementation(async () => { if (i++ === 0) throw new ApiError('HTTP 400', 400); return { id: 5 }; });
    assert.deepEqual(await enviarPendientes(), { total: 2, enviadas: 1, rechazadas: 1 });
  });
  test('C8 sin red (status 0) -> se detiene; lo pendiente queda sin marcar para reintento', async () => {
    cola = [lectura(80), lectura(81)];
    enviar.mock.mockImplementation(async () => { throw new ApiError('Sin conexión con el servidor'); });
    await assert.rejects(enviarPendientes(), /Sin conexión/);
    assert.equal(actualizar.mock.callCount(), 0);
  });
  test('C9 llamadas simultáneas comparten la misma sincronización (no se envía dos veces)', async () => {
    cola = [lectura(80)];
    const [a, b] = await Promise.all([enviarPendientes(), enviarPendientes()]);
    assert.equal(a, b);
    assert.equal(enviar.mock.callCount(), 1);
  });
  test('C10 el request enviado lleva idLocal estable (clave para idempotencia)', async () => {
    const m = lectura(80); cola = [m];
    await enviarPendientes();
    assert.equal(enviar.mock.calls[0].arguments[0].idLocal, m.id);
  });
});
