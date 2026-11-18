// La app sobre Firebase (Prácticas 9 y 10): Authentication (con el PIN de 4 dígitos) y Cloud Firestore como base
// compartida entre los dispositivos de pacientes, recepción y doctores. Mismo contrato que el modo simulado de api.js.
//   usuarios/{uid}                          perfil y rol (usuario = paciente, doctor, recepcionista, admin)
//   usuarios/{uid}/mediciones/{idLocal}     lecturas del wearable (el id local evita duplicados al reintentar)
//   conversaciones/{pacienteUid}/mensajes   chat del paciente con el personal médico
//   emergencias/{id}                        SOS: ABIERTA (recepción) -> CANALIZADA (doctor) -> ATENDIDA
// Las escrituras van en transacciones que leen primero: sin conexión fallan y la app lo informa, en vez de quedar en
// una cola local que se enviaría después sin que nadie lo sepa. Las reglas de firestore.rules deciden qué puede cada rol.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, getDocsFromServer, updateDoc, query, where, orderBy, limit, runTransaction, serverTimestamp
} from 'firebase/firestore';
import { ApiError } from './api.js';
import { validateMedicionRequest } from '../models/measurement.js';
import { validarMensaje } from '../models/chat.js';
import { evaluarAlertas } from '../models/alerts.js';
import { ESTADO_SOS, mensajeCanalizada, mensajeAtendida } from '../models/emergencia.js';
import { credencialesDePin } from '../models/user.js';

const ESPERA_MS = 10000;
const ACTIVAS = [ESTADO_SOS.ABIERTA, ESTADO_SOS.CANALIZADA];

// Errores de Firebase con los códigos que la app ya maneja (401, 403, 404, 409, 0 = sin conexión).
export function errorDeFirebase(e) {
  if (e instanceof ApiError) return e;
  const c = e?.code ?? '';
  if (c === 'permission-denied') return new ApiError('Permiso denegado por las reglas de Firestore', 403);
  if (c === 'not-found') return new ApiError('No existe', 404);
  if (['unavailable', 'deadline-exceeded', 'auth/network-request-failed'].includes(c)) return new ApiError('Sin conexión con el servidor', 0);
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/missing-password'].includes(c)) return new ApiError('Credenciales inválidas', 401);
  if (c === 'auth/email-already-in-use') return new ApiError('Ese correo ya tiene una cuenta', 409);
  if (c === 'auth/weak-password') return new ApiError('La contraseña debe tener al menos 6 caracteres', 400);
  if (c === 'auth/too-many-requests') return new ApiError('Demasiados intentos. Espera un momento.', 429);
  return new ApiError(e?.message ?? 'Error de Firebase', 500);
}

const conTiempo = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new ApiError('Sin respuesta del servidor', 0)), ESPERA_MS))]);
const iso = (ts) => (ts?.toDate ? ts.toDate().toISOString() : ts ?? new Date().toISOString());
const datos = (snap) => ({ ...snap.data({ serverTimestamps: 'estimate' }), id: snap.id });

