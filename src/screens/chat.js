// Conversación de un paciente con el personal médico (la usan Doctor y Consultas).
// Requisitos de las Prácticas 6 y 7: emisor y hora en cada mensaje, contador por emisor,
// no enviar mensajes vacíos, aviso visual al enviar y botón para limpiar el historial.
import { api } from '../services/api.js';
import { getSession, expireSession } from '../services/auth.js';
import { toast } from '../services/toast.js';
import { validarMensaje, contarPorAutor, MAX_MENSAJE } from '../models/chat.js';
import { esMensajeAmbulancia } from '../models/emergencia.js';
import { esc, fmtHora } from '../util.js';

const POLL_MS = 3000;
const ETIQUETA = { doctor: 'Médico', admin: 'Administrador', asistente: 'Automático', usuario: 'Paciente', recepcionista: 'Recepción' };

export function mountChat(el, { pacienteId, user, titulo, mensajeInicial = null }) {
  el.innerHTML = `
    <section class="chat">
      <div class="chat-head">
        <div><strong>${esc(titulo)}</strong><span class="muted small" id="cnt"></span></div>
        <button class="btn-link" id="clr" type="button">Limpiar historial</button>
      </div>
      <ul class="msgs" id="msgs" aria-live="polite"></ul>
      <p class="error small" id="err" role="alert" hidden></p>
      <form class="chat-form" id="f" novalidate>
        <input id="txt" maxlength="${MAX_MENSAJE}" placeholder="Escribe un mensaje" autocomplete="off" aria-label="Mensaje" />
        <button class="btn" id="send">Enviar</button>
      </form>
    </section>`;
  const $ = (id) => el.querySelector('#' + id);
  const token = () => getSession()?.token;
  let vistos = -1, timer = null, errorEnvio = false;   // el aviso de envío fallido no lo tapa la consulta periódica

  const fallo = (e) => {
    if (e.status === 401) { expireSession(); return; }
    if (errorEnvio) return;
    $('err').textContent = e.status === 403 ? 'No tienes permiso para ver esta conversación.'
      : e.status === 404 ? 'La conversación no existe.' : 'Sin conexión con el servidor. Se reintentará.';
    $('err').hidden = false;
  };

  const pintar = (lista) => {
    if (!errorEnvio) $('err').hidden = true;
    $('cnt').textContent = lista.length ? ' · ' + contarPorAutor(lista).map((c) => `${c.autor}: ${c.total}`).join(' · ') : '';
    $('msgs').innerHTML = lista.length ? lista.map((m) => `
      <li class="msg ${m.autorId === user.id ? 'mio' : ''} ${m.rol === 'asistente' ? 'auto' : ''} ${/^SOS:/.test(m.texto) ? 'sos' : ''} ${esMensajeAmbulancia(m.texto) ? 'ambulancia' : ''}">
        <span class="meta">${esc(m.autor)} · ${ETIQUETA[m.rol] ?? ''} · ${fmtHora(m.fecha)}</span>
        <span class="txt">${esc(m.texto)}</span>
      </li>`).join('')
      : '<li class="muted small vacio">Aún no hay mensajes. Escribe para hablar con el médico.</li>';
    if (lista.length !== vistos) $('msgs').lastElementChild?.scrollIntoView({ block: 'end' });
    vistos = lista.length;
  };

  const cargar = async () => {
    try { pintar(await api.mensajes(pacienteId, token())); } catch (e) { fallo(e); }
  };

  const enviar = async (texto) => {
    const v = validarMensaje(texto);
    if (!v.ok) { $('err').textContent = v.error; $('err').hidden = false; $('txt').focus(); return false; }
    $('send').disabled = true;
    try {
      await api.enviarMensaje(pacienteId, v.texto, token());
      errorEnvio = false; $('err').hidden = true;
      toast('Mensaje enviado', { tipo: 'ok' });
      await cargar();
      return true;
    } catch (e) {
      if (e.status === 401) { expireSession(); return false; }
      errorEnvio = true;
      $('err').textContent = 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.';   // el texto se conserva
      $('err').hidden = false;
      return false;
    } finally {
      $('send').disabled = false;
    }
  };

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await enviar($('txt').value)) $('txt').value = '';
  });
  $('clr').addEventListener('click', async () => {
    if (!confirm('¿Borrar todos los mensajes de esta conversación?')) return;
    try { await api.limpiarChat(pacienteId, token()); toast('Historial limpiado'); vistos = -1; await cargar(); } catch (e) { fallo(e); }
  });

  cargar().then(() => mensajeInicial && enviar(mensajeInicial));
  timer = setInterval(cargar, POLL_MS);   // los mensajes del otro dispositivo llegan por consulta periódica
  return () => clearInterval(timer);
}
