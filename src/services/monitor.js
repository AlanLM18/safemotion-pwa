// Monitoreo automático: cada intervalo une wearable + sensores del teléfono en una medición,
// la guarda en IndexedDB y la envía si hay conexión. Sin red, las lecturas esperan en la cola.
import { getState, setState } from './store.js';
import { measurementsDao } from './db.js';
import { getSession } from './auth.js';
import { enviarPendientes } from './sync.js';
import { createMeasurement } from '../models/measurement.js';
import { MONITOR_INTERVAL_MS } from '../config.js';
import { crearReintento, esReintentable } from './reintento.js';

let timer = null;
// Práctica 12: reintento controlado. Tras un fallo de red o de servidor la lectura se sigue guardando en el teléfono
// cada 5 s, pero el envío espera 5, 10, 20 y hasta 30 s (con ±20 % de variación). Al volver la red se reintenta ya.
const reintento = crearReintento();
globalThis.addEventListener?.('online', () => reintento.reiniciar());
export const estadoReintento = () => ({ fallos: reintento.fallos, esperaRestanteMs: reintento.esperaRestanteMs });

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
  if (!reintento.puedeIntentar()) {
    setState('monitor', { lastResult: `Sin conexión con el servidor: próximo intento en ${Math.ceil(reintento.esperaRestanteMs / 1000)} s` });
    return;
  }
  try {
    const r = await enviarPendientes();
    reintento.registrarExito();
    setState('monitor', { lastSync: new Date().toISOString(), lastResult: `${r.enviadas} enviada(s), ${r.rechazadas} rechazada(s)` });
  } catch (e) {
    if (esReintentable(e)) {
      const espera = reintento.registrarFallo();
      setState('monitor', { lastResult: `Servidor no disponible: se reintentará en ${Math.ceil(espera / 1000)} s` });
    } else {
      setState('monitor', { lastResult: e.status === 401 ? 'Sesión expirada' : 'No se pudo enviar' });
    }
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
