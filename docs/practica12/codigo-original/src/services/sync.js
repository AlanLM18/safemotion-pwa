// VERSIÓN ORIGINAL (antes de la Práctica 12). La versión optimizada está en src/services/sync.js.
// Envío de mediciones pendientes (cola local en IndexedDB) hacia POST /api/mediciones.
import { measurementsDao } from './db.js';
import { api } from './api.js';
import { getSession, expireSession } from './auth.js';
import { toMedicionRequest, validateMedicionRequest } from '../models/measurement.js';

let enCurso = null;

// Una sola sincronización a la vez: el monitoreo automático y el botón de Historial comparten esta función.
export function enviarPendientes() {
  enCurso ??= sincronizar().finally(() => { enCurso = null; });
  return enCurso;
}

async function sincronizar() {
  const session = getSession();
  if (!session) throw new Error('Sin sesión');
  // Solo las lecturas de quien tiene la sesión: en un teléfono compartido no se envían las de otro usuario (D-01).
  const pendientes = (await measurementsDao.obtenerPendientes(session.user.id)).filter((m) => String(m.userId) === String(session.user.id));
  const r = { total: pendientes.length, enviadas: 0, rechazadas: 0 };
  for (const m of pendientes) {
    const req = toMedicionRequest(m);
    const errores = validateMedicionRequest(req);
    if (errores.length) {
      // No se envía lo que el servidor rechazaría (p. ej. lectura solo del teléfono, sin datos del wearable).
      await measurementsDao.actualizar({ ...m, error: errores[0] });
      r.rechazadas++;
      continue;
    }
    try {
      const guardada = await api.enviarMedicion(req, session.token);
      await measurementsDao.actualizar({ ...m, synced: true, serverId: guardada?.id ?? null });
      r.enviadas++;
    } catch (e) {
      if (e.status === 401) { expireSession(); throw e; }
      if (e.status === 400) { await measurementsDao.actualizar({ ...m, error: 'Rechazada por el servidor (400)' }); r.rechazadas++; continue; }
      throw e;   // sin red o servidor caído: se detiene y lo pendiente queda para el siguiente intento
    }
  }
  return r;
}
