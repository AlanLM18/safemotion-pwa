// Prácticas 9 y 10 sobre Firebase: la app (src/services/apiFirebase.js) y las reglas (firestore.rules) con una
// instancia por "dispositivo": paciente, recepción y doctores. Además se escribe directo con el SDK, como haría un
// cliente modificado, para comprobar que lo no autorizado lo rechaza Firestore y no solo la interfaz.
//   Emulador:       npm run test:firebase
//   Proyecto real:  FIREBASE_REAL=1 npm run test:firebase:real   (cuentas de .env.pruebas)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp } from 'firebase/firestore';
import { createFirebaseApi } from '../src/services/apiFirebase.js';
import { createMeasurement, toMedicionRequest } from '../src/models/measurement.js';
import { entornoFirebase, prepararEmulador } from './support/firebaseCuentas.js';

const ent = entornoFirebase();
const opts = { skip: !ent.disponible && 'Ejecuta con el emulador (npm run test:firebase) o con FIREBASE_REAL=1' };
const C = ent.cuentas;
const d = {};   // dispositivos: instancia de la app con su sesión
const nuevo = (nombre) => createFirebaseApi({ config: ent.config, emulador: ent.emulador, nombre: `${nombre}-${Date.now().toString(36)}` });
const denegado = (e) => e?.code === 'permission-denied' || e?.status === 403;
const lectura = (userId, fc = 80) => toMedicionRequest(createMeasurement({ userId, wearable: { heartRate: fc, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 }, gyroscope: { x: 0.1, y: -0.2, z: 0.3 }, activity: 'caminando' }));
const ATENDER = (uid, nombre) => ({ estado: 'ATENDIDA', atendidaPor: nombre, atendidaPorUid: uid, fechaAtencion: serverTimestamp() });

before(async () => {
  if (opts.skip) return;
  if (ent.emulador) await prepararEmulador(ent);
  for (const [k, inst] of [['juan', 'juan'], ['juan2', 'juan'], ['maria', 'maria'], ['laura', 'laura'], ['laura2', 'laura'], ['ana', 'ana'], ['luis', 'luis'], ['admin', 'admin']]) {
    d[k] = nuevo(k);
    await d[k].login(C[inst].pin);
  }
  d.anonimo = nuevo('anonimo');
});
after(async () => {
  for (const x of Object.values(d)) await x.logout().catch(() => {});
  setTimeout(() => process.exit(0), 300).unref();   // cierra los canales de Firestore
});

// Cierra cualquier SOS activo de Juan para empezar un caso limpio (recepción canaliza con Ana y Ana atiende).
async function sinSosActivo(paciente = 'juan') {
  for (const e of await d[paciente].emergencias()) {
    if (e.estado === 'ABIERTA') await d.laura.canalizarEmergencia(e.id, C.ana.uid ?? d.ana.auth.currentUser.uid);
    if (e.estado !== 'ATENDIDA') await d.admin.atenderEmergencia(e.id);
  }
}
const uid = (k) => d[k].auth.currentUser.uid;

// ---------- Práctica 9: los datos viajan entre los dispositivos de cada rol ----------

test('DB-01 paciente, recepción y doctor usan el mismo proyecto y colecciones, cada uno con su sesión', opts, async () => {
  const proyectos = new Set(Object.values(d).map((x) => x.db.app.options.projectId));
  assert.equal(proyectos.size, 1);
  const [e1, e2] = [await d.juan.estado(), await d.laura.estado()];
  assert.equal(e1.baseDatos, e2.baseDatos);
  assert.deepEqual([e1.rol, e2.rol, (await d.ana.estado()).rol], ['usuario', 'recepcionista', 'doctor']);
});

test('DB-02/03 el SOS que crea el paciente lo ve recepción', opts, async () => {
  await sinSosActivo();
  const sos = await d.juan.crearEmergencia({ frecuenciaCardiaca: 124, spo2: 90, temperatura: 38.2 });
  assert.equal(sos.estado, 'ABIERTA');
  const enRecepcion = (await d.laura.emergencias()).find((e) => e.id === sos.id);
  assert.equal(enRecepcion.paciente, 'Juan Pérez');
  assert.equal(enRecepcion.frecuenciaCardiaca, 124);
});

