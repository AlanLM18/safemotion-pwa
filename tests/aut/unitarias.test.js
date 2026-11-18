// Prácticas 13 y 14 · Fase 2: pruebas unitarias automatizadas (se ejecutan en CI en cada push y pull request).
// Componente crítico: inicio de sesión con PIN (src/services/auth.js) y su bloqueo por intentos, más dos pruebas de
// regresión para defectos detectados en la Práctica 11 que una prueba automatizada debe impedir que vuelvan:
//   WB-D11 · validateMedicionRequest duplicaba el error de un campo NaN (src/models/measurement.js)
//   WB-D10 · request() reportaba "Sin conexión" ante una respuesta 200 que no es JSON (src/services/api.js)
// Ejecutar: node --test tests/aut/unitarias.test.js
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = memStorage(); globalThis.sessionStorage = memStorage(); globalThis.location = { hash: '' };

const { login, isValidPin, getSession, segundosDeBloqueo, MAX_INTENTOS, BLOQUEO_MS } = await import('../../src/services/auth.js');
const { api, ApiError, createApi } = await import('../../src/services/api.js');
const { validateMedicionRequest } = await import('../../src/models/measurement.js');

const USUARIO = { id: 'uid-juan', nombre: 'Juan Pérez', rol: 'usuario' };
let apiLogin;
beforeEach(() => {
  localStorage.clear();
  apiLogin = mock.method(api, 'login', async (pin) => {
    if (pin === '0000') return { token: 'tok-juan', usuario: USUARIO };
    throw new ApiError('Credenciales inválidas', 401);
  });
});
afterEach(() => mock.restoreAll());

describe('AUT-01 · Validación del PIN e inicio de sesión', () => {
  test('U1 entrada válida: PIN de 4 dígitos inicia sesión y guarda la sesión con caducidad', async () => {
    const u = await login('0000');
    assert.deepEqual(u, USUARIO);
    const s = getSession();
    assert.equal(s.token, 'tok-juan');
    assert.ok(s.expiresAt > Date.now() + 7 * 3600_000, 'la sesión dura 8 h');
  });
  test('U2 entrada vacía o nula: no llega al servidor y responde "Credenciales inválidas"', async () => {
    for (const pin of ['', null, undefined]) {
      localStorage.clear();
      await assert.rejects(login(pin), /Credenciales inválidas/);
    }
    assert.equal(apiLogin.mock.callCount(), 0);
    assert.equal(getSession(), null);
  });
  test('U3 valores fuera de rango o de formato: 3 o 5 dígitos, letras, espacios y número en lugar de texto', () => {
    assert.equal(isValidPin('1234'), true);
    for (const pin of ['123', '12345', '12a4', ' 1234', '12 4', 1234, '١٢٣٤']) assert.equal(isValidPin(pin), false, `PIN ${JSON.stringify(pin)}`);
  });
});

describe('AUT-02 · Bloqueo por intentos y manejo de excepciones', () => {
  test('U4 resultado esperado: tras 5 PIN incorrectos se bloquea 30 s y ni el PIN correcto entra', async () => {
    for (let i = 0; i < MAX_INTENTOS; i++) await assert.rejects(login('9999'), /Credenciales inválidas/);
    const s = segundosDeBloqueo();
    assert.ok(s > 0 && s <= BLOQUEO_MS / 1000, `bloqueo de ${s} s`);
    await assert.rejects(login('0000'), /Bloqueado/);
    assert.equal(getSession(), null);
  });
  test('U5 el bloqueo sobrevive a recargar la página (se guarda en el teléfono, defecto D-04)', async () => {
    for (let i = 0; i < MAX_INTENTOS; i++) await assert.rejects(login('9999'));
    const guardado = JSON.parse(localStorage.getItem('sm_bloqueo'));
    assert.ok(guardado.hasta > Date.now());
  });
  test('U6 excepción de red: se propaga como "Sin conexión" y NO cuenta como intento fallido', async () => {
    apiLogin.mock.mockImplementation(async () => { throw new ApiError('Sin conexión con el servidor', 0); });
    for (let i = 0; i < MAX_INTENTOS + 2; i++) await assert.rejects(login('0000'), (e) => e.status === 0);
    assert.equal(segundosDeBloqueo(), 0, 'una caída de red no debe bloquear al usuario');
  });
  test('U7 un inicio de sesión correcto reinicia el contador de intentos', async () => {
    for (let i = 0; i < MAX_INTENTOS - 1; i++) await assert.rejects(login('9999'));
    await login('0000');
    assert.deepEqual(JSON.parse(localStorage.getItem('sm_bloqueo')), { intentos: 0, hasta: 0 });
  });
});

describe('AUT-03 · Regresiones de defectos de la Práctica 11', () => {
  const base = { frecuenciaCardiaca: 80, temperatura: 36.6, spo2: 97, bateria: 90, pasos: 10, calorias: 1, actividad: 'reposo' };
  test('U8 WB-D11: un campo NaN produce un solo error, no dos', () => {
    assert.deepEqual(validateMedicionRequest({ ...base, frecuenciaCardiaca: NaN }), ['frecuenciaCardiaca requerido']);
    assert.deepEqual(validateMedicionRequest({ ...base, pasos: NaN }), ['pasos inválido']);
  });
  test('U9 WB-D11: valores fuera de rango en los límites siguen rechazándose', () => {
    assert.deepEqual(validateMedicionRequest({ ...base, frecuenciaCardiaca: 221 }), ['frecuenciaCardiaca fuera de rango (30-220)']);
    assert.deepEqual(validateMedicionRequest({ ...base, temperatura: 29.9 }), ['temperatura fuera de rango (30-43)']);
    assert.deepEqual(validateMedicionRequest(base), []);
  });
  test('U10 WB-D10: una respuesta 200 que no es JSON se reporta como respuesta inválida, no como "Sin conexión"', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>Página de un proxy</html>', { status: 200 });
    try {
      await assert.rejects(createApi({ baseUrl: 'http://srv.test' }).estado(), (e) => e instanceof ApiError && e.status === 200 && e.message === 'Respuesta inválida del servidor');
    } finally { globalThis.fetch = original; }
  });
  test('U11 WB-D10: la caída de red real sigue reportándose como "Sin conexión" (status 0)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    try {
      await assert.rejects(createApi({ baseUrl: 'http://srv.test' }).estado(), (e) => e.status === 0 && e.message === 'Sin conexión con el servidor');
    } finally { globalThis.fetch = original; }
  });
});
