// VERSIÓN ORIGINAL (antes de la Práctica 12). La versión optimizada está en src/services/monitor.js.
// Monitoreo automático: cada intervalo une wearable + sensores del teléfono en una medición,
// la guarda en IndexedDB y la envía si hay conexión. Sin red, las lecturas esperan en la cola.
import { getState, setState } from './store.js';
import { measurementsDao } from './db.js';
import { getSession } from './auth.js';
import { enviarPendientes } from './sync.js';
import { createMeasurement } from '../models/measurement.js';
import { MONITOR_INTERVAL_MS } from '../config.js';

let timer = null;

export function capturar() {
  const s = getState(), session = getSession();
  if (!session) return null;
  const w = s.wearable.connected ? s.wearable : null;
  return createMeasurement({
    userId: session.user.id,
    deviceId: w?.simulated ? 'wearable-simulado' : w ? 'wearable-ble' : 'phone',
    wearable: w,
    gyroscope: s.gyro.running ? { x: s.gyro.x, y: s.gyro.y, z: s.gyro.z } : null,
    accelerometer: s.gyro.running && s.accel.supported ? { x: s.accel.x, y: s.accel.y, z: s.accel.z } : null,
    phoneSteps: s.gyro.running ? s.steps.count : null,
    activity: s.gyro.running ? s.activity.current : 'reposo'
  });
}

async function tick() {
  const m = capturar();
  if (!m || (!m.wearable && !m.gyroscope)) return;   // nada que registrar todavía
  await measurementsDao.insertar(m);
  if (!navigator.onLine) { setState('monitor', { lastResult: 'Sin red: lectura guardada en el teléfono' }); return; }
  try {
    const r = await enviarPendientes();
    setState('monitor', { lastSync: new Date().toISOString(), lastResult: `${r.enviadas} enviada(s), ${r.rechazadas} rechazada(s)` });
  } catch (e) {
    setState('monitor', { lastResult: e.status === 401 ? 'Sesión expirada' : 'Servidor no disponible: se reintentará' });
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(tick, MONITOR_INTERVAL_MS);
  setState('monitor', { running: true, lastResult: 'Monitoreo iniciado' });
  tick();
}

export function stop() {
  clearInterval(timer); timer = null;
  setState('monitor', { running: false });
}
export const isRunning = () => timer !== null;
