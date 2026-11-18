// Práctica 11 · Integración: la app (cliente real src/services/apiFirebase.js, sujeto a firestore.rules) y el backend
// Spring (Admin SDK) comparten los mismos datos de Firestore. Lo que escribe uno lo lee y lo continúa el otro.
// Requiere el emulador (auth + firestore con las reglas del proyecto) y el backend Spring conectado a él.
// Ejecutar: API_URL=http://localhost:8080 FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tests/whitebox/wb.interop.mjs [salida.json]
import { writeFile } from 'node:fs/promises';
import { createFirebaseApi } from '../../src/services/apiFirebase.js';
import { createMeasurement, toMedicionRequest } from '../../src/models/measurement.js';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const emulador = { firestore: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085', auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099' };
const config = { apiKey: 'emulador', projectId: process.env.GCLOUD_PROJECT ?? 'demo-safemotion', authDomain: 'localhost' };
const app = (nombre) => createFirebaseApi({ config, emulador, nombre });
const resultados = [];

const http = async (method, path, token, body) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
const springLogin = async (pin) => (await http('POST', '/api/auth/login', null, { pin })).json;
async function caso(id, descripcion, fn) {
  let estado = 'Aprobado', observado;
  try { observado = await fn(); } catch (e) { estado = 'Fallido'; observado = e.message; }
  resultados.push({ id, descripcion, observado, estado });
  console.log(`${estado === 'Aprobado' ? '✔' : '✖'} ${id} ${descripcion}\n     ${observado}`);
}
const exigir = (c, m) => { if (!c) throw new Error(m); };
const lectura = (userId, hr) => toMedicionRequest(createMeasurement({ userId, wearable: { heartRate: hr, spo2: 97, temperature: 36.6, steps: 10, calories: 1, battery: 80 }, gyroscope: { x: 0.1, y: 0.2, z: 0.3 }, activity: 'reposo' }));
// Campos que firestore.rules permite en una medición (función medicionValida)
const PERMITIDOS = ['frecuenciaCardiaca', 'temperatura', 'spo2', 'pasos', 'calorias', 'actividad', 'bateria', 'giroscopioX', 'giroscopioY', 'giroscopioZ', 'fuente', 'fechaCaptura', 'idLocal', 'pacienteId', 'alertas', 'fecha', 'id'];

const appJuan = app('juan'), appMaria = app('maria'), appAna = app('ana');
const sJuan = await appJuan.login('0000'), sMaria = await appMaria.login('1111'), sAna = await appAna.login('2222');
const spJuan = await springLogin('0000'), spLaura = await springLogin('3333'), spAna = await springLogin('2222'), spAdmin = await springLogin('1234');
exigir(sJuan.usuario.id === spJuan.usuario.id, 'la app y Spring no ven el mismo UID');

// Estado limpio: cerrar SOS activos de María
for (const e of (await http('GET', '/api/emergencias', spAdmin.token)).json.filter((x) => x.pacienteId === sMaria.usuario.id && x.estado !== 'ATENDIDA')) {
  if (e.estado === 'ABIERTA') await http('PATCH', `/api/emergencias/${e.id}/canalizar`, spLaura.token, { doctorId: sAna.usuario.id });
  await http('PATCH', `/api/emergencias/${e.id}/atender`, spAdmin.token);
}

await caso('INT-01', 'Mismo usuario: login de la app (Firebase SDK) y de Spring con el PIN 0000', async () =>
  `UID ${sJuan.usuario.id} en ambos · rol ${sJuan.usuario.rol}/${spJuan.usuario.rol}`);

await caso('INT-02', 'La app guarda una lectura (reglas activas) y Spring la devuelve en el historial', async () => {
  const req = lectura(sJuan.usuario.id, 77);
  await appJuan.enviarMedicion(req);
  const h = (await http('GET', '/api/mediciones/historial?limite=50', spJuan.token)).json;
  const m = h.find((x) => x.id === req.idLocal);
  exigir(m && m.frecuenciaCardiaca === 77 && m.giroscopioX === 0.1, 'Spring no ve la lectura de la app');
  return `id ${req.idLocal} visible en GET /api/mediciones/historial con FC ${m.frecuenciaCardiaca}`;
});

await caso('INT-03', 'Spring guarda una lectura y la app la lee; los campos cumplen el esquema de firestore.rules', async () => {
  const req = lectura(sJuan.usuario.id, 81);
  const r = await http('POST', '/api/mediciones', spJuan.token, req);
  const h = await appJuan.historial(null, 50);
  const m = h.find((x) => x.id === req.idLocal);
  const extra = Object.keys(r.json).filter((k) => !PERMITIDOS.includes(k));
  exigir(r.status === 201 && m && m.frecuenciaCardiaca === 81 && extra.length === 0, `HTTP ${r.status}, app ${!!m}, campos fuera de las reglas: ${extra}`);
  return `HTTP ${r.status}; la app la lee con FC ${m.frecuenciaCardiaca}; 0 campos fuera de medicionValida()`;
});

