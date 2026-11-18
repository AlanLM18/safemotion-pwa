// Estado global mínimo con suscripciones (sin dependencias).
const state = {
  ble: { status: 'idle', deviceName: null, error: null },   // máquina de estados (Práctica 2)
  gyro: { supported: null, running: false, x: 0, y: 0, z: 0 },
  accel: { supported: null, x: 0, y: 0, z: 0 },
  steps: { count: 0 },
  activity: { current: 'reposo' },
  wearable: { heartRate: null, temperature: null, spo2: null, steps: null, calories: null, battery: null, connected: false, simulated: false },
  monitor: { running: false, lastSync: null, lastResult: null }
};
const listeners = new Set();

export const getState = () => state;
export function setState(key, patch) {
  state[key] = { ...state[key], ...patch };
  listeners.forEach((fn) => fn(key, state[key]));
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
