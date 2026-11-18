// VERSIÓN ORIGINAL (antes de la Práctica 12). La versión optimizada está en src/screens/historial.js.
import { measurementsDao } from '../services/db.js';
import { enviarPendientes } from '../services/sync.js';
import { subscribe } from '../services/store.js';
import { getSession } from '../services/auth.js';
import { MSG } from '../config.js';
import { fmt, fmtDate, esc } from '../util.js';

const resumen = (m) => [
  m.wearable && `FC ${m.wearable.heartRate ?? '--'} · SpO₂ ${m.wearable.spo2 ?? '--'} · ${m.wearable.temperature ?? '--'} °C`,
  m.gyroscope && `Gir. X ${fmt(m.gyroscope.x)} Y ${fmt(m.gyroscope.y)} Z ${fmt(m.gyroscope.z)}`,
  m.activity && m.gyroscope && m.activity,
  m.phoneSteps != null && `${m.phoneSteps} pasos`
].filter(Boolean).join(' · ');

const etiqueta = (m) => m.synced ? ['ok', 'Enviada'] : m.error ? ['bad', 'Rechazada'] : ['', 'Pendiente'];

export function mount(el) {
  el.innerHTML = `
    <button class="btn" id="sync">Enviar pendientes</button>
    <p class="muted small" id="msg" aria-live="polite"></p>
    <ul class="list" id="ls"></ul>`;
  const ls = el.querySelector('#ls'), msg = el.querySelector('#msg');
  const load = async () => {
    const all = await measurementsDao.obtenerTodos(getSession()?.user.id);   // solo las del usuario en sesión (D-01)
    ls.innerHTML = all.length ? all.map((m) => {
      const [cls, txt] = etiqueta(m);
      return `
      <li><div><b>${fmtDate(m.timestamp)}</b>
        <span class="muted small">${esc(m.source)} · ${esc(resumen(m))}</span>
        ${m.error ? `<span class="error small">${esc(m.error)}</span>` : ''}</div>
        <span class="tag ${cls}">${txt}</span>
        <button class="del" data-id="${m.id}" aria-label="Eliminar lectura">×</button></li>`;
    }).join('')
      : '<li class="muted">Aún no hay lecturas. Guarda una desde Wearable o inicia el monitoreo.</li>';
  };
  ls.addEventListener('click', async (e) => {
    const id = e.target.dataset?.id; if (!id) return;
    await measurementsDao.eliminar(id); load();
  });
  el.querySelector('#sync').addEventListener('click', async () => {
    msg.textContent = MSG.loading; msg.className = 'muted small';
    try {
      const r = await enviarPendientes();
      msg.textContent = r.total ? `${r.enviadas} enviada(s), ${r.rechazadas} rechazada(s).` : 'No hay lecturas pendientes.';
    } catch { msg.textContent = MSG.error; msg.className = 'error small'; }
    load();
  });
  load();
  return subscribe((k) => k === 'monitor' && load());
}
