// Ventana de confirmación del SOS (se usa en Inicio y en Doctor).
import { pedirAyuda } from '../services/sos.js';
import { toast } from '../services/toast.js';
import { MOCK, MSG } from '../config.js';
import { fmtDate } from '../util.js';

export function abrirSOS({ onEnviada } = {}) {
  const d = document.createElement('dialog');
  d.className = 'sos-dialog';
  d.innerHTML = `
    <h2>¿Pedir ayuda de emergencia?</h2>
    <p>Recepción recibirá tu ubicación y tus últimos signos vitales y te canalizará con el médico de guardia.</p>
    ${MOCK ? '<p class="error small">Modo simulado: no se avisa a ningún servicio real.</p>' : ''}
    <button class="btn sos" id="ok">Enviar SOS</button>
    <a class="btn ghost" href="tel:911">Llamar al 911</a>
    <button class="btn ghost" id="no">Cancelar</button>
    <p class="small" id="st" aria-live="assertive"></p>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  const ok = d.querySelector('#ok'), st = d.querySelector('#st');
  d.querySelector('#no').addEventListener('click', () => d.close());
  let enviada = false;
  ok.addEventListener('click', async () => {
    if (enviada) { d.close(); location.hash = '/doctor'; return; }   // segundo clic: "Ir al chat"
    ok.disabled = true; st.className = 'small'; st.textContent = 'Enviando...';
    try {
      const e = await pedirAyuda();
      st.textContent = e.duplicada
        ? `Ya tienes una solicitud abierta desde ${fmtDate(e.fecha)}. Recepción ya fue avisada.`
        : `Ayuda solicitada: recepción ya la recibió. ${e.latitud != null ? 'Ubicación enviada.' : 'Ubicación no disponible.'}`;
      toast(e.duplicada ? 'Tu SOS sigue abierto' : 'SOS enviado a recepción', { tipo: 'alerta' });
      enviada = true;
      ok.textContent = 'Ir al chat';
      ok.disabled = false;
      onEnviada?.(e);
    } catch {
      st.className = 'error small';
      st.textContent = `${MSG.error} Si es una emergencia, llama al 911.`;
      ok.disabled = false;
    }
  });
  d.showModal();
  return d;
}
