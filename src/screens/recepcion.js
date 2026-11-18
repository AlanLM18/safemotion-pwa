// Recepción: recibe primero los SOS de los pacientes y los canaliza al doctor de guardia, que después los atiende.
// No ve datos clínicos (mediciones ni chat): solo la solicitud de ayuda con sus signos y ubicación.
import { api } from '../services/api.js';
import { getSession, expireSession } from '../services/auth.js';
import { toast } from '../services/toast.js';
import { MSG } from '../config.js';
import { ESTADO_SOS, textoEstado, ordenarParaRecepcion, signosDe } from '../models/emergencia.js';
import { esc, fmtDate } from '../util.js';

const POLL_MS = 3000;
const token = () => getSession()?.token;

export function mount(el) {
  el.innerHTML = `
    <p class="muted small" id="resumen">Solicitudes de ayuda de los pacientes. Canaliza cada una con un doctor.</p>
    <p class="error small" id="err" role="alert" hidden></p>
    <ul class="list" id="ls"></ul>`;
  const err = el.querySelector('#err'), ls = el.querySelector('#ls');
  let doctores = [];
  const elegidos = new Map();   // doctor seleccionado en cada SOS (no se pierde con la actualización periódica)

  const tarjeta = (e) => {
    const abierta = e.estado === ESTADO_SOS.ABIERTA;
    return `
      <li class="sos-item ${abierta ? 'urgente' : ''}" data-id="${esc(e.id)}">
        <div>
          <b>${esc(e.paciente)}</b>
          <span class="muted small">SOS ${fmtDate(e.fecha)} · ${esc(signosDe(e) || 'Sin signos del wearable')}</span>
          ${e.latitud != null ? `<a class="btn-link" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${e.latitud},${e.longitud}">Ver ubicación</a>` : '<span class="muted small">Ubicación no disponible</span>'}
          <span class="small estado">${esc(textoEstado(e))}${e.canalizadaPorNombre ? ` · canalizó ${esc(e.canalizadaPorNombre)}` : ''}</span>
          ${abierta ? `
          <div class="canalizar">
            <select aria-label="Doctor para ${esc(e.paciente)}">${doctores.map((d) => `<option value="${esc(d.id)}"${String(elegidos.get(String(e.id))) === String(d.id) ? ' selected' : ''}>${esc(d.nombre)}</option>`).join('')}</select>
            <button class="btn sos" type="button" data-canalizar="${esc(e.id)}">Canalizar</button>
          </div>` : ''}
        </div>
        <span class="tag ${abierta ? 'bad' : e.estado === ESTADO_SOS.ATENDIDA ? 'ok' : 'proc'}">${abierta ? 'Nuevo' : e.estado === ESTADO_SOS.ATENDIDA ? 'Atendido' : 'Canalizado'}</span>
      </li>`;
  };

  const cargar = async () => {
    try {
      if (!doctores.length) doctores = await api.doctores(token());
      const lista = ordenarParaRecepcion(await api.emergencias(token()));
      err.hidden = true;
      const pendientes = lista.filter((e) => e.estado === ESTADO_SOS.ABIERTA).length;
      el.querySelector('#resumen').textContent = pendientes ? `${pendientes} SOS por canalizar.` : 'No hay SOS pendientes de canalizar.';
      ls.innerHTML = lista.map(tarjeta).join('') || '<li class="muted">Aún no hay solicitudes de ayuda.</li>';
    } catch (e) {
      if (e.status === 401) return expireSession();
      err.textContent = e.status === 403 ? 'Tu cuenta no tiene permiso de recepción.' : 'Sin conexión con la base: se muestra la última lista recibida.';
      err.hidden = false;
    }
  };

  ls.addEventListener('change', (e) => { const li = e.target.closest('li'); if (li && e.target.tagName === 'SELECT') elegidos.set(li.dataset.id, e.target.value); });
  ls.addEventListener('click', async (e) => {
    const id = e.target.dataset?.canalizar;
    if (!id) return;
    const doctorId = e.target.closest('li').querySelector('select').value;
    e.target.disabled = true; e.target.textContent = 'Canalizando…';
    try {
      const r = await api.canalizarEmergencia(id, doctorId, token());
      toast(`SOS de ${r.paciente} canalizado con ${r.canalizadaANombre}`, { tipo: 'ok' });
    } catch (ex) {
      if (ex.status === 401) return expireSession();
      // Otra recepcionista lo canalizó primero: se avisa con quién quedó y no se sobrescribe.
      const actual = ex.datos?.actual;
      toast(ex.status === 409 && actual ? `Ya lo había canalizado ${actual.canalizadaPorNombre ?? actual.canalizadaPor ?? 'otra recepcionista'}: ${textoEstado(actual)}.`
        : ex.status === 0 ? 'Sin conexión: el SOS no se canalizó. Intenta de nuevo.' : ex.status === 403 ? 'No tienes permiso para canalizar.' : MSG.error, { tipo: 'alerta', ms: 6000 });
    }
    cargar();
  });

  cargar();
  const timer = setInterval(cargar, POLL_MS);
  return () => clearInterval(timer);
}