test('DB-04/05 recepción canaliza con un doctor y el paciente ve el cambio y el aviso en su chat', opts, async () => {
  const [sos] = (await d.laura.emergencias()).filter((e) => e.pacienteId === uid('juan') && e.estado === 'ABIERTA');
  const c = await d.laura.canalizarEmergencia(sos.id, uid('ana'));
  assert.deepEqual([c.estado, c.canalizadaANombre, c.canalizadaPorNombre], ['CANALIZADA', 'Dra. Ana Torres', 'Laura Gómez']);
  const [visto] = await d.juan.emergencias();
  assert.equal(visto.estado, 'CANALIZADA');
  assert.ok((await d.juan.mensajes(uid('juan'))).some((m) => m.rol === 'recepcionista' && m.texto.includes('Dra. Ana Torres')));
});

test('DB-06 el doctor atiende y el cambio llega al paciente y a recepción; ve la medición del paciente', opts, async () => {
  const [sos] = await d.juan.emergencias();
  await assert.rejects(d.luis.atenderEmergencia(sos.id), { status: 403 });            // no se le canalizó a él
  const a = await d.ana.atenderEmergencia(sos.id);
  assert.equal(a.estado, 'ATENDIDA');
  assert.equal((await d.juan.emergencias())[0].estado, 'ATENDIDA');
  assert.equal((await d.laura.emergencias()).find((e) => e.id === sos.id).atendidaPor, 'Dra. Ana Torres');
  const req = lectura(uid('juan'), 101);
  await d.juan.enviarMedicion(req);
  assert.equal((await d.ana.ultimaMedicion(uid('juan'))).frecuenciaCardiaca, 101);
});

test('DB-07 dos recepcionistas canalizan el mismo SOS a la vez: gana una y la otra ve con quién quedó', opts, async () => {
  await sinSosActivo();
  const sos = await d.juan.crearEmergencia({});
  const r = await Promise.allSettled([d.laura.canalizarEmergencia(sos.id, uid('ana')), d.laura2.canalizarEmergencia(sos.id, uid('luis'))]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.status ?? 'ok').join(', '));
  const perdio = r.find((x) => x.status === 'rejected').reason;
  assert.equal(perdio.status, 409);
  assert.equal(perdio.datos.actual.estado, 'CANALIZADA');
  const final = (await d.juan.emergencias()).find((e) => e.id === sos.id);
  assert.equal(final.version, 1);
  assert.equal(final.canalizadaANombre, r.find((x) => x.status === 'fulfilled').value.canalizadaANombre);
});

test('DB-08 lo confirmado sigue ahí al abrir la app de nuevo; reenviar una medición no la duplica', opts, async () => {
  const req = lectura(uid('juan'), 88);
  await d.juan.enviarMedicion(req);
  await d.juan.enviarMedicion(req);                                                     // reintento (D-02)
  const reabierta = nuevo('juan-reabierta');
  await reabierta.login(C.juan.pin);
  const h = await reabierta.historial(null, 50);
  assert.equal(h.filter((m) => m.idLocal === req.idLocal).length, 1);
  assert.ok((await reabierta.emergencias()).length >= 2);
  await reabierta.logout();
});

// ---------- Práctica 10: cada rol solo hace lo que le toca, y lo rechaza Firestore ----------

test('SEG-01/02 correo y contraseña válidos entran con su UID y rol; una contraseña incorrecta se rechaza', opts, async () => {
  assert.notEqual(uid('juan'), uid('maria'));
  const intruso = nuevo('intruso');
  await assert.rejects(intruso.login('9876'), { status: 401 });   // PIN que no existe
  assert.equal(intruso.auth.currentUser, null);
});

