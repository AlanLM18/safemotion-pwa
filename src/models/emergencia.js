// SOS del paciente: primero lo recibe recepción, que lo canaliza al doctor de guardia, y el doctor lo atiende.
// ABIERTA -> CANALIZADA -> ATENDIDA. Cada cambio sube "version" (sirve para detectar cambios simultáneos).
export const ESTADO_SOS = { ABIERTA: 'ABIERTA', CANALIZADA: 'CANALIZADA', ATENDIDA: 'ATENDIDA' };

export function textoEstado(e) {
  if (!e) return '';
  if (e.estado === ESTADO_SOS.ABIERTA) return 'Recibido en recepción';
  if (e.estado === ESTADO_SOS.CANALIZADA) return `Canalizado con ${e.canalizadaANombre}`;
  return `Atendido por ${e.atendidaPor}`;
}

export const mensajeCanalizada = (doctor) => `Recepción canalizó tu solicitud de ayuda con ${doctor}. En un momento te atiende.`;

// El doctor pide una ambulancia desde el chat. Es una simulación: no se avisa a ningún servicio real.
export const PREFIJO_AMBULANCIA = '🚑 AMBULANCIA EN CAMINO';
export function mensajeAmbulancia(doctor, sos = null, minutos = 10) {
  const destino = sos?.latitud != null ? `a la ubicación de tu SOS (${sos.latitud.toFixed(4)}, ${sos.longitud.toFixed(4)})` : 'a tu domicilio registrado';
  return `${PREFIJO_AMBULANCIA} · ${doctor} solicitó una ambulancia; va ${destino}. Llegada estimada: ${minutos} min. `
    + 'Mantén la calma, no te muevas si te sientes mal y quédate en este chat. (Simulación: no se avisó a ningún servicio real.)';
}
export const esMensajeAmbulancia = (texto) => String(texto ?? '').startsWith(PREFIJO_AMBULANCIA);
export const mensajeAtendida = (doctor) => `Tu solicitud de ayuda fue atendida por ${doctor}. Mantente en este chat.`;

// Recepción ve primero lo pendiente de canalizar, luego lo canalizado y al final lo atendido; dentro, lo más reciente.
export function ordenarParaRecepcion(lista) {
  const peso = { ABIERTA: 0, CANALIZADA: 1, ATENDIDA: 2 };
  return [...lista].sort((a, b) => peso[a.estado] - peso[b.estado] || String(b.fecha).localeCompare(String(a.fecha)));
}

// Signos que acompañan al SOS, en una sola línea (lo que no mandó el wearable no aparece).
export const signosDe = (e) => [
  e.frecuenciaCardiaca != null && `FC ${e.frecuenciaCardiaca} bpm`,
  e.spo2 != null && `SpO₂ ${e.spo2} %`,
  e.temperatura != null && `${e.temperatura} °C`
].filter(Boolean).join(' · ');