await caso('INT-04', 'La misma lectura enviada por la app y luego por Spring (mismo idLocal) no se duplica', async () => {
  const req = lectura(sJuan.usuario.id, 90);
  await appJuan.enviarMedicion(req);
  const r = await http('POST', '/api/mediciones', spJuan.token, req);
  const n = (await appJuan.historial(null, 100)).filter((x) => x.id === req.idLocal).length;
  exigir(r.status === 200 && n === 1, `HTTP ${r.status}, copias ${n}`);
  return `Spring responde HTTP ${r.status} (ya existía) y hay ${n} documento`;
});

let sosId;
await caso('INT-05', 'María pide SOS desde la app y recepción lo ve por la API de Spring', async () => {
  const e = await appMaria.crearEmergencia({ latitud: 20.6, longitud: -100.4, frecuenciaCardiaca: 118 });
  sosId = e.id;
  const lista = (await http('GET', '/api/emergencias', spLaura.token)).json;
  const v = lista.find((x) => x.id === sosId);
  exigir(v && v.estado === 'ABIERTA' && v.version === 0, 'recepción no ve el SOS');
  return `SOS ${sosId} ABIERTA, version ${v.version}, visible para recepción vía Spring`;
});

await caso('INT-06', 'Recepción canaliza por Spring y la app de María lo ve CANALIZADA (con aviso en su chat)', async () => {
  const r = await http('PATCH', `/api/emergencias/${sosId}/canalizar`, spLaura.token, { doctorId: sAna.usuario.id });
  const e = (await appMaria.emergencias()).find((x) => x.id === sosId);
  const chat = await appMaria.mensajes(sMaria.usuario.id);
  exigir(r.status === 200 && e.estado === 'CANALIZADA' && e.version === 1 && chat.some((m) => m.texto.includes('canalizó')), `HTTP ${r.status} ${e?.estado}`);
  return `HTTP ${r.status}; la app ve CANALIZADA (version ${e.version}) y el aviso "${chat.at(-1).texto.slice(0, 45)}…"`;
});

await caso('INT-07', 'La doctora atiende desde la app (las reglas exigen version + 1 sobre lo que escribió Spring)', async () => {
  const e = await appAna.atenderEmergencia(sosId);
  const v = (await http('GET', '/api/emergencias', spAna.token)).json.find((x) => x.id === sosId);
  exigir(e.estado === 'ATENDIDA' && v.estado === 'ATENDIDA' && v.version === 2 && v.atendidaPorUid === sAna.usuario.id, `${v?.estado} v${v?.version}`);
  return `Reglas aceptan el cambio; Spring ve ATENDIDA, version ${v.version}, atendidaPor ${v.atendidaPor}`;
});

await caso('INT-08', 'Chat cruzado: la doctora escribe por Spring y María lo lee en la app; María responde y Spring lo ve', async () => {
  await http('POST', `/api/chat/${sMaria.usuario.id}/mensajes`, spAna.token, { texto: 'Hola María, ¿cómo te sientes?' });
  await appMaria.enviarMensaje(sMaria.usuario.id, 'Mejor, gracias');
  const app = await appMaria.mensajes(sMaria.usuario.id);
  const sp = (await http('GET', `/api/chat/${sMaria.usuario.id}/mensajes`, spAna.token)).json;
  exigir(app.some((m) => m.texto === 'Hola María, ¿cómo te sientes?') && sp.some((m) => m.texto === 'Mejor, gracias'), 'mensajes no compartidos');
  return `${app.length} mensajes en la app = ${sp.length} en Spring`;
});

await caso('INT-09', 'Reglas: la app de Juan NO puede leer el chat de María (Spring tampoco se lo permite)', async () => {
  let regla;
  try { await appJuan.mensajes(sMaria.usuario.id); regla = 'permitido'; } catch (e) { regla = e.status; }
  const sp = await http('GET', `/api/chat/${sMaria.usuario.id}/mensajes`, spJuan.token);
  exigir(regla === 403 && sp.status === 403, `reglas ${regla}, Spring ${sp.status}`);
  return `Firestore rules: ${regla} · Spring: HTTP ${sp.status} (misma política)`;
});

const ok = resultados.filter((r) => r.estado === 'Aprobado').length;
console.log(`\n${ok}/${resultados.length} casos aprobados`);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ fecha: new Date().toISOString(), resultados }, null, 2));
process.exit(0);
