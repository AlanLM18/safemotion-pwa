// Práctica 11 · DB-15: dos teléfonos de la misma paciente piden SOS a la vez usando la app directo contra Firestore
// (sin Spring). Requiere el emulador. Ejecutar: node tests/whitebox/wb.sos-app-concurrente.mjs
import { createFirebaseApi } from '../../src/services/apiFirebase.js';
const emulador = { firestore: '127.0.0.1:8085', auth: '127.0.0.1:9099' }, config = { apiKey: 'emulador', projectId: 'demo-safemotion', authDomain: 'localhost' };
const tel1 = createFirebaseApi({ config, emulador, nombre: 't1' }), tel2 = createFirebaseApi({ config, emulador, nombre: 't2' });
const lab = createFirebaseApi({ config, emulador, nombre: 'lab' }), adm = createFirebaseApi({ config, emulador, nombre: 'adm' });
await tel1.login('1111'); await tel2.login('1111'); await lab.login('3333'); await adm.login('1234');
const anaId = (await lab.doctores()).find((d) => d.nombre.startsWith('Dra.')).id;
const cerrar = async () => { for (const e of (await adm.emergencias()).filter((x) => x.paciente === 'María López' && x.estado !== 'ATENDIDA')) { if (e.estado === 'ABIERTA') await lab.canalizarEmergencia(e.id, anaId); await adm.atenderEmergencia(e.id); } };
await cerrar();
let dup = 0;
for (let i = 0; i < 10; i++) {
  await Promise.all([tel1.crearEmergencia({}), tel2.crearEmergencia({})]);
  const activas = (await adm.emergencias()).filter((x) => x.paciente === 'María López' && x.estado !== 'ATENDIDA').length;
  if (activas > 1) dup++;
  await cerrar();
}
console.log(`App (Firebase directo): ${dup}/10 rondas con 2 SOS activos de la misma paciente (dos teléfonos a la vez)`);
process.exit(0);
