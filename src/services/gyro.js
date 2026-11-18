import { setState, getState } from './store.js';
import { createStepCounter } from './steps.js';
import { createActivityClassifier } from './activity.js';

let sensor = null, handler = null;
const counter = createStepCounter();
const activity = createActivityClassifier();
const DEG = Math.PI / 180;

export const isSupported = () => 'Gyroscope' in window || 'DeviceMotionEvent' in window;

export async function start() {
  if (!isSupported()) { setState('gyro', { supported: false }); throw new Error('Sensores de movimiento no disponibles'); }
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    if ((await DeviceMotionEvent.requestPermission()) !== 'granted') throw new Error('Permiso denegado');
  }
  let fallback = !('Gyroscope' in window);
  if (!fallback) {
    sensor = new window.Gyroscope({ frequency: 20 });
    sensor.addEventListener('reading', () => setState('gyro', { x: sensor.x, y: sensor.y, z: sensor.z }));
    sensor.addEventListener('error', () => { fallback = true; });
    sensor.start();
  }
  handler = (e) => {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null) {
      setState('accel', { supported: true, x: a.x, y: a.y, z: a.z });
      if (counter.push(a.x, a.y, a.z)) setState('steps', { count: counter.count });
      const act = activity.push(a.x, a.y, a.z);
      if (act !== getState().activity.current) setState('activity', { current: act });
    }
    const r = e.rotationRate;
    if (fallback && r) setState('gyro', { x: (r.beta || 0) * DEG, y: (r.gamma || 0) * DEG, z: (r.alpha || 0) * DEG });
  };
  window.addEventListener('devicemotion', handler);
  setState('gyro', { supported: true, running: true, error: null });
}

export function stop() {
  sensor?.stop(); sensor = null;
  if (handler) window.removeEventListener('devicemotion', handler);
  handler = null;
  activity.reset();
  setState('gyro', { running: false });
  setState('activity', { current: 'reposo' });
}

export function resetSteps() { counter.reset(); setState('steps', { count: 0 }); }