// Práctica 12 · Deja el emulador de Firebase en un estado inicial idéntico antes de cada corrida (antes / después):
// borra Firestore y Authentication, crea las 6 cuentas de prueba y siembra 60 lecturas por paciente.
// Así las mediciones son comparables: el emulador recorre la colección completa en cada consulta ordenada, y su
// tiempo crece con el volumen (a diferencia de Firestore real, que usa índices).
// Ejecutar: FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tests/estres/preparar-emulador.mjs
import { CUENTAS, prepararEmulador } from '../support/firebaseCuentas.js';
import { credencialesDePin } from '../../src/models/user.js';

const emulador = { firestore: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085', auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099' };
const PROYECTO = process.env.GCLOUD_PROJECT ?? 'demo-safemotion';
const RAIZ = `projects/${PROYECTO}/databases/(default)/documents`;

const r1 = await fetch(`http://${emulador.firestore}/emulator/v1/${RAIZ}`, { method: 'DELETE' });
const r2 = await fetch(`http://${emulador.auth}/emulator/v1/projects/${PROYECTO}/accounts`, { method: 'DELETE' });
if (!r1.ok || !r2.ok) throw new Error(`No se pudo limpiar el emulador (${r1.status}/${r2.status})`);

const cuentas = Object.fromEntries(Object.entries(CUENTAS).map(([k, c]) => [k, { ...c, ...credencialesDePin(c.pin) }]));
await prepararEmulador({ emulador, config: { projectId: PROYECTO }, cuentas });

const ahora = Date.now();
const writes = [];
for (const p of [cuentas.juan, cuentas.maria]) {
  for (let i = 0; i < 60; i++) {
    const id = `semilla${i}`;
    writes.push({ update: { name: `${RAIZ}/usuarios/${p.uid}/mediciones/${id}`, fields: {
      frecuenciaCardiaca: { integerValue: 60 + (i % 40) }, temperatura: { doubleValue: 36.6 }, spo2: { integerValue: 97 }, pasos: { integerValue: i },
      calorias: { integerValue: 1 }, actividad: { stringValue: 'caminando' }, bateria: { integerValue: 80 }, idLocal: { stringValue: id },
      pacienteId: { stringValue: p.uid }, alertas: { arrayValue: {} }, fecha: { timestampValue: new Date(ahora - i * 5000).toISOString() } } } });
  }
}
const r3 = await fetch(`http://${emulador.firestore}/v1/${RAIZ}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ writes }) });
if (!r3.ok) throw new Error('siembra ' + r3.status);
console.log(`Emulador limpio: 6 cuentas y ${writes.length} lecturas (60 por paciente)`);
