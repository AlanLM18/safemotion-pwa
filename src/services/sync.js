// Envío de mediciones pendientes (cola local en IndexedDB) hacia POST /api/mediciones.
import { measurementsDao } from './db.js';
import { api } from './api.js';
import { getSession, expireSession } from './auth.js';
import { toMedicionRequest, validateMedicionRequest } from '../models/measurement.js';

let enCurso = null;
// Práctica 12: antes se enviaba una lectura tras otra (await dentro del ciclo); 100 pendientes tardaban ≈ 2,5 s.
// Ahora hasta 4 envíos van en paralelo. Cada lectura sigue siendo idempotente (idLocal = ID del documento).
export const CONCURRENCIA = 4;

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
  let siguiente = 0, error = null;

  async function enviarUna(m) {
    const req = toMedicionRequest(m);
    const errores = validateMedicionRequest(req);
    if (errores.length) {
      // No se envía lo que el servidor rechazaría (p. ej. lectura solo del teléfono, sin datos del wearable).
      await measurementsDao.actualizar({ ...m, error: errores[0] });
      r.rechazadas++;
      return;
    }
    try {
      const guardada = await api.enviarMedicion(req, session.token);
      await measurementsDao.actualizar({ ...m, synced: true, serverId: guardada?.id ?? null });
      r.enviadas++;
    } catch (e) {
      if (e.status === 400) { await measurementsDao.actualizar({ ...m, error: 'Rechazada por el servidor (400)' }); r.rechazadas++; return; }
      throw e;   // 401, sin red o servidor caído
    }
  }
  // Grupo de trabajadores: cada uno toma la siguiente lectura. Al primer error grave (401, sin red, 5xx) ninguno
  // toma más lecturas; lo que ya estaba en vuelo termina y lo demás queda pendiente para el siguiente intento.
  const trabajador = async () => {
    while (!error && siguiente < pendientes.length) {
      const m = pendientes[siguiente++];
      try { await enviarUna(m); } catch (e) { error ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, pendientes.length) }, trabajador));
  if (error) {
    if (error.status === 401) expireSession();
    throw error;
  }
  return r;
}
