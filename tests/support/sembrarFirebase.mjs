// Crea (o reutiliza) en el proyecto real las cuentas de SafeMotion, una por PIN, y su perfil con rol; guarda los UID
// en .env.pruebas. Los perfiles se escriben con la sesión de la CLI de Firebase (dueño del proyecto), porque las
// reglas no dejan que nadie cree cuentas ni se asigne un rol desde la app.
//   npx firebase-tools@14 projects:list   (renueva la sesión de la CLI)
//   node tests/support/sembrarFirebase.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CUENTAS, leerEnv, campos } from './firebaseCuentas.js';
import { credencialesDePin } from '../../src/models/user.js';

const ARCHIVO = new URL('../../.env.pruebas', import.meta.url);
const env = leerEnv(ARCHIVO);
const KEY = env.FIREBASE_API_KEY, PROYECTO = env.FIREBASE_PROJECT_ID;
const oauth = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, 'utf8')).tokens?.access_token;
if (!KEY || !PROYECTO || !oauth) throw new Error('Faltan FIREBASE_API_KEY/FIREBASE_PROJECT_ID en .env.pruebas o la sesión de la CLI');
const H = { 'Content-Type': 'application/json', Referer: 'https://safemotion-pwa.vercel.app/' };
const auth = (accion, cuerpo) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${accion}?key=${KEY}`, { method: 'POST', headers: H, body: JSON.stringify(cuerpo) }).then((r) => r.json());

const salida = { FIREBASE_API_KEY: KEY, FIREBASE_PROJECT_ID: PROYECTO };
for (const [clave, c] of Object.entries(CUENTAS)) {
  const { correo, password } = credencialesDePin(c.pin);
  let r = await auth('signInWithPassword', { email: correo, password, returnSecureToken: true });
  if (r.error) r = await auth('signUp', { email: correo, password, returnSecureToken: true });
  if (r.error) throw new Error(`PIN ${c.pin}: ${r.error.message}`);
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/usuarios/${r.localId}`, {
    method: 'PATCH', headers: { ...H, Authorization: `Bearer ${oauth}` }, body: JSON.stringify(campos({ nombre: c.nombre, rol: c.rol, habilitado: true }))
  });
  if (!res.ok) throw new Error(`perfil del PIN ${c.pin}: HTTP ${res.status} ${await res.text()}`);
  salida[`CUENTA_${clave.toUpperCase()}_UID`] = r.localId;
  console.log(`PIN ${c.pin}  ${c.rol.padEnd(13)} ${c.nombre.padEnd(17)} UID ${r.localId}`);
}

writeFileSync(ARCHIVO, ['# Proyecto de Firebase y UID de las cuentas de prueba (se entra con el PIN). No se sube a git ni a Vercel.',
  ...Object.entries(salida).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n');
