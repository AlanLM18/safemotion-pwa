import { login, isValidPin, segundosDeBloqueo, consumeExpiredFlag } from '../services/auth.js';
import { MSG, MOCK } from '../config.js';

// Mensaje genérico (Práctica 5): no se dice si el PIN existe o no.
const mensajeDe = (ex) => (ex.message === 'Credenciales inválidas' ? MSG.auth
  : ex.message === 'Bloqueado' ? 'Demasiados intentos. Intenta más tarde.'
    : ex.status === 403 && ex.message.includes('deshabilitada') ? 'Esta cuenta está deshabilitada. Habla con el administrador.'
      : ex.status === 0 ? 'Sin conexión. Revisa tu internet e inténtalo de nuevo.' : MSG.error);

// PIN de 4 dígitos (Práctica 5). Con Firebase, el PIN se traduce a la cuenta del usuario (credencialesDePin).
export function mount(el) {
  el.innerHTML = `
    <div class="brand"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg><h1>SafeMotion AI</h1></div>
    <p class="muted">Ingresa tu PIN para ver tu actividad y conectar tu wearable.</p>
    <form id="f" class="stack" novalidate>
      <label>PIN de 4 dígitos
        <input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" required class="pin" />
      </label>
      <p class="error" id="err" role="alert" hidden></p>
      <button class="btn" id="go">Iniciar sesión</button>
      ${MOCK ? '<p class="muted small">Modo simulado: PIN 0000 o 1111 (pacientes), 3333 (recepción), 2222 (doctor), 1234 (admin).</p>' : ''}
    </form>`;
  const f = el.querySelector('#f'), err = el.querySelector('#err'), btn = el.querySelector('#go');
  const showError = (t) => { err.textContent = t; err.hidden = false; };
  if (consumeExpiredFlag()) showError(MSG.expired);

  // Solo dígitos en el campo (no se registra el valor en consola ni en ningún log).
  f.pin.addEventListener('input', () => { f.pin.value = f.pin.value.replace(/\D/g, '').slice(0, 4); });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const espera = segundosDeBloqueo();
    if (espera) { showError(`Demasiados intentos. Espera ${espera} s.`); return; }
    const pin = f.pin.value;
    if (!isValidPin(pin)) { showError(MSG.auth); return; }
    btn.disabled = true; btn.textContent = MSG.loading;
    try {
      await login(pin);
      location.hash = '/inicio';
    } catch (ex) {
      f.pin.value = '';
      showError(mensajeDe(ex));
      btn.disabled = false; btn.textContent = 'Iniciar sesión';
    }
  });
  return () => {};
}
