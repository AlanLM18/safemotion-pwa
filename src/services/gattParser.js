// Decodifica las características BLE estándar que publica el wearable.
// Son funciones puras sobre DataView: se prueban con bytes sintéticos, sin hardware.

// Heart Rate Measurement (0x2A37). Bit 0 de flags: valor en uint16; bits 1-2: contacto con la piel.
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const heartRate = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
  const contactSupported = (flags & 0x04) !== 0;
  return { heartRate, contact: contactSupported ? (flags & 0x02) !== 0 : null };
}

// Battery Level (0x2A19): un byte con el porcentaje.
export const parseBatteryLevel = (dv) => dv.getUint8(0);

// Temperature Measurement (0x2A1C). Byte 0: flags (bit 0 = Fahrenheit).
// Bytes 1-4: FLOAT IEEE-11073 de 32 bits (mantisa de 24 bits con signo + exponente de 8 bits).
export function parseTemperature(dv) {
  const flags = dv.getUint8(0);
  const raw = dv.getUint32(1, true);
  let mantissa = raw & 0x00ffffff;
  if (mantissa >= 0x7ffffe && mantissa <= 0x800002) return null;   // NaN, NRes, +INF, -INF, reservado
  if (mantissa & 0x800000) mantissa -= 0x1000000;
  const exponent = dv.getInt8(4);
  let value = mantissa * Math.pow(10, exponent);
  if (flags & 0x01) value = (value - 32) * 5 / 9;
  return Math.round(value * 10) / 10;
}
