// Modelo unificado de medición: wearable (BLE o simulado) + sensores del teléfono.
// Se guarda así en IndexedDB y se convierte a MedicionRequest para Spring Boot.
export function createMeasurement({ userId, deviceId = 'phone', wearable = null, gyroscope = null, accelerometer = null, phoneSteps = null, activity = null }) {
  return {
    id: crypto.randomUUID(),
    userId,
    deviceId,
    timestamp: new Date().toISOString(),
    source: wearable && (gyroscope || accelerometer) ? 'merged' : wearable ? 'wearable' : 'phone',
    wearable: wearable && {
      heartRate: wearable.heartRate ?? null,   // bpm
      spo2: wearable.spo2 ?? null,             // %
      steps: wearable.steps ?? null,
      calories: wearable.calories ?? null,     // kcal
      temperature: wearable.temperature ?? null, // °C
      battery: wearable.battery ?? null,       // %
      simulated: !!wearable.simulated
    },
    gyroscope: gyroscope && { x: gyroscope.x, y: gyroscope.y, z: gyroscope.z, unit: 'rad/s' },
    accelerometer: accelerometer && { x: accelerometer.x, y: accelerometer.y, z: accelerometer.z, unit: 'm/s²' },
    phoneSteps,
    activity,                                  // 'reposo' | 'caminando' | 'corriendo' (detectada con el acelerómetro)
    synced: false,
    error: null
  };
}

export function validateMeasurement(m) {
  const errors = [];
  if (!m.userId) errors.push('userId requerido');
  if (!m.timestamp || isNaN(Date.parse(m.timestamp))) errors.push('timestamp inválido');
  if (!m.wearable && !m.gyroscope) errors.push('debe incluir wearable o giroscopio');
  return errors;
}

// Mismos límites que las anotaciones de MedicionRequest.java (@Min/@Max/@DecimalMin/@DecimalMax).
export const RANGOS = {
  frecuenciaCardiaca: [30, 220],
  temperatura: [30, 43],
  spo2: [0, 100],
  bateria: [0, 100]
};

// Contrato de POST /api/mediciones. Los campos del teléfono (giroscopio, fuente, fecha de captura)
// el backend actual los ignora; quedan listos para cuando la entidad Medicion tenga esas columnas.
export function toMedicionRequest(m) {
  const w = m.wearable ?? {};
  return {
    frecuenciaCardiaca: w.heartRate ?? null,
    temperatura: w.temperature ?? null,
    spo2: w.spo2 ?? null,
    pasos: w.steps ?? m.phoneSteps ?? 0,
    calorias: w.calories ?? 0,
    actividad: m.activity ?? 'reposo',
    bateria: w.battery ?? null,
    giroscopioX: m.gyroscope?.x ?? null,
    giroscopioY: m.gyroscope?.y ?? null,
    giroscopioZ: m.gyroscope?.z ?? null,
    fuente: m.source,
    fechaCaptura: m.timestamp,
    idLocal: m.id          // identificador estable: reenviar la misma lectura no la duplica en la base (D-02)
  };
}

// Validar antes de enviar (Práctica 6): lo que no pasa aquí lo rechazaría Spring Boot con 400.
// SpO₂ es opcional: un wearable BLE estándar no tiene servicio de oxigenación (CP-21). Si viene, se valida su rango;
// si no viene, la lectura se guarda sin ese dato (nunca como 0 %, que dispararía una alerta falsa).
export const OPCIONALES = ['spo2'];

export function validateMedicionRequest(r) {
  const errors = [];
  for (const [campo, [min, max]] of Object.entries(RANGOS)) {
    const v = r[campo];
    if (v == null && OPCIONALES.includes(campo)) continue;
    if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${campo} requerido`);
    else if (v < min || v > max) errors.push(`${campo} fuera de rango (${min}-${max})`);
  }
  for (const campo of ['frecuenciaCardiaca', 'spo2', 'bateria', 'pasos', 'calorias']) {
    // WB-D11 (P13-14): NaN/Infinity ya se reportan como requerido/inválido; aquí solo los decimales finitos
    if (Number.isFinite(r[campo]) && !Number.isInteger(r[campo])) errors.push(`${campo} debe ser entero`);
  }
  if (!(r.pasos >= 0)) errors.push('pasos inválido');
  if (!(r.calorias >= 0)) errors.push('calorias inválido');
  if (!r.actividad || !String(r.actividad).trim()) errors.push('actividad requerida');
  return errors;
}
