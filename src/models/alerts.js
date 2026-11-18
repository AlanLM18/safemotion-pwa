// Mismos umbrales que MedicionService.java usa para generar alertas en el servidor.
// La app los evalúa localmente para avisar al usuario sin esperar al backend.
export const UMBRALES = { fcMax: 110, fcMin: 45, tempMax: 37.8, spo2Min: 92 };

export function evaluarAlertas(w) {
  const alertas = [];
  if (!w) return alertas;
  if (w.heartRate != null && w.heartRate > UMBRALES.fcMax) alertas.push({ campo: 'heartRate', tipo: 'Frecuencia cardiaca alta' });
  if (w.heartRate != null && w.heartRate < UMBRALES.fcMin) alertas.push({ campo: 'heartRate', tipo: 'Frecuencia cardiaca baja' });
  if (w.temperature != null && w.temperature > UMBRALES.tempMax) alertas.push({ campo: 'temperature', tipo: 'Temperatura elevada' });
  if (w.spo2 != null && w.spo2 < UMBRALES.spo2Min) alertas.push({ campo: 'spo2', tipo: 'Saturación de oxígeno baja' });
  return alertas;
}
