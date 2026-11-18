import { api } from '../services/api.js';
import { MSG, MOCK, API_BASE_URL, FIREBASE } from '../config.js';
import { getState, subscribe } from '../services/store.js';
import { measurementsDao } from '../services/db.js';
import * as monitor from '../services/monitor.js';
import { evaluarAlertas } from '../models/alerts.js';
import { abrirSOS } from './sos.js';
import { esc, fmtDate } from '../util.js';

export function mount(el, { user }) {
  el.innerHTML = `
    <p class="hello">Hola, ${esc(user.nombre)}</p>
    <div id="alert" class="banner" role="status" hidden></div>
    ${user.rol === 'usuario' ? `<div class="acciones" id="alert-acc" hidden>
      <a class="btn" href="#/doctor?alerta=1">Hablar con un doctor</a>
      <button class="btn sos" id="sos" type="button">SOS</button>
    </div>` : ''}
    <section class="grid">
      <div class="tile"><span class="k">Wearable</span><strong id="wr">--</strong></div>
      <div class="tile"><span class="k">Actividad</span><strong id="act">--</strong></div>
      <div class="tile"><span class="k">Lecturas locales</span><strong id="n">--</strong></div>
      <div class="tile"><span class="k">Servidor</span><strong id="srv">${MOCK ? 'Modo simulado' : 'Sin consultar'}</strong></div>
    </section>
    <section class="card">
      <span class="k">Monitoreo automático</span>
      <strong class="big" id="mst">--</strong>
      <p class="muted small" id="mres" aria-live="polite"></p>
      <button class="btn" id="mon"></button>
    </section>
    <button class="btn ghost" id="chk">Consultar información</button>
    <p class="muted small" id="out" aria-live="polite">${FIREBASE ? `Firebase · proyecto ${esc(FIREBASE.projectId)}` : MOCK ? 'Sin URL' : esc(API_BASE_URL)}</p>`;
  const $ = (id) => el.querySelector('#' + id);
  const contar = () => measurementsDao.obtenerTodos(user.id).then((l) => { $('n').textContent = l.length; });

  const paint = () => {
    const { wearable: w, gyro, activity, monitor: m } = getState();
    $('wr').textContent = w.connected ? (w.simulated ? 'Simulado' : 'Conectado') : 'Sin conectar';
    $('act').textContent = gyro.running ? activity.current : 'Sensores apagados';
    $('mst').textContent = m.running ? 'Activo · cada 5 s' : 'Detenido';
    $('mres').textContent = [m.lastResult, m.lastSync && `Último envío: ${fmtDate(m.lastSync)}`].filter(Boolean).join(' · ');
    $('mon').textContent = m.running ? 'Detener monitoreo' : 'Iniciar monitoreo';
    const alertas = evaluarAlertas(w.connected ? w : null);
    $('alert').hidden = !alertas.length;
    $('alert').textContent = alertas.map((a) => a.tipo).join(' · ');
    if ($('alert-acc')) $('alert-acc').hidden = !alertas.length;
  };

  $('sos')?.addEventListener('click', () => abrirSOS());

  $('mon').addEventListener('click', () => (monitor.isRunning() ? monitor.stop() : monitor.start()));
  $('chk').addEventListener('click', async () => {
    const out = $('out'), srv = $('srv');
    out.textContent = MSG.loading; out.className = 'muted small';
    try {
      const r = await api.estado();
      srv.textContent = 'Disponible';
      out.textContent = r.usuariosConectados == null ? `Conectado a ${r.baseDatos}.`
        : `Servidor disponible · ${r.usuariosConectados} sesión(es) · ${r.wearablesActivos} wearable(s) activo(s) · ${r.alertasTotales} alerta(s).`;
    } catch { srv.textContent = 'Sin conexión'; out.textContent = MSG.error; out.className = 'error small'; }
  });

  contar(); paint();
  return subscribe((k) => {
    if (['wearable', 'gyro', 'activity', 'monitor'].includes(k)) paint();
    if (k === 'monitor') contar();
  });
}
