// Reglas del chat paciente-médico (Prácticas 6 y 7). Mismo límite que MensajeRequest.java (@NotBlank, @Size(max = 500)).
export const MAX_MENSAJE = 500;

export function validarMensaje(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return { ok: false, error: 'Escribe un mensaje antes de enviarlo.' };
  if (t.length > MAX_MENSAJE) return { ok: false, error: `El mensaje no puede pasar de ${MAX_MENSAJE} caracteres.` };
  return { ok: true, texto: t };
}

// Contador de mensajes por emisor, en el orden en que aparecen.
export function contarPorAutor(mensajes) {
  const conteo = new Map();
  for (const m of mensajes) conteo.set(m.autor, (conteo.get(m.autor) ?? 0) + 1);
  return [...conteo].map(([autor, total]) => ({ autor, total }));
}

// Primer mensaje que se manda al abrir el chat desde una alerta: qué está fuera de rango y los signos actuales.
export function mensajeDeAlerta(alertas, w) {
  const signos = [
    w?.heartRate != null && `FC ${w.heartRate} bpm`,
    w?.spo2 != null && `SpO2 ${w.spo2} %`,
    w?.temperature != null && `temperatura ${w.temperature} °C`
  ].filter(Boolean).join(', ');
  const tipos = alertas.map((a) => a.tipo.toLowerCase()).join(', ');
  return `Tengo una alerta: ${tipos}.${signos ? ` Mis signos ahora: ${signos}.` : ''} ¿Qué hago mientras llego a consulta?`;
}

// Datos de una emergencia a partir de los últimos signos del wearable (lo que falte se manda vacío).
export function datosEmergencia(w, pos) {
  return {
    latitud: pos?.latitude ?? null,
    longitud: pos?.longitude ?? null,
    frecuenciaCardiaca: w?.heartRate ?? null,
    spo2: w?.spo2 ?? null,
    temperatura: w?.temperature ?? null
  };
}
