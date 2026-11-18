// Router por hash + guardia de acceso (pantallas con datos personales requieren sesión).
// Cada ruta indica qué roles la ven: usuario = paciente, recepcionista = recibe los SOS y los canaliza,
// doctor = atiende, admin = supervisa.
import { isAuthenticated, getSession, logout } from './services/auth.js';
import { subscribe, getState } from './services/store.js';
import * as login from './screens/login.js';
import * as inicio from './screens/inicio.js';
import * as dispositivo from './screens/dispositivo.js';
import * as historial from './screens/historial.js';
import * as doctor from './screens/doctor.js';
import * as recepcion from './screens/recepcion.js';
import * as consultas from './screens/consultas.js';
import * as cuenta from './screens/cuenta.js';
import * as monitor from './services/monitor.js';
import * as sim from './services/wearableSim.js';
import * as gyro from './services/gyro.js';
import * as alertWatcher from './services/alertWatcher.js';

const PACIENTE = ['usuario', 'admin'], TODOS = ['usuario', 'admin', 'doctor', 'recepcionista'];
const routes = {
  '/login':       { screen: login, public: true },
  '/inicio':      { screen: inicio,      title: 'Inicio',     roles: PACIENTE, icon: 'M3 11l9-8 9 8v10H3z' },
  '/dispositivo': { screen: dispositivo, title: 'Wearable',   roles: PACIENTE, icon: 'M8 2h8l1 5-1 10H8L7 7zM8 17l1 5h6l1-5' },
  '/historial':   { screen: historial,   title: 'Historial',  roles: PACIENTE, icon: 'M4 5h16M4 12h16M4 19h10' },
  '/doctor':      { screen: doctor,      title: 'Doctor',     roles: ['usuario'], icon: 'M4 5h16v11H9l-5 4z' },
  '/recepcion':   { screen: recepcion,   title: 'Recepción',  roles: ['recepcionista', 'admin'], icon: 'M12 3l9 4-9 4-9-4zM5 10v5c0 2 3 4 7 4s7-2 7-4v-5' },
  '/consultas':   { screen: consultas,   title: 'Consultas',  roles: ['doctor', 'admin'], icon: 'M4 4h16v16H4zM4 13h5l1 2h4l1-2h5' },
  '/cuenta':      { screen: cuenta,      title: 'Cuenta',     roles: TODOS, icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6' }
};
const CHIP = { idle: 'Sin wearable', connecting: 'Conectando', connected: 'Wearable conectado', disconnected: 'Desconectado', error: 'Error BLE', sim: 'Wearable simulado' };
const INICIO = { doctor: '/consultas', recepcionista: '/recepcion' };
const inicioDe = (rol) => INICIO[rol] ?? '/inicio';

let cleanup = null, unsubscribe = null;

export function startRouter(root) {
  const go = () => {
    cleanup?.(); unsubscribe?.();
    const [actual, query = ''] = location.hash.slice(1).split('?');
    const rol = isAuthenticated() ? getSession().user.rol : null;
    let path = actual || (rol ? inicioDe(rol) : '/login');
    if (!routes[path]) path = rol ? inicioDe(rol) : '/login';
    if (!routes[path].public && !rol) path = '/login';
    if (routes[path].public && rol) path = inicioDe(rol);
    if (!routes[path].public && !routes[path].roles.includes(rol)) path = inicioDe(rol);   // ruta de otro rol
    if (actual !== path) { location.hash = path; return; }
    render(root, path, new URLSearchParams(query));
  };
  window.addEventListener('hashchange', go);
  go();
}

function render(root, path, params) {
  const r = routes[path];
  if (r.public) {
    alertWatcher.stop();
    root.innerHTML = '<main class="screen auth"></main>';
    cleanup = r.screen.mount(root.querySelector('main'));
    return;
  }
  const user = getSession().user;
  if (user.rol === 'usuario') alertWatcher.start();
  root.innerHTML = `
    <header class="top">
      <h1>${r.title}</h1>
      <span class="chip" id="chip"></span>
    </header>
    <main class="screen" id="view"></main>
    <nav class="tabs" aria-label="Navegación principal">
      ${Object.entries(routes).filter(([, v]) => !v.public && v.roles.includes(user.rol)).map(([p, v]) => `
        <a href="#${p}" class="${p === path ? 'on' : ''}" aria-label="${v.title}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${v.icon}"/></svg><span>${v.title}</span>
        </a>`).join('')}
    </nav>`;
  const chip = root.querySelector('#chip');
  const paint = () => {
    const { ble, wearable } = getState();
    const s = wearable.simulated && wearable.connected ? 'sim' : ble.status;
    chip.textContent = CHIP[s]; chip.dataset.s = s;
  };
  if (user.rol === 'doctor' || user.rol === 'recepcionista') chip.textContent = user.nombre;   // el personal no usa wearable
  else { paint(); unsubscribe = subscribe((k) => (k === 'ble' || k === 'wearable') && paint()); }
  cleanup = r.screen.mount(root.querySelector('#view'), {
    user, params,
    logout: () => { monitor.stop(); sim.stop(); gyro.stop(); alertWatcher.stop(); logout(); location.hash = '/login'; }
  });
}
