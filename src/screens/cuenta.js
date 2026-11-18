import { esc } from '../util.js';
import { MOCK, API_BASE_URL, FIREBASE } from '../config.js';

export function mount(el, { user, logout }) {
  el.innerHTML = `
    <section class="card">
      <span class="k">Usuario</span><strong class="big">${esc(user.nombre)}</strong>
      <p class="muted">Rol: ${esc(user.rol)}</p>
      <span class="k">UID (identificador en la base)</span><p class="muted" id="uid">${esc(user.id)}</p>
      <span class="k">Base de datos</span><p class="muted small">${FIREBASE ? `Cloud Firestore · proyecto ${esc(FIREBASE.projectId)}` : MOCK ? 'Simulado (datos solo en este dispositivo)' : esc(API_BASE_URL)}</p>
      <button class="btn ghost" id="out">Cerrar sesión</button>
    </section>`;
  el.querySelector('#out').addEventListener('click', logout);
  return () => {};
}
