// Bluetooth Low Energy con Web Bluetooth. Solo BLE (el SPP/Bluetooth clásico de la Práctica 1 NO existe en la web).
// Contrato GATT estándar que el wearable (o un ESP32 de prueba) debe exponer:
export const GATT = {
  heartRate: 'heart_rate',               // 0x180D  -> characteristic heart_rate_measurement (notify)
  battery: 'battery_service',            // 0x180F  -> battery_level (read/notify)
  thermometer: 'health_thermometer'      // 0x1809  -> temperature_measurement (indicate)
};
import { setState, getState } from './store.js';
import { parseHeartRate, parseBatteryLevel, parseTemperature } from './gattParser.js';

// Máquina de estados de conexión (Práctica 2): idle -> connecting -> connected -> disconnected/error
let device = null, server = null;
export const isSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

export async function connect() {
  if (!isSupported()) { setState('ble', { status: 'error', error: 'Web Bluetooth no soportado' }); return; }
  try {
    setState('ble', { status: 'connecting', error: null });
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [GATT.heartRate] }],
      optionalServices: [GATT.battery, GATT.thermometer]
    });
    device.addEventListener('gattserverdisconnected', () => {
      setState('ble', { status: 'disconnected' });
      setState('wearable', { connected: false });
    });
    server = await device.gatt.connect();
    setState('ble', { status: 'connected', deviceName: device.name || 'Wearable' });
    setState('wearable', { connected: true, simulated: false });
    await subscribeAll(server);
  } catch (e) {
    setState('ble', { status: e.name === 'NotFoundError' ? 'idle' : 'error', error: e.message });
  }
}

// Suscripción a las características. Los servicios opcionales pueden no existir en el wearable.
async function subscribeAll(srv) {
  const hr = await (await srv.getPrimaryService(GATT.heartRate)).getCharacteristic('heart_rate_measurement');
  hr.addEventListener('characteristicvaluechanged', (e) => setState('wearable', { heartRate: parseHeartRate(e.target.value).heartRate }));
  await hr.startNotifications();

  try {
    const bat = await (await srv.getPrimaryService(GATT.battery)).getCharacteristic('battery_level');
    setState('wearable', { battery: parseBatteryLevel(await bat.readValue()) });
    if (bat.properties.notify) {
      bat.addEventListener('characteristicvaluechanged', (e) => setState('wearable', { battery: parseBatteryLevel(e.target.value) }));
      await bat.startNotifications();
    }
  } catch { /* sin servicio de batería */ }

  try {
    const temp = await (await srv.getPrimaryService(GATT.thermometer)).getCharacteristic('temperature_measurement');
    temp.addEventListener('characteristicvaluechanged', (e) => setState('wearable', { temperature: parseTemperature(e.target.value) }));
    await temp.startNotifications();
  } catch { /* sin termómetro */ }
}

export function disconnect() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  else setState('ble', { status: 'idle' });
}
export const getStatus = () => getState().ble.status;
