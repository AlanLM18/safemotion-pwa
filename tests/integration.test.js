// Pruebas de recepción y envío contra el backend Spring Boot real (safemotion-ai/backend).
// Ejecutar con el backend encendido:  API_URL=http://localhost:8080 npm run test:api
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/services/api.js';
import { createMeasurement, toMedicionRequest } from '../src/models/measurement.js';
import { initialReading, nextReading } from '../src/services/wearableSim.js';

const API_URL = process.env.API_URL;
const opts = { skip: !API_URL && 'Define API_URL para probar contra Spring Boot' };
const api = createApi({ baseUrl: API_URL ?? '' });
let token;

// Lectura unificada: wearable simulado + giroscopio + actividad, igual que la arma la app.
function medicion(escenario) {
  let r = initialReading();
  for (let i = 0; i < 15; i++) r = nextReading(r, escenario, 2, () => 0.5);
  return toMedicionRequest(createMeasurement({
    userId: 2, wearable: r, gyroscope: { x: 0.12, y: -0.05, z: 0.31 }, activity: escenario === 'alerta' ? 'reposo' : escenario
  }));
}

test('P1: GET /api/sistema/estado responde', opts, async () => {
  const r = await api.estado();
  assert.equal(typeof r.usuariosRegistrados, 'number');
});

test('P2: login con PIN incorrecto devuelve 401', opts, async () => {
  await assert.rejects(api.login('9999'), { status: 401, message: 'Credenciales inválidas' });
});

test('P3: login con PIN válido devuelve token y usuario', opts, async () => {
  const r = await api.login('0000');
  assert.ok(r.token);
  assert.equal(r.usuario.nombre, 'Juan Pérez');
  token = r.token;
});

test('P4: enviar medición sin token devuelve 401', opts, async () => {
  await assert.rejects(api.enviarMedicion(medicion('reposo'), 'token-invalido'), { status: 401 });
});

test('P5: enviar medición fuera de rango devuelve 400', opts, async () => {
  await assert.rejects(api.enviarMedicion({ ...medicion('reposo'), frecuenciaCardiaca: 0 }, token), { status: 400 });
});

test('P6: enviar medición válida (caminando) la guarda', opts, async () => {
  const guardada = await api.enviarMedicion(medicion('caminando'), token);
  assert.ok(guardada.id);
  assert.equal(guardada.actividad, 'caminando');
});

test('P7: medición del escenario "alerta" se guarda (el backend genera alertas)', opts, async () => {
  const guardada = await api.enviarMedicion(medicion('alerta'), token);
  assert.ok(guardada.frecuenciaCardiaca > 110);
});

test('P8: el historial devuelve las mediciones enviadas por el usuario', opts, async () => {
  const h = await api.historial(token, 5);
  assert.ok(h.length >= 2);
  assert.ok(h.every((m) => m.usuario.nombre === 'Juan Pérez'));
});

test('P9: servidor inexistente produce error de conexión controlado', opts, async () => {
  const caida = createApi({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
  await assert.rejects(caida.estado(), { status: 0, message: 'Sin conexión con el servidor' });
});

test('P10: logout invalida el token en el servidor', opts, async () => {
  await api.logout(token);
  await assert.rejects(api.historial(token), { status: 401 });
});
