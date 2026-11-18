// Sesión autenticada y control de acceso. Login por PIN de 4 dígitos (con Firebase, Spring Boot o el modo simulado).
// Reglas de la Práctica 5: validar antes de enviar, mensaje genérico, nunca registrar el PIN, limitar intentos.
import { api } from './api.js';
import { SESSION_HOURS } from '../config.js';

const KEY = 'sm_session';
const EXPIRED_KEY = 'sm_expired';
const BLOQUEO_KEY = 'sm_bloqueo';
export const MAX_INTENTOS = 5;
export const BLOQUEO_MS = 30_000;

// Intentos fallidos y fin del bloqueo: se guardan en el teléfono para que recargar la página no reinicie el
// bloqueo (defecto D-04). Si no hay almacenamiento, se cuentan en memoria.
let enMemoria = { intentos: 0, hasta: 0 };
const leerBloqueo = () => {
  try { const v = localStorage.getItem(BLOQUEO_KEY); return v ? JSON.parse(v) : { intentos: 0, hasta: 0 }; } catch { return enMemoria; }
};
const guardarBloqueo = (b) => { enMemoria = b; try { localStorage.setItem(BLOQUEO_KEY, JSON.stringify(b)); } catch { /* sin almacenamiento */ } };

export const isValidPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && s.expiresAt > Date.now() ? s : null;
  } catch { return null; }
}
export const isAuthenticated = () => !!getSession();
export const segundosDeBloqueo = () => Math.max(0, Math.ceil((leerBloqueo().hasta - Date.now()) / 1000));

const guardarSesion = (r) => {
  guardarBloqueo({ intentos: 0, hasta: 0 });
  localStorage.setItem(KEY, JSON.stringify({
    token: r.token, user: r.usuario, expiresAt: Date.now() + SESSION_HOURS * 3600_000
  }));
  return r.usuario;
};

export async function login(pin) {
  if (segundosDeBloqueo()) throw new Error('Bloqueado');
  if (!isValidPin(pin)) { registrarFallo(); throw new Error('Credenciales inválidas'); }
  try {
    return guardarSesion(await api.login(pin));
  } catch (e) {
    if (e.message === 'Credenciales inválidas') registrarFallo();
    throw e;
  }
}

function registrarFallo() {
  const intentos = leerBloqueo().intentos + 1;
  guardarBloqueo(intentos >= MAX_INTENTOS ? { intentos: 0, hasta: Date.now() + BLOQUEO_MS } : { intentos, hasta: 0 });
}

export function logout() {
  const s = getSession();
  localStorage.removeItem(KEY);
  if (s) api.logout(s.token).catch(() => {});   // invalida el token en el servidor si hay red
}

// El servidor respondió 401 (p. ej. se reinició y perdió las sesiones): cerrar y avisar en login.
export function expireSession() {
  localStorage.removeItem(KEY);
  try { sessionStorage.setItem(EXPIRED_KEY, '1'); } catch { /* sin almacenamiento */ }
  location.hash = '/login';
}
export function consumeExpiredFlag() {
  try {
    const v = sessionStorage.getItem(EXPIRED_KEY);
    sessionStorage.removeItem(EXPIRED_KEY);
    return v === '1';
  } catch { return false; }
}
