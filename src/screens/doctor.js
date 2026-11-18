// Pantalla del paciente: chat con el médico de guardia y botón SOS.
// Si se abre desde una alerta (#/doctor?alerta=1), manda primero qué está fuera de rango y los signos actuales.
import { mountChat } from './chat.js';
import { abrirSOS } from './sos.js';
import { api } from '../services/api.js';
import { getSession } from '../services/auth.js';
import { getState } from '../services/store.js';
import { evaluarAlertas } from '../models/alerts.js';
import { mensajeDeAlerta } from '../models/chat.js';
import { MOCK } from '../config.js';
import { textoEstado } from '../models/emergencia.js';
import { fmtDate, esc } from '../util.js';

export function mount(el, { user, params }) {
  el.innerHTML = `
    <section class="card sos-card">
      <div><span class="k">¿Es una emergencia?</span><strong>Pide ayuda de inmediato</strong>
        <p class="muted small" id="emg"></p></div>
      <button class="btn sos" id="sos">SOS</button>
    </section>
    ${MOCK ? '<p class="muted small">Modo simulado: responde un asistente automático que no receta medicamentos. Con la base compartida contesta el médico real desde su dispositivo.</p>' : ''}
    <div id="chat"></div>`;

  const w = getState().wearable;
  const alertas = evaluarAlertas(w.connected ? w : null);
  const inicial = params.get('alerta') && alertas.length ? mensajeDeAlerta(alertas, w) : null;
  if (params.get('alerta')) history.replaceState(null, '', '#/doctor');   // al recargar no se reenvía

  const estado = async () => {
    try {
      const [e] = await api.emergencias(getSession().token);
      el.querySelector('#emg').innerHTML = e
        ? `Último SOS: ${fmtDate(e.fecha)} · <b>${esc(textoEstado(e))}</b>`
        : '';
    } catch { /* el chat ya muestra el error de conexión */ }
  };
  el.querySelector('#sos').addEventListener('click', () => abrirSOS({ onEnviada: estado }));

  const offChat = mountChat(el.querySelector('#chat'), { pacienteId: user.id, user, titulo: 'Médico de guardia', mensajeInicial: inicial });
  estado();
  const timer = setInterval(estado, 5000);
  return () => { offChat(); clearInterval(timer); };
}
