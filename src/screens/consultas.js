// Pantalla del doctor (y del administrador): bandeja de pacientes con SOS y chat con cada uno.
// #/consultas -> lista · #/consultas?p=ID -> conversación con el paciente ID.
import { mountChat } from './chat.js';
import { api } from '../services/api.js';
import { getSession, expireSession } from '../services/auth.js';
import { toast } from '../services/toast.js';
import { MSG } from '../config.js';
import { ESTADO_SOS, textoEstado, signosDe, mensajeAmbulancia } from '../models/emergencia.js';
import { esc, fmtHora, fmtDate } from '../util.js';

const token = () => getSession()?.token;

export function mount(el, { user, params }) {
  const p = params.get('p');   // id de paciente (número con Spring Boot, UID con Firebase)
  return p ? conversacion(el, user, p) : bandeja(el);
}

function bandeja(el) {
  el.innerHTML = `
    <p class="muted small">Pacientes asignados al médico de guardia. Los que pidieron ayuda aparecen primero.</p>
    <p class="error small" id="err" hidden></p>
    <ul class="list" id="ls"></ul>`;
  const cargar = async () => {
    try {
      const lista = await api.conversaciones(token());
      el.querySelector('#err').hidden = true;
      el.querySelector('#ls').innerHTML = lista.map((c) => `
        <li class="conv ${c.emergenciaAbierta ? 'urgente' : ''}"><a href="#/consultas?p=${c.pacienteId}">
          <div><b>${esc(c.paciente)}</b>
            <span class="muted small">${c.ultimoMensaje ? esc(c.ultimoMensaje.slice(0, 70)) : 'Sin mensajes'}</span></div>
          <span class="lado">${c.emergenciaAbierta ? `<span class="tag bad">${c.emergenciaAbierta.estado === ESTADO_SOS.ABIERTA ? 'SOS en recepción' : 'SOS'}</span>` : ''}
            <span class="muted small">${c.fecha ? fmtHora(c.fecha) : ''}</span>
            <span class="muted small">${c.mensajes} msj.</span></span>
        </a></li>`).join('') || '<li class="muted">No hay pacientes registrados.</li>';
    } catch (e) {
      if (e.status === 401) return expireSession();
      el.querySelector('#err').textContent = MSG.error; el.querySelector('#err').hidden = false;
    }
  };
  cargar();
  const timer = setInterval(cargar, 4000);
  return () => clearInterval(timer);
}

function conversacion(el, user, pacienteId) {
  el.innerHTML = `
    <a href="#/consultas" class="btn-link volver">← Consultas</a>
    <section class="card urgente" id="emg" hidden></section>
    <section class="card" id="med" hidden></section>
    <section class="card sos-card" id="amb">
      <div><span class="k">¿Necesita traslado urgente?</span><strong>Solicitar una ambulancia</strong>
        <p class="muted small" id="amb-msg">El paciente recibe el aviso en este chat (simulación).</p></div>
      <button class="btn sos" id="ambulancia" type="button" aria-label="Solicitar ambulancia">🚑</button>
    </section>
    <div id="chat"></div>`;
  let offChat = () => {}, sosActual = null, nombrePaciente = 'el paciente';

  const emergencia = async () => {
    try {
      const c = (await api.conversaciones(token())).find((x) => String(x.pacienteId) === String(pacienteId));
      if (!c) { el.querySelector('#chat').innerHTML = '<p class="error">El paciente no existe.</p>'; return null; }
      const e = c.emergenciaAbierta, box = el.querySelector('#emg');
      sosActual = e; nombrePaciente = c.paciente;
      box.hidden = !e;
      if (e) {
        const signos = signosDe(e);
        // El doctor atiende lo que recepción le canalizó; mientras siga en recepción solo se informa.
        const puedeAtender = e.estado === ESTADO_SOS.CANALIZADA && (user.rol === 'admin' || String(e.canalizadaA) === String(user.id));
        box.innerHTML = `
          <span class="k">SOS abierto desde ${fmtDate(e.fecha)}</span>
          <strong>${signos || 'Sin signos del wearable'}</strong>
          ${e.latitud != null ? `<a class="btn-link" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${e.latitud},${e.longitud}">Ver ubicación en el mapa</a>` : '<span class="muted small">Ubicación no disponible</span>'}
          <span class="small">${esc(textoEstado(e))}${e.estado === ESTADO_SOS.ABIERTA ? ' · esperando que recepción lo canalice' : ''}</span>
          ${puedeAtender ? '<button class="btn sos" id="atender">Marcar como atendida</button>' : ''}`;
        box.querySelector('#atender')?.addEventListener('click', async () => {
          try { await api.atenderEmergencia(e.id, token()); toast('Emergencia marcada como atendida', { tipo: 'ok' }); emergencia(); }
          catch { toast(MSG.error, { tipo: 'alerta' }); }
        });
      }
      medicion();
      return c;
    } catch (err) {
      if (err.status === 401) expireSession();
      return null;
    }
  };

  // Última lectura que el paciente guardó en la base (signos del wearable y pasos del teléfono).
  const medicion = async () => {
    if (!api.ultimaMedicion) return;
    try {
      const m = await api.ultimaMedicion(pacienteId, token()), box = el.querySelector('#med');
      box.hidden = !m;
      if (m) box.innerHTML = `<span class="k">Última medición · ${fmtDate(m.fecha)}</span>
        <strong id="med-signos">FC ${m.frecuenciaCardiaca} bpm · SpO₂ ${m.spo2} % · ${m.temperatura} °C</strong>
        <span class="muted small">${m.pasos} pasos · ${esc(m.actividad)}${m.alertas?.length ? ` · <b>${esc(m.alertas.join(', '))}</b>` : ''}</span>`;
    } catch { /* sin permiso o sin conexión: no se muestra */ }
  };

  // Ambulancia simulada: el doctor la pide desde el chat y al paciente le llega el aviso de que va en camino.
  el.querySelector('#ambulancia').addEventListener('click', async (ev) => {
    if (!confirm(`¿Solicitar una ambulancia para ${nombrePaciente}?`)) return;
    const btn = ev.currentTarget, msg = el.querySelector('#amb-msg');
    btn.disabled = true;
    try {
      await api.enviarMensaje(pacienteId, mensajeAmbulancia(user.nombre, sosActual), token());
      msg.textContent = `Ambulancia solicitada a las ${fmtHora(new Date())}. El paciente ya fue avisado en el chat.`;
      toast('Ambulancia en camino (simulación)', { tipo: 'alerta' });
    } catch (e) {
      if (e.status === 401) return expireSession();
      msg.textContent = 'No se pudo avisar al paciente. Revisa la conexión e inténtalo de nuevo.';
    } finally { setTimeout(() => { btn.disabled = false; }, 5000); }
  });

  let vivo = true;   // si se sale antes de que responda el servidor, no se monta el chat
  emergencia().then((c) => {
    if (c && vivo) offChat = mountChat(el.querySelector('#chat'), { pacienteId, user, titulo: c.paciente });
  });
  const timer = setInterval(emergencia, 5000);
  return () => { vivo = false; offChat(); clearInterval(timer); };
}