test('SEG-03 el SOS y la medición quedan con el UID del paciente autenticado', opts, async () => {
  const req = lectura(uid('maria'));
  await d.maria.enviarMedicion(req);
  const m = await getDoc(doc(d.maria.db, 'usuarios', uid('maria'), 'mediciones', req.idLocal));
  assert.equal(m.data().pacienteId, uid('maria'));
  await sinSosActivo('maria');
  const sos = await d.maria.crearEmergencia({});
  assert.equal((await getDoc(doc(d.maria.db, 'emergencias', sos.id))).data().pacienteId, uid('maria'));
});

test('SEG-04 suplantación: Juan no puede crear un SOS ni una medición a nombre de María', opts, async () => {
  await assert.rejects(setDoc(doc(collection(d.juan.db, 'emergencias')), { pacienteId: uid('maria'), paciente: 'María López', fecha: serverTimestamp(), estado: 'ABIERTA', version: 0 }), denegado);
  const req = lectura(uid('maria'));
  await assert.rejects(setDoc(doc(d.juan.db, 'usuarios', uid('maria'), 'mediciones', req.idLocal), { ...req, pacienteId: uid('maria'), fecha: serverTimestamp() }), denegado);
});

test('SEG-05 lectura ajena: Juan no ve datos de María; recepción no ve mediciones ni chat', opts, async () => {
  await assert.rejects(getDocs(collection(d.juan.db, 'usuarios', uid('maria'), 'mediciones')), denegado);
  await assert.rejects(d.juan.mensajes(uid('maria')), { status: 403 });
  await assert.rejects(getDocs(query(collection(d.juan.db, 'emergencias'), where('pacienteId', '==', uid('maria')))), denegado);
  await assert.rejects(getDocs(collection(d.juan.db, 'emergencias')), denegado);       // listar todos los SOS
  await assert.rejects(d.laura.ultimaMedicion(uid('juan')), { status: 403 });
  await assert.rejects(d.laura.mensajes(uid('juan')), { status: 403 });
});

test('SEG-06 actualización ajena o fuera de su rol: denegada', opts, async () => {
  const [sos] = (await d.maria.emergencias()).filter((e) => e.estado === 'ABIERTA');
  await assert.rejects(updateDoc(doc(d.juan.db, 'emergencias', sos.id), { estado: 'CANALIZADA', version: 1 }), denegado);     // otro paciente
  await assert.rejects(d.maria.canalizarEmergencia(sos.id, uid('ana')), { status: 403 });                                   // el paciente no canaliza
  await assert.rejects(updateDoc(doc(d.laura.db, 'emergencias', sos.id), { ...ATENDER(uid('laura'), 'Laura Gómez'), version: 1 }), denegado);   // recepción no atiende
  await assert.rejects(updateDoc(doc(d.laura.db, 'emergencias', sos.id), { estado: 'CANALIZADA', canalizadaA: uid('juan'), canalizadaANombre: 'Juan', canalizadaPor: uid('laura'), canalizadaPorNombre: 'Laura', fechaCanalizacion: serverTimestamp(), version: 1 }), denegado);   // canalizar a alguien que no es doctor
  await assert.rejects(updateDoc(doc(d.ana.db, 'emergencias', sos.id), { ...ATENDER(uid('ana'), 'Dra. Ana Torres'), version: 1 }), denegado);   // atender sin canalizar
});

test('SEG-07 eliminación: nadie borra SOS ni mediciones, y Juan no borra el chat de María', opts, async () => {
  const [sos] = await d.maria.emergencias();
  await assert.rejects(deleteDoc(doc(d.maria.db, 'emergencias', sos.id)), denegado);
  await assert.rejects(deleteDoc(doc(d.admin.db, 'emergencias', sos.id)), denegado);
  const [m] = await d.maria.historial(null, 1);
  await assert.rejects(deleteDoc(doc(d.maria.db, 'usuarios', uid('maria'), 'mediciones', m.id)), denegado);
  const [msg] = await d.maria.mensajes(uid('maria'));
  await assert.rejects(deleteDoc(doc(d.juan.db, 'conversaciones', uid('maria'), 'mensajes', msg.id)), denegado);
});

