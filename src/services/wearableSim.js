// Wearable simulado: genera lecturas realistas sin hardware (mismo enfoque que sensor_simulator.dart).
// Permite probar todo el flujo app -> base de datos mientras no está listo el ESP32 con BLE.
// Si los sensores del teléfono están encendidos, los pasos (y las calorías) son los que cuenta el acelerómetro.
import { setState, getState, subscribe } from './store.js';

export const ESCENARIOS = {
  reposo:    { fc: 72,  temp: 36.5, spo2: 98, pasosPorSeg: 0 },
  caminando: { fc: 98,  temp: 36.7, spo2: 97, pasosPorSeg: 1.8 },
  corriendo: { fc: 145, temp: 37.2, spo2: 96, pasosPorSeg: 2.8 },
  alerta:    { fc: 124, temp: 38.2, spo2: 90, pasosPorSeg: 0 }      // fuera de rango: dispara alertas en el backend
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const initialReading = () => ({ heartRate: 72, temperature: 36.5, spo2: 98, steps: 0, calories: 0, battery: 100 });

// Función pura: siguiente lectura a partir de la anterior (random walk hacia el valor del escenario).
export function nextReading(prev, escenario, dtSeg, rand = Math.random) {
  const e = ESCENARIOS[escenario] ?? ESCENARIOS.reposo;
  const ruido = (amp) => (rand() * 2 - 1) * amp;
  const steps = prev.steps + Math.round(e.pasosPorSeg * dtSeg);
  return {
    heartRate: Math.round(clamp(prev.heartRate + (e.fc - prev.heartRate) * 0.35 + ruido(2), 40, 200)),
    temperature: Math.round(clamp(prev.temperature + (e.temp - prev.temperature) * 0.3 + ruido(0.05), 35, 41) * 10) / 10,
    spo2: Math.round(clamp(e.spo2 + ruido(1), 85, 100)),
    steps,
    calories: Math.round(steps * 0.04),
    battery: clamp(prev.battery - 0.02 * dtSeg, 0, 100)
  };
}

let timer = null, reading = null, escenario = 'reposo', offPasos = null;

export const isRunning = () => timer !== null;
export const getEscenario = () => escenario;

export function setEscenario(nombre) {
  if (ESCENARIOS[nombre]) escenario = nombre;
}

export function start({ intervalMs = 2000 } = {}) {
  if (timer) return;
  reading = initialReading();
  const publish = () => {
    const { gyro, steps } = getState();
    const pasos = gyro.running ? steps.count : reading.steps;
    setState('wearable', { ...reading, steps: pasos, calories: Math.round(pasos * 0.04), battery: Math.round(reading.battery), connected: true, simulated: true });
  };
  publish();
  timer = setInterval(() => { reading = nextReading(reading, escenario, intervalMs / 1000); publish(); }, intervalMs);
  offPasos = subscribe((k) => (k === 'steps' || k === 'gyro') && timer && publish());   // cada paso se ve al momento
}

export function stop() {
  clearInterval(timer); timer = null;
  offPasos?.(); offPasos = null;
  setState('wearable', { heartRate: null, temperature: null, spo2: null, steps: null, calories: null, battery: null, connected: false, simulated: false });
}
