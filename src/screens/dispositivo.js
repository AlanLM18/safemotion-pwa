// Wearable: conexión BLE o wearable simulado, signos vitales y pasos. Al usar el wearable simulado se encienden
// también los sensores del teléfono (acelerómetro y giroscopio) y los pasos salen del acelerómetro.
import { connect, disconnect, isSupported, GATT } from '../services/ble.js';
import * as sim from '../services/wearableSim.js';
import * as gyro from '../services/gyro.js';
import * as monitor from '../services/monitor.js';
import { measurementsDao } from '../services/db.js';
import { getState, subscribe } from '../services/store.js';
import { evaluarAlertas } from '../models/alerts.js';
import { esc, fmt } from '../util.js';

const LABEL = { idle: 'Sin conexión', connecting: 'Conectando...', connected: 'Conectado', disconnected: 'Se perdió la conexión', error: 'No se pudo conectar' };

export function mount(el) {
  el.innerHTML = `
    <section class="card">
      <span class="k">Estado BLE</span><strong class="big" id="st"></strong>
      <p class="muted small" id="dn"></p>
      <button class="btn" id="bt"></button>
      ${isSupported() ? '' : '<p class="error small">Este navegador no soporta Web Bluetooth. Usa Chrome en Android o escritorio.</p>'}
    </section>
    <section class="card">
      <span class="k">Wearable simulado (sin hardware)</span>
      <label class="row">Escenario
        <select id="esc">${Object.keys(sim.ESCENARIOS).map((e) => `<option value="${e}">${e}</option>`).join('')}</select>
      </label>
      <button class="btn ghost" id="sim"></button>
      <p class="muted small" id="sens" aria-live="polite"></p>
    </section>
    <section class="grid">
      <div class="tile" id="t-heartRate"><span class="k">Frecuencia cardiaca</span><strong><span class="beat" id="beat" aria-hidden="true"></span><span id="hr">--</span> <small>bpm</small></strong></div>
      <div class="tile" id="t-spo2"><span class="k">SpO₂</span><strong><span id="spo2">--</span> <small>%</small></strong></div>
      <div class="tile" id="t-temperature"><span class="k">Temperatura</span><strong><span id="temp">--</span> <small>°C</small></strong></div>
      <div class="tile"><span class="k" id="steps-k">Pasos</span><strong id="steps">--</strong></div>
      <div class="tile"><span class="k">Calorías</span><strong><span id="cal">--</span> <small>kcal</small></strong></div>
      <div class="tile"><span class="k">Batería</span><strong><span id="bat">--</span> <small>%</small></strong></div>
    </section>
    <section class="card">
      <span class="k">Actividad detectada</span><strong class="big" id="act">--</strong>
      <span class="k">Giroscopio (rad/s)</span>
      <div class="xyz"><span>X <b id="x">--</b></span><span>Y <b id="y">--</b></span><span>Z <b id="z">--</b></span></div>
      <div class="acciones">
        <button class="btn" id="sv">Guardar lectura</button>
        <button class="btn ghost" id="rs">Reiniciar pasos</button>
      </div>
      <p class="muted small" id="msg" aria-live="polite"></p>
    </section>
    <p class="muted small">Servicios: ${Object.values(GATT).join(', ')}.</p>`;
  const $ = (id) => el.querySelector('#' + id);
  $('esc').value = sim.getEscenario();

  const paint = () => {
    const { ble, wearable: w, gyro: g, activity } = getState();
    const simOn = sim.isRunning();
    $('st').textContent = simOn ? 'Usando wearable simulado' : LABEL[ble.status];
    $('dn').innerHTML = esc(ble.error || ble.deviceName || '');
    $('bt').textContent = ble.status === 'connected' ? 'Desconectar' : 'Buscar wearable';
    $('bt').disabled = ble.status === 'connecting' || simOn;
    $('sim').textContent = simOn ? 'Detener simulación' : 'Usar wearable simulado';
    $('sim').disabled = ble.status === 'connected';
    $('hr').textContent = w.heartRate ?? '--'; $('spo2').textContent = w.spo2 ?? '--';
    $('temp').textContent = w.temperature ?? '--'; $('steps').textContent = w.steps ?? '--';
    $('steps-k').textContent = simOn && g.running ? 'Pasos (acelerómetro)' : 'Pasos';
    $('cal').textContent = w.calories ?? '--'; $('bat').textContent = w.battery ?? '--';
    $('act').textContent = g.running ? activity.current : '--';
    $('x').textContent = fmt(g.x); $('y').textContent = fmt(g.y); $('z').textContent = fmt(g.z);
    // El corazón late al ritmo de la frecuencia medida.
    $('beat').style.animationDuration = w.heartRate ? `${60 / w.heartRate}s` : '';
    $('beat').classList.toggle('on', !!w.heartRate);
    const campos = new Set(evaluarAlertas(w.connected ? w : null).map((a) => a.campo));
    ['heartRate', 'spo2', 'temperature'].forEach((c) => $('t-' + c).classList.toggle('warn', campos.has(c)));
  };

  $('bt').addEventListener('click', () => (getState().ble.status === 'connected' ? disconnect() : connect()));
  $('sim').addEventListener('click', async () => {
    if (sim.isRunning()) {
      sim.stop();
      if (!monitor.isRunning()) gyro.stop();
      $('sens').textContent = '';
    } else {
      sim.start();
      // El clic es el gesto del usuario que algunos teléfonos piden para dar permiso a los sensores.
      try {
        await gyro.start();
        $('sens').textContent = 'Sensores del teléfono encendidos: los pasos se cuentan con el acelerómetro.';
      } catch (e) {
        $('sens').textContent = `Sin sensores de movimiento (${e.message}): los pasos los genera el simulador.`;
      }
    }
    paint();
  });
  $('esc').addEventListener('change', (e) => sim.setEscenario(e.target.value));
  $('rs').addEventListener('click', gyro.resetSteps);
  $('sv').addEventListener('click', async () => {
    const m = monitor.capturar();   // misma medición unificada que usa el monitoreo automático
    if (!m || (!m.wearable && !m.gyroscope)) { $('msg').textContent = 'Conecta el wearable o usa el simulado primero.'; return; }
    await measurementsDao.insertar(m);
    $('msg').textContent = m.wearable ? 'Lectura guardada (teléfono + wearable).' : 'Lectura guardada (solo teléfono).';
  });
  paint();
  return subscribe((k) => ['ble', 'wearable', 'gyro', 'activity'].includes(k) && paint());
}
