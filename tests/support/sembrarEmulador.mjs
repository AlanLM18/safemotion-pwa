// Crea en el emulador de Firebase las cuentas de prueba de SafeMotion (una por rol) con su perfil en Firestore.
// Lo usan las pruebas del backend Spring (tests/whitebox) cuando el backend corre contra el emulador.
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tests/support/sembrarEmulador.mjs
import { CUENTAS, prepararEmulador } from './firebaseCuentas.js';
import { credencialesDePin } from '../../src/models/user.js';

const emulador = { firestore: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085', auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099' };
const config = { projectId: process.env.GCLOUD_PROJECT ?? 'demo-safemotion' };
const cuentas = Object.fromEntries(Object.entries(CUENTAS).map(([k, c]) => [k, { ...c, ...credencialesDePin(c.pin) }]));
await prepararEmulador({ emulador, config, cuentas });
for (const c of Object.values(cuentas)) console.log(`PIN ${c.pin}  ${c.rol.padEnd(13)} ${c.nombre.padEnd(17)} UID ${c.uid}`);