/** config: { apiKey, authDomain, projectId } · emulador: { auth: 'host:puerto', firestore: 'host:puerto' } (pruebas) */
export function createFirebaseApi({ config, emulador = null, nombre = '[DEFAULT]' }) {
  const app = initializeApp(config, nombre);
  const auth = getAuth(app), db = getFirestore(app);
  if (emulador) {
    connectAuthEmulator(auth, `http://${emulador.auth}`, { disableWarnings: true });
    const [host, puerto] = emulador.firestore.split(':');
    connectFirestoreEmulator(db, host, Number(puerto));
  }
  // Al abrir la app, Firebase recupera la sesión guardada en el teléfono; las operaciones esperan a que termine.
  const listo = new Promise((resolver) => { const off = onAuthStateChanged(auth, () => { off(); resolver(); }); });
  const perfiles = new Map();

  const ejecutar = async (fn) => { try { return await conTiempo(fn()); } catch (e) { throw errorDeFirebase(e); } };
  const transaccion = (fn) => ejecutar(() => runTransaction(db, fn));
  // Para un SOS que pueden cambiar varios dispositivos: las reglas exigen version == anterior + 1, así que una
  // escritura hecha sobre una versión vieja llega como 403. Si la versión cambió mientras tanto, se vuelve a leer y a
  // evaluar (y entonces la transacción responde 409 con cómo quedó).
  async function cambiarSos(ref, fn) {
    for (let intento = 0; ; intento++) {
      let leida = null;
      try {
        return await transaccion(async (tx) => { const s = await tx.get(ref); if (s.exists()) leida = s.data().version; return fn(tx, s); });
      } catch (e) {
        if (e.status === 403 && leida != null && intento < 3) {
          const ahora = await ejecutar(() => getDoc(ref)).catch(() => null);
          if (ahora?.exists() && ahora.data().version !== leida) continue;
        }
        throw e;
      }
    }
  }
  async function perfil(uid) {
    if (!perfiles.has(uid)) {
      const s = await ejecutar(() => getDoc(doc(db, 'usuarios', uid)));
      if (!s.exists()) throw new ApiError('Tu cuenta no tiene perfil en SafeMotion', 403);
      perfiles.set(uid, { id: uid, nombre: s.data().nombre, rol: s.data().rol, habilitado: s.data().habilitado });
    }
    return perfiles.get(uid);
  }
  async function yo() {
    await listo;
    if (!auth.currentUser) throw new ApiError('Sin sesión', 401);
    return perfil(auth.currentUser.uid);
  }
  const sesion = async () => { const u = await yo(); return { token: `firebase-${u.id}`, usuario: u }; };

  const dtoMensaje = (s) => { const m = datos(s); return { id: m.id, pacienteId: s.ref.parent.parent.id, autorId: m.autorId, autor: m.autor, rol: m.rol, texto: m.texto, fecha: iso(m.fecha) }; };
  const dtoEmergencia = (s) => { const e = datos(s); return { ...e, fecha: iso(e.fecha), fechaCanalizacion: e.fechaCanalizacion ? iso(e.fechaCanalizacion) : null, fechaAtencion: e.fechaAtencion ? iso(e.fechaAtencion) : null }; };
  const mensajeEn = (tx, pacienteId, autor, texto) => tx.set(doc(collection(db, 'conversaciones', pacienteId, 'mensajes')), { autorId: autor.id, autor: autor.nombre, rol: autor.rol, texto, fecha: serverTimestamp() });

  return {
    mock: false,
    firebase: true,
    auth, db,
    async estado() {
      const u = await yo();
      return { baseDatos: `Cloud Firestore · proyecto ${config.projectId}`, usuario: u.nombre, rol: u.rol };
    },

    // ---------- sesión ----------
    // El usuario escribe su PIN de 4 dígitos; se traduce a su cuenta de Firebase Authentication (credencialesDePin).
    async login(pin) {
      await listo;
      const { correo, password } = credencialesDePin(String(pin ?? ''));
      try { await signInWithEmailAndPassword(auth, correo, password); }
      catch (e) { throw errorDeFirebase(e).status === 401 ? new ApiError('Credenciales inválidas', 401) : errorDeFirebase(e); }
      perfiles.delete(auth.currentUser.uid);
      const r = await sesion();
      if (r.usuario.habilitado === false) { await signOut(auth); throw new ApiError('Esta cuenta está deshabilitada', 403); }
      updateDoc(doc(db, 'usuarios', r.usuario.id), { ultimoInicioSesion: serverTimestamp() }).catch(() => {});   // lo muestra el dashboard
      return r;
    },
    async logout() { perfiles.clear(); await signOut(auth); return null; },

    // ---------- mediciones ----------
    async enviarMedicion(req) {
      const u = await yo();
      if (validateMedicionRequest(req).length) throw new ApiError('HTTP 400', 400);
      const ref = doc(db, 'usuarios', u.id, 'mediciones', String(req.idLocal ?? crypto.randomUUID()));
      const alertas = evaluarAlertas({ heartRate: req.frecuenciaCardiaca, temperature: req.temperatura, spo2: req.spo2 }).map((a) => a.tipo);
      return transaccion(async (tx) => {
        const previa = await tx.get(ref);
        if (previa.exists()) return { ...datos(previa), fecha: iso(previa.data().fecha), usuario: u };   // reintento: ya estaba guardada
        const registro = { ...req, idLocal: ref.id, pacienteId: u.id, alertas, fecha: serverTimestamp() };
        tx.set(ref, registro);
        return { ...registro, id: ref.id, fecha: new Date().toISOString(), usuario: u };
      });
    },
    async historial(token, limite = 20) {
      const u = await yo();
      const s = await ejecutar(() => getDocs(query(collection(db, 'usuarios', u.id, 'mediciones'), orderBy('fecha', 'desc'), limit(limite))));
      return s.docs.map((d) => ({ ...datos(d), fecha: iso(d.data().fecha), usuario: u }));
    },

    async ultimaMedicion(pacienteId) {
      await yo();
      const s = await ejecutar(() => getDocs(query(collection(db, 'usuarios', String(pacienteId), 'mediciones'), orderBy('fecha', 'desc'), limit(1))));
      return s.empty ? null : { ...datos(s.docs[0]), fecha: iso(s.docs[0].data().fecha) };
    },

    // ---------- chat ----------
    async conversaciones() {
      await yo();
      const [pacientes, emergencias] = await Promise.all([
        ejecutar(() => getDocs(query(collection(db, 'usuarios'), where('rol', '==', 'usuario')))),
        ejecutar(() => getDocs(collection(db, 'emergencias')))
      ]);
      const activas = emergencias.docs.map(dtoEmergencia).filter((e) => ACTIVAS.includes(e.estado));
      const lista = await Promise.all(pacientes.docs.filter((p) => p.data().habilitado !== false).map(async (p) => {
        const ms = await ejecutar(() => getDocs(query(collection(db, 'conversaciones', p.id, 'mensajes'), orderBy('fecha'))));
        const ultimo = ms.docs.at(-1) && dtoMensaje(ms.docs.at(-1));
        return { pacienteId: p.id, paciente: p.data().nombre, mensajes: ms.size, ultimoMensaje: ultimo?.texto ?? null, fecha: ultimo?.fecha ?? null, emergenciaAbierta: activas.find((e) => e.pacienteId === p.id) ?? null };
      }));
      return lista.sort((a, b) => (Number(!a.emergenciaAbierta) - Number(!b.emergenciaAbierta)) || String(b.fecha ?? '').localeCompare(String(a.fecha ?? '')));
    },
    async mensajes(pacienteId) {
      await yo();
      const s = await ejecutar(() => getDocs(query(collection(db, 'conversaciones', String(pacienteId), 'mensajes'), orderBy('fecha'))));
      return s.docs.map(dtoMensaje);
    },
    async enviarMensaje(pacienteId, texto) {
      const u = await yo();
      const v = validarMensaje(texto);
      if (!v.ok) throw new ApiError('HTTP 400', 400);
      const ref = doc(collection(db, 'conversaciones', String(pacienteId), 'mensajes'));
      return transaccion(async (tx) => {
        await tx.get(ref);
        tx.set(ref, { autorId: u.id, autor: u.nombre, rol: u.rol, texto: v.texto, fecha: serverTimestamp() });
        return { id: ref.id, pacienteId: String(pacienteId), autorId: u.id, autor: u.nombre, rol: u.rol, texto: v.texto, fecha: new Date().toISOString() };
      });
    },
    async limpiarChat(pacienteId) {
      await yo();
      const s = await ejecutar(() => getDocs(collection(db, 'conversaciones', String(pacienteId), 'mensajes')));
      await transaccion(async (tx) => { for (const d of s.docs) await tx.get(d.ref); for (const d of s.docs) tx.delete(d.ref); });
      return null;
    },

    // ---------- SOS ----------
    async crearEmergencia(datosSos) {
      const u = await yo();
      if (u.rol !== 'usuario') throw new ApiError('Solo los pacientes piden SOS', 403);
      // Se consulta al servidor, no a la caché: sin red, una copia vieja diría "ya tienes un SOS abierto" y
      // confirmaría una ayuda que nadie recibió (defecto encontrado en DB-09).
      const propias = await ejecutar(() => getDocsFromServer(query(collection(db, 'emergencias'), where('pacienteId', '==', u.id))));
      const activa = propias.docs.map(dtoEmergencia).find((e) => ACTIVAS.includes(e.estado));
      if (activa) return { ...activa, duplicada: true };
      const ref = doc(collection(db, 'emergencias'));
      const e = {
        pacienteId: u.id, paciente: u.nombre, fecha: serverTimestamp(),
        latitud: datosSos.latitud ?? null, longitud: datosSos.longitud ?? null,
        frecuenciaCardiaca: datosSos.frecuenciaCardiaca ?? null, spo2: datosSos.spo2 ?? null, temperatura: datosSos.temperatura ?? null,
        estado: ESTADO_SOS.ABIERTA, version: 0
      };
      await transaccion(async (tx) => {
        await tx.get(ref);
        tx.set(ref, e);
        mensajeEn(tx, u.id, u, 'SOS: solicito ayuda de emergencia.');
      });
      return { ...e, id: ref.id, fecha: new Date().toISOString(), duplicada: false };
    },
    async emergencias() {
      const u = await yo();
      const q = u.rol === 'usuario' ? query(collection(db, 'emergencias'), where('pacienteId', '==', u.id)) : collection(db, 'emergencias');
      const s = await ejecutar(() => getDocs(q));
      return s.docs.map(dtoEmergencia).sort((a, b) => b.fecha.localeCompare(a.fecha));
    },
    async doctores() {
      await yo();
      const s = await ejecutar(() => getDocs(query(collection(db, 'usuarios'), where('rol', '==', 'doctor'))));
      return s.docs.filter((d) => d.data().habilitado !== false).map((d) => ({ id: d.id, nombre: d.data().nombre }));   // sin cuentas deshabilitadas
    },
    // Recepción: solo un SOS que siga ABIERTO. Si otra recepcionista lo canalizó antes, responde 409 con cómo quedó.
    async canalizarEmergencia(id, doctorId) {
      const u = await yo();
      const ref = doc(db, 'emergencias', String(id));
      return cambiarSos(ref, async (tx, s) => {
        if (!s.exists()) throw new ApiError('No existe', 404);
        const e = dtoEmergencia(s);
        if (e.estado !== ESTADO_SOS.ABIERTA) throw new ApiError('HTTP 409', 409, { actual: e });
        const d = await tx.get(doc(db, 'usuarios', String(doctorId)));
        if (!d.exists() || d.data().rol !== 'doctor') throw new ApiError('Elige un doctor', 400);
        const cambio = { estado: ESTADO_SOS.CANALIZADA, canalizadaA: d.id, canalizadaANombre: d.data().nombre, canalizadaPor: u.id, canalizadaPorNombre: u.nombre, fechaCanalizacion: serverTimestamp(), version: e.version + 1 };
        tx.update(ref, cambio);
        mensajeEn(tx, e.pacienteId, u, mensajeCanalizada(d.data().nombre));
        return { ...e, ...cambio, fechaCanalizacion: new Date().toISOString() };
      });
    },
    // Doctor: solo lo que recepción le canalizó (el administrador puede cerrar cualquiera).
    async atenderEmergencia(id) {
      const u = await yo();
      const ref = doc(db, 'emergencias', String(id));
      return cambiarSos(ref, async (tx, s) => {
        if (!s.exists()) throw new ApiError('No existe', 404);
        const e = dtoEmergencia(s);
        if (e.estado === ESTADO_SOS.ATENDIDA) return e;
        if (e.estado !== ESTADO_SOS.CANALIZADA) throw new ApiError('HTTP 409', 409, { actual: e });
        if (u.rol !== 'admin' && e.canalizadaA !== u.id) throw new ApiError('Esta emergencia está asignada a otro doctor', 403);
        const cambio = { estado: ESTADO_SOS.ATENDIDA, atendidaPor: u.nombre, atendidaPorUid: u.id, fechaAtencion: serverTimestamp(), version: e.version + 1 };
        tx.update(ref, cambio);
        mensajeEn(tx, e.pacienteId, u, mensajeAtendida(u.nombre));
        return { ...e, ...cambio, fechaAtencion: new Date().toISOString() };
      });
    }
  };
}
