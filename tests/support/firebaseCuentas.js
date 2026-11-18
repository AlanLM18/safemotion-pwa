// Cuentas de prueba de SafeMotion en Firebase, una por rol, para el emulador local o para el proyecto real.
// Se entra con el PIN de 4 dígitos (credencialesDePin lo traduce a la cuenta de Firebase Authentication).
// En el proyecto real los UID quedan en .env.pruebas (fuera de git y de Vercel) y las cuentas con su rol las crea
// tests/support/sembrarFirebase.mjs; en el emulador se crean aquí mismo.
import { readFileSync } from 'node:fs';
import { credencialesDePin } from '../../src/models/user.js';

export const CUENTAS = {
  juan:  { pin: '0000', nombre: 'Juan Pérez',       rol: 'usuario' },
  maria: { pin: '1111', nombre: 'María López',      rol: 'usuario' },
  ana:   { pin: '2222', nombre: 'Dra. Ana Torres',  rol: 'doctor' },
  laura: { pin: '3333', nombre: 'Laura Gómez',      rol: 'recepcionista' },
  luis:  { pin: '4444', nombre: 'Dr. Luis Ramírez', rol: 'doctor' },
  admin: { pin: '1234', nombre: 'Administrador',    rol: 'admin' }
};

export function leerEnv(archivo = new URL('../../.env.pruebas', import.meta.url)) {
  try {
    return Object.fromEntries(readFileSync(archivo, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}

// real: FIREBASE_REAL=1 · emulador: variables que pone "firebase emulators:exec"
export function entornoFirebase() {
  const real = !!process.env.FIREBASE_REAL;
  const env = leerEnv();
  const emulador = !real && process.env.FIRESTORE_EMULATOR_HOST
    ? { firestore: process.env.FIRESTORE_EMULATOR_HOST, auth: process.env.FIREBASE_AUTH_EMULATOR_HOST } : null;
  const config = real
    ? { apiKey: env.FIREBASE_API_KEY, projectId: env.FIREBASE_PROJECT_ID, authDomain: `${env.FIREBASE_PROJECT_ID}.firebaseapp.com` }
    : { apiKey: 'emulador', projectId: process.env.GCLOUD_PROJECT ?? 'demo-safemotion', authDomain: 'localhost' };
  const cuentas = Object.fromEntries(Object.entries(CUENTAS).map(([k, c]) => [k, {
    ...c, ...credencialesDePin(c.pin), uid: real ? env[`CUENTA_${k.toUpperCase()}_UID`] : null
  }]));
  return { real, emulador, config, cuentas, disponible: real ? !!env.FIREBASE_API_KEY : !!emulador };
}

// Documento de Firestore en formato REST (texto y booleanos).
export const campos = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) }])) });

// Emulador: crea las cuentas en Authentication y sus perfiles en Firestore (con permiso de administrador del emulador).
export async function prepararEmulador({ emulador, config, cuentas }) {
  for (const c of Object.values(cuentas)) {
    const auth = `http://${emulador.auth}/identitytoolkit.googleapis.com/v1/accounts`;
    const cuerpo = JSON.stringify({ email: c.correo, password: c.password, returnSecureToken: true });
    let r = await (await fetch(`${auth}:signUp?key=emulador`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo })).json();
    if (r.error) r = await (await fetch(`${auth}:signInWithPassword?key=emulador`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo })).json();
    c.uid = r.localId;
    await fetch(`http://${emulador.firestore}/v1/projects/${config.projectId}/databases/(default)/documents/usuarios/${c.uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(campos({ nombre: c.nombre, rol: c.rol, habilitado: true }))
    });
  }
  return cuentas;
}
