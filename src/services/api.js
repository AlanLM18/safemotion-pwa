// Datos de la app. Con la configuración de Firebase (Prácticas 9 y 10) todo vive en Firebase: Authentication con
// correo y contraseña y Cloud Firestore como base compartida entre dispositivos (src/services/apiFirebase.js).
// Sin Firebase: cliente REST hacia Spring Boot (contrato de safemotion-ai/backend, Práctica 3) o, sin URL,
// modo simulado con el mismo contrato para desarrollar y probar sin servidor.
import { API_BASE_URL, API_TIMEOUT_MS, FIREBASE, FIREBASE_EMULADOR } from '../config.js';
import { validateMedicionRequest } from '../models/measurement.js';
import { validarMensaje } from '../models/chat.js';
import { ESTADO_SOS, mensajeCanalizada, mensajeAtendida } from '../models/emergencia.js';
import { respuestaAsistente, ASISTENTE } from './doctorBot.js';

// datos: cuerpo de la respuesta de error, si lo hay (p. ej. un 409 trae el registro como quedó en la base).
export class ApiError extends Error {
  constructor(message, status = 0, datos = null) { super(message); this.status = status; this.datos = datos; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi({ baseUrl = API_BASE_URL, timeoutMs = API_TIMEOUT_MS } = {}) {
  if (!baseUrl) return createMockApi();

  async function request(path, { method = 'GET', body, token } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(baseUrl + path, {
        method,
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {})   // el backend espera el token tal cual, sin "Bearer"
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        let datos = null;
        try { const t = await res.text(); datos = t ? JSON.parse(t) : null; } catch { /* cuerpo vacío o no JSON */ }
        throw new ApiError(`HTTP ${res.status}`, res.status, datos);
      }
      const text = await res.text();
      if (!text) return null;                          // 204 => null
      try { return JSON.parse(text); }                 // WB-D10 (P13-14): un 200 que no es JSON no es "sin conexión"
      catch { throw new ApiError('Respuesta inválida del servidor', res.status); }
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError('Sin conexión con el servidor');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mock: false,
    estado: () => request('/api/sistema/estado'),
    async login(pin) {
      try {
        return await request('/api/auth/login', { method: 'POST', body: { pin } });
      } catch (e) {
        if (e.status === 401 || e.status === 400) throw new ApiError('Credenciales inválidas', e.status);
        // 403 = PIN correcto pero cuenta deshabilitada (el backend lo distingue del PIN incorrecto)
        throw e.status === 403 ? new ApiError(e.datos?.error ?? 'Esta cuenta está deshabilitada', 403) : e;
      }
    },
    logout: (token) => request('/api/auth/logout', { method: 'POST', token }),
    enviarMedicion: (req, token) => request('/api/mediciones', { method: 'POST', body: req, token }),
    historial: (token, limite = 20) => request(`/api/mediciones/historial?limite=${limite}`, { token }),
    // Chat paciente-médico y SOS (Prácticas 6 y 7)
    conversaciones: (token) => request('/api/chat/conversaciones', { token }),
    mensajes: (pacienteId, token) => request(`/api/chat/${pacienteId}/mensajes`, { token }),
    enviarMensaje: (pacienteId, texto, token) => request(`/api/chat/${pacienteId}/mensajes`, { method: 'POST', body: { texto }, token }),
    limpiarChat: (pacienteId, token) => request(`/api/chat/${pacienteId}/mensajes`, { method: 'DELETE', token }),
    crearEmergencia: (datos, token) => request('/api/emergencias', { method: 'POST', body: datos, token }),
    emergencias: (token) => request('/api/emergencias', { token }),
    atenderEmergencia: (id, token) => request(`/api/emergencias/${id}/atender`, { method: 'PATCH', token }),
    // Recepción y doctor (backend Spring sobre Firebase): mismas operaciones que apiFirebase.js
    doctores: (token) => request('/api/emergencias/doctores', { token }),
    canalizarEmergencia: (id, doctorId, token) => request(`/api/emergencias/${id}/canalizar`, { method: 'PATCH', body: { doctorId }, token }),
    ultimaMedicion: (pacienteId, token) => request(`/api/pacientes/${pacienteId}/mediciones/ultima`, { token })
  };
}

// Simula el servidor: mismos usuarios de prueba, mismas reglas por rol y mismos códigos HTTP que la app usa con
// Firebase (403 sin permiso, 404 no existe, 409 si otro dispositivo cambió el registro antes).
function createMockApi() {
  const usuarios = {
    '1234': { id: 1, nombre: 'Administrador', rol: 'admin' },
    '0000': { id: 2, nombre: 'Juan Pérez', rol: 'usuario' },
    '2222': { id: 3, nombre: 'Dra. Ana Torres', rol: 'doctor' },
    '1111': { id: 4, nombre: 'María López', rol: 'usuario' },
    '3333': { id: 5, nombre: 'Laura Gómez', rol: 'recepcionista' }
  };
  const porId = (id) => Object.values(usuarios).find((u) => u.id === id);
  const sesiones = new Map();
  const revocados = new Set();
  const mediciones = [];
  // El token lleva el id del usuario para que la sesión siga válida al recargar la página.
  const usuarioDe = (token) => {
    let u = sesiones.get(token);
    if (!u && !revocados.has(token)) {
      u = porId(Number(/^mock-(\d+)-/.exec(token ?? '')?.[1]));
      if (u) sesiones.set(token, u);
    }
    if (!u) throw new ApiError('HTTP 401', 401);
    return u;
  };
  const esPersonal = (u) => u.rol === 'doctor' || u.rol === 'admin';            // ve datos clínicos y el chat
  const veEmergencias = (u) => esPersonal(u) || u.rol === 'recepcionista';
  const exigir = (cond, status, datos = null) => { if (!cond) throw new ApiError(`HTTP ${status}`, status, datos); };
  const at = cargarAtencion();
  const guardar = () => guardarAtencion(at);
  const paciente = (id) => { const p = porId(Number(id)); exigir(p && p.rol === 'usuario', 404); return p; };
  const nuevoMensaje = (autor, pacienteId, texto) => {
    const m = { id: ++at.seq, pacienteId, autorId: autor.id, autor: autor.nombre, rol: autor.rol, texto, fecha: new Date().toISOString() };
    at.mensajes.push(m); guardar();
    return m;
  };
  // Sin médico real conectado, el asistente contesta a los mensajes del paciente.
  const contestar = (pacienteId, texto) => setTimeout(() => {
    nuevoMensaje({ id: 0, nombre: ASISTENTE, rol: 'asistente' }, pacienteId, respuestaAsistente(texto));
  }, 1200);
  const dtoEmergencia = (e) => ({ ...e, paciente: porId(e.pacienteId).nombre });
  const activaDe = (pacienteId) => at.emergencias.find((e) => e.pacienteId === pacienteId && e.estado !== ESTADO_SOS.ATENDIDA);
  const emergencia = (id) => { const e = at.emergencias.find((x) => x.id === Number(id)); exigir(e, 404); return e; };
  return {
    mock: true,
    async estado() {
      await sleep(400);
      return { usuariosConectados: sesiones.size, usuariosRegistrados: Object.keys(usuarios).length, wearablesActivos: mediciones.length ? 1 : 0, alertasTotales: 0, tareas: [], baseDatos: 'simulada en este dispositivo' };
    },
    async login(pin) {
      await sleep(400);
      const usuario = usuarios[pin];
      if (!usuario) throw new ApiError('Credenciales inválidas', 401);
      const token = `mock-${usuario.id}-${crypto.randomUUID()}`;
      sesiones.set(token, usuario);
      return { token, usuario };
    },
    async logout(token) { sesiones.delete(token); revocados.add(token); return null; },
    async enviarMedicion(req, token) {
      await sleep(150);
      const usuario = usuarioDe(token);
      exigir(usuario.rol === 'usuario' || usuario.rol === 'admin', 403);
      if (validateMedicionRequest(req).length) throw new ApiError('HTTP 400', 400);
      const m = { id: mediciones.length + 1, ...req, fecha: new Date().toISOString(), usuario };
      mediciones.unshift(m);
      return m;
    },
    async historial(token, limite = 20) {
      const usuario = usuarioDe(token);
      return mediciones.filter((m) => m.usuario.id === usuario.id).slice(0, limite);
    },
    // El doctor ve la última lectura del paciente en su conversación (recepción no ve datos clínicos).
    async ultimaMedicion(pacienteId, token) {
      exigir(esPersonal(usuarioDe(token)), 403);
      return mediciones.find((m) => m.usuario.id === Number(pacienteId)) ?? null;
    },
    async conversaciones(token) {
      exigir(esPersonal(usuarioDe(token)), 403);
      return Object.values(usuarios).filter((u) => u.rol === 'usuario').map((p) => {
        const propios = at.mensajes.filter((m) => m.pacienteId === p.id);
        const ultimo = propios.at(-1);
        const activa = activaDe(p.id);
        return { pacienteId: p.id, paciente: p.nombre, mensajes: propios.length, ultimoMensaje: ultimo?.texto ?? null, fecha: ultimo?.fecha ?? null, emergenciaAbierta: activa ? dtoEmergencia(activa) : null };
      }).sort((a, b) => (Number(!a.emergenciaAbierta) - Number(!b.emergenciaAbierta)) || String(b.fecha ?? '').localeCompare(String(a.fecha ?? '')));
    },
    async mensajes(pacienteId, token) {
      const u = usuarioDe(token);
      exigir(esPersonal(u) || u.id === Number(pacienteId), 403);
      paciente(pacienteId);
      return at.mensajes.filter((m) => m.pacienteId === Number(pacienteId));
    },
    async enviarMensaje(pacienteId, texto, token) {
      await sleep(150);
      const u = usuarioDe(token);
      exigir(esPersonal(u) || u.id === Number(pacienteId), 403);
      const p = paciente(pacienteId);
      const v = validarMensaje(texto);
      exigir(v.ok, 400);
      const m = nuevoMensaje(u, p.id, v.texto);
      if (u.rol === 'usuario') contestar(p.id, v.texto);
      return m;
    },
    async limpiarChat(pacienteId, token) {
      const u = usuarioDe(token);
      exigir(esPersonal(u) || u.id === Number(pacienteId), 403);
      paciente(pacienteId);
      at.mensajes = at.mensajes.filter((m) => m.pacienteId !== Number(pacienteId)); guardar();
      return null;
    },
    // SOS: el paciente lo crea, recepción lo canaliza a un doctor y el doctor lo atiende.
    async crearEmergencia(datos, token) {
      await sleep(300);
      const u = usuarioDe(token);
      exigir(u.rol === 'usuario', 403);
      const activa = activaDe(u.id);
      if (activa) return { ...dtoEmergencia(activa), duplicada: true };
      const e = { id: ++at.seq, pacienteId: u.id, fecha: new Date().toISOString(), ...datos, estado: ESTADO_SOS.ABIERTA,
        canalizadaA: null, canalizadaANombre: null, canalizadaPor: null, fechaCanalizacion: null, atendidaPor: null, fechaAtencion: null, version: 0 };
      at.emergencias.unshift(e); guardar();
      const texto = 'SOS: solicito ayuda de emergencia.';
      nuevoMensaje(u, u.id, texto);
      contestar(u.id, texto);
      return { ...dtoEmergencia(e), duplicada: false };
    },
    async emergencias(token) {
      const u = usuarioDe(token);
      return at.emergencias.filter((e) => veEmergencias(u) || e.pacienteId === u.id).map(dtoEmergencia);
    },
    async doctores(token) {
      exigir(veEmergencias(usuarioDe(token)), 403);
      return Object.values(usuarios).filter((u) => u.rol === 'doctor').map(({ id, nombre }) => ({ id, nombre }));
    },
    async canalizarEmergencia(id, doctorId, token) {
      await sleep(150);
      const u = usuarioDe(token);
      exigir(u.rol === 'recepcionista' || u.rol === 'admin', 403);
      const e = emergencia(id);
      exigir(e.estado === ESTADO_SOS.ABIERTA, 409, { actual: dtoEmergencia(e) });   // otra recepcionista ya la canalizó
      const doctor = porId(Number(doctorId));
      exigir(doctor && doctor.rol === 'doctor', 400);
      Object.assign(e, { estado: ESTADO_SOS.CANALIZADA, canalizadaA: doctor.id, canalizadaANombre: doctor.nombre, canalizadaPor: u.nombre,
        fechaCanalizacion: new Date().toISOString(), version: e.version + 1 });
      nuevoMensaje(u, e.pacienteId, mensajeCanalizada(doctor.nombre));
      return dtoEmergencia(e);
    },
    async atenderEmergencia(id, token) {
      const u = usuarioDe(token);
      exigir(esPersonal(u), 403);
      const e = emergencia(id);
      if (e.estado === ESTADO_SOS.ATENDIDA) return dtoEmergencia(e);
      exigir(e.estado === ESTADO_SOS.CANALIZADA, 409, { actual: dtoEmergencia(e) });   // primero la recibe recepción
      exigir(u.rol === 'admin' || e.canalizadaA === u.id, 403);
      Object.assign(e, { estado: ESTADO_SOS.ATENDIDA, atendidaPor: u.nombre, fechaAtencion: new Date().toISOString(), version: e.version + 1 });
      nuevoMensaje(u, e.pacienteId, mensajeAtendida(u.nombre));
      return dtoEmergencia(e);
    }
  };
}

// En modo simulado el chat y las emergencias se conservan en el navegador (si hay almacenamiento).
const KEY_ATENCION = 'sm_mock_atencion';
function cargarAtencion() {
  const vacio = { seq: 0, mensajes: [], emergencias: [] };
  try { return { ...vacio, ...JSON.parse(globalThis.localStorage?.getItem(KEY_ATENCION)) }; }
  catch { return vacio; }
}
function guardarAtencion(at) {
  try { globalThis.localStorage?.setItem(KEY_ATENCION, JSON.stringify(at)); } catch { /* sin almacenamiento */ }
}

// Firebase se descarga solo cuando la app lo usa por primera vez, para no hacer más pesada la carga inicial.
function createApiFirebasePerezosa() {
  let instancia = null;
  const cargar = () => (instancia ??= import('./apiFirebase.js').then((m) => m.createFirebaseApi({ config: FIREBASE, emulador: FIREBASE_EMULADOR })));
  return new Proxy({ mock: false, firebase: true }, {
    get: (base, nombre) => (nombre in base || typeof nombre === 'symbol' ? base[nombre] : (...args) => cargar().then((a) => a[nombre](...args)))
  });
}

export const api = FIREBASE ? createApiFirebasePerezosa() : createApi();
