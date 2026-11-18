// Botón SOS: manda al médico de guardia la ubicación (si el usuario la permite) y los últimos signos vitales.
// La app no llama a una ambulancia por sí sola; por eso la pantalla también ofrece llamar al 911.
import { api } from './api.js';
import { getSession, expireSession } from './auth.js';
import { getState } from './store.js';
import { datosEmergencia } from '../models/chat.js';

function ubicacion(timeout = 5000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60_000 });
  });
}

export async function pedirAyuda() {
  const s = getSession();
  if (!s) throw new Error('Sin sesión');
  const pos = await ubicacion();
  const w = getState().wearable;
  try {
    const e = await api.crearEmergencia(datosEmergencia(w.connected ? w : null, pos), s.token);
    navigator.vibrate?.(400);
    return e;
  } catch (err) {
    if (err.status === 401) expireSession();
    throw err;
  }
}