test('SEG-08 operaciones propias permitidas: medición, cambio de nombre y mensaje en su chat', opts, async () => {
  await d.juan.enviarMedicion(lectura(uid('juan'), 77));
  await updateDoc(doc(d.juan.db, 'usuarios', uid('juan')), { nombre: 'Juan Pérez' });
  const m = await d.juan.enviarMensaje(uid('juan'), 'Hola, ¿me puede revisar?');
  assert.equal(m.autorId, uid('juan'));
});

test('SEG-09 cambio de propietario o de rol: rechazado', opts, async () => {
  await assert.rejects(updateDoc(doc(d.juan.db, 'usuarios', uid('juan')), { rol: 'doctor' }), denegado);                   // escalar privilegios
  await assert.rejects(setDoc(doc(d.juan.db, 'usuarios', uid('juan')), { nombre: 'Juan', correo: C.juan.correo, rol: 'admin' }), denegado);
  const [sos] = (await d.maria.emergencias()).filter((e) => e.estado === 'ABIERTA');
  await assert.rejects(updateDoc(doc(d.maria.db, 'emergencias', sos.id), { pacienteId: uid('juan'), version: sos.version + 1 }), denegado);
});

test('SEG-10 sin sesión no se puede leer ni escribir', opts, async () => {
  await assert.rejects(getDocs(collection(d.anonimo.db, 'emergencias')), denegado);
  await assert.rejects(getDoc(doc(d.anonimo.db, 'usuarios', uid('juan'))), denegado);
  await assert.rejects(setDoc(doc(collection(d.anonimo.db, 'emergencias')), { pacienteId: 'nadie', estado: 'ABIERTA', version: 0 }), denegado);
  await assert.rejects(d.anonimo.emergencias(), { status: 401 });
});

// ---------- Cambios posteriores: cuentas deshabilitadas, ambulancia y SpO2 opcional ----------

test('SEG-11 una cuenta que el administrador deshabilita no puede entrar ni operar, y nadie más la deshabilita', opts, async () => {
  await assert.rejects(updateDoc(doc(d.juan.db, 'usuarios', uid('maria')), { habilitado: false }), denegado);   // solo el admin
  await updateDoc(doc(d.admin.db, 'usuarios', uid('maria')), { habilitado: false });
  try {
    const otra = nuevo('maria-deshabilitada');
    await assert.rejects(otra.login(C.maria.pin), { status: 403 });
    const req = lectura(uid('maria'));
    await assert.rejects(setDoc(doc(d.maria.db, 'usuarios', uid('maria'), 'mediciones', req.idLocal), { ...req, pacienteId: uid('maria'), fecha: serverTimestamp() }), denegado);
  } finally {
    await updateDoc(doc(d.admin.db, 'usuarios', uid('maria')), { habilitado: true });
  }
  await d.maria.enviarMedicion(lectura(uid('maria')));                                   // habilitada otra vez
});

test('Ambulancia: el doctor la solicita desde el chat y al paciente le llega el aviso', opts, async () => {
  const { mensajeAmbulancia, esMensajeAmbulancia } = await import('../src/models/emergencia.js');
  await d.ana.enviarMensaje(uid('juan'), mensajeAmbulancia('Dra. Ana Torres'));
  const ultimo = (await d.juan.mensajes(uid('juan'))).at(-1);
  assert.ok(esMensajeAmbulancia(ultimo.texto));
  assert.deepEqual([ultimo.autor, ultimo.rol], ['Dra. Ana Torres', 'doctor']);
  await assert.rejects(d.laura.mensajes(uid('juan')), { status: 403 });                 // recepción sigue sin leer el chat
});

test('CP-21 una lectura de wearable BLE sin SpO2 se guarda sin ese dato (no como 0 %)', opts, async () => {
  const req = toMedicionRequest(createMeasurement({ userId: uid('juan'), wearable: { heartRate: 82, battery: 90, temperature: 36.6 } }));
  await d.juan.enviarMedicion(req);
  const guardada = (await getDoc(doc(d.juan.db, 'usuarios', uid('juan'), 'mediciones', req.idLocal))).data();
  assert.equal(guardada.spo2, null);
  assert.deepEqual(guardada.alertas, []);
});
