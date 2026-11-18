// Pruebas unitarias sin hardware: bytes BLE sintéticos, señales de acelerómetro generadas y modelos.
// Ejecutar: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate, parseBatteryLevel, parseTemperature } from '../src/services/gattParser.js';
import { createActivityClassifier } from '../src/services/activity.js';
import { createStepCounter } from '../src/services/steps.js';
import { nextReading, initialReading } from '../src/services/wearableSim.js';
import { createMeasurement, toMedicionRequest, validateMedicionRequest } from '../src/models/measurement.js';
import { evaluarAlertas } from '../src/models/alerts.js';
import { createApi } from '../src/services/api.js';

const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);

test('BLE: frecuencia cardiaca en uint8', () => {
  assert.deepEqual(parseHeartRate(dv(0x00, 72)), { heartRate: 72, contact: null });
});

test('BLE: frecuencia cardiaca en uint16 con contacto detectado', () => {
  assert.deepEqual(parseHeartRate(dv(0x07, 0x2c, 0x01)), { heartRate: 300, contact: true });
});

test('BLE: nivel de batería', () => {
  assert.equal(parseBatteryLevel(dv(87)), 87);
});

test('BLE: temperatura IEEE-11073 en °C (365 x 10^-1)', () => {
  assert.equal(parseTemperature(dv(0x00, 0x6d, 0x01, 0x00, 0xff)), 36.5);
});

test('BLE: temperatura en °F se convierte a °C (986 x 10^-1 °F)', () => {
  assert.equal(parseTemperature(dv(0x01, 0xda, 0x03, 0x00, 0xff)), 37);
});

test('BLE: valor NaN de temperatura devuelve null', () => {
  assert.equal(parseTemperature(dv(0x00, 0xff, 0xff, 0x7f, 0x00)), null);
});

// Señal sintética: gravedad + oscilación senoidal a cierta frecuencia y amplitud, muestreada a 50 Hz.
function senal(clasificador, amplitud, hz, segundos = 3) {
  let act;
  for (let i = 0; i < segundos * 50; i++) {
    const t = i * 20;
    act = clasificador.push(0, 0, 9.81 + amplitud * Math.sin(2 * Math.PI * hz * t / 1000), t);
  }
  return act;
}

test('Actividad: teléfono quieto = reposo', () => {
  assert.equal(senal(createActivityClassifier(), 0.1, 1), 'reposo');
});

test('Actividad: oscilación moderada = caminando', () => {
  assert.equal(senal(createActivityClassifier(), 2, 2), 'caminando');
});

test('Actividad: oscilación fuerte = corriendo', () => {
  assert.equal(senal(createActivityClassifier(), 7, 3), 'corriendo');
});

test('Pasos: 10 picos separados cuentan 10 pasos', () => {
  const c = createStepCounter();
  for (let i = 0; i < 50; i++) c.push(0, 0, 9.81, i * 20);           // estabiliza la gravedad
  for (let p = 0; p < 10; p++) {
    const base = 1000 + p * 500;
    for (let i = 0; i < 25; i++) c.push(0, 0, 9.81 + (i < 8 ? 6 : 0), base + i * 20);
  }
  assert.equal(c.count, 10);
});

test('Simulador: los valores se acercan al escenario y quedan en rango', () => {
  let r = initialReading();
  for (let i = 0; i < 20; i++) r = nextReading(r, 'corriendo', 2, () => 0.5);
  assert.ok(r.heartRate > 135 && r.heartRate <= 150, `FC ${r.heartRate}`);
  assert.ok(r.steps > 0);
  assert.ok(r.battery < 100 && r.battery > 0);
});

test('Alertas: escenario fuera de rango genera las 3 alertas del backend', () => {
  const tipos = evaluarAlertas({ heartRate: 124, temperature: 38.2, spo2: 90 }).map((a) => a.tipo);
  assert.deepEqual(tipos, ['Frecuencia cardiaca alta', 'Temperatura elevada', 'Saturación de oxígeno baja']);
});

test('Modelo: medición unificada se convierte en MedicionRequest válido', () => {
  const m = createMeasurement({
    userId: 1,
    wearable: { heartRate: 80, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 },
    gyroscope: { x: 0.1, y: -0.2, z: 0.3 },
    activity: 'caminando'
  });
  const req = toMedicionRequest(m);
  assert.equal(m.source, 'merged');
  assert.equal(req.frecuenciaCardiaca, 80);
  assert.equal(req.actividad, 'caminando');
  assert.equal(req.giroscopioZ, 0.3);
  assert.deepEqual(validateMedicionRequest(req), []);
});

test('Modelo: lectura solo del teléfono no se envía (faltan signos vitales)', () => {
  const m = createMeasurement({ userId: 1, gyroscope: { x: 0, y: 0, z: 0 } });
  const errores = validateMedicionRequest(toMedicionRequest(m));
  assert.ok(errores.includes('frecuenciaCardiaca requerido'));
});

test('Modelo: fuera de los rangos de MedicionRequest.java', () => {
  const errores = validateMedicionRequest({ frecuenciaCardiaca: 250, temperatura: 44, spo2: 98, bateria: 50, pasos: 0, calorias: 0, actividad: 'reposo' });
  assert.deepEqual(errores, ['frecuenciaCardiaca fuera de rango (30-220)', 'temperatura fuera de rango (30-43)']);
});

test('API simulada: mismo contrato que Spring Boot', async () => {
  const api = createApi({ baseUrl: '' });
  await assert.rejects(api.login('9999'), { status: 401 });
  const { token, usuario } = await api.login('0000');
  assert.equal(usuario.nombre, 'Juan Pérez');
  await assert.rejects(api.enviarMedicion({ frecuenciaCardiaca: 80 }, 'token-falso'), { status: 401 });
  await assert.rejects(api.enviarMedicion({ frecuenciaCardiaca: 0 }, token), { status: 400 });
  const ok = { frecuenciaCardiaca: 80, temperatura: 36.6, spo2: 97, pasos: 10, calorias: 0, actividad: 'reposo', bateria: 90 };
  assert.ok((await api.enviarMedicion(ok, token)).id);
  assert.equal((await api.historial(token)).length, 1);
});
