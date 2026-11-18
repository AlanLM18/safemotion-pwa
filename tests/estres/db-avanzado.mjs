// Práctica 12 · Fase 4: pruebas avanzadas de base de datos (Cloud Firestore, emulador).
// Cada consulta se mide 10 veces directo contra Firestore (API REST, administrador del emulador) y por la API de
// Spring, con número de registros, bytes, lecturas de Firestore por solicitud (contadores del backend) y una
// verificación de integridad al final. Solo emulador: siembra datos y genera escrituras concurrentes.
// Ejecutar: API_URL=http://localhost:8080 FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node tests/estres/db-avanzado.mjs salida.json
import { writeFile } from 'node:fs/promises';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const FS = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085';
const PROYECTO = process.env.GCLOUD_PROJECT ?? 'demo-safemotion';
const RAIZ = `projects/${PROYECTO}/databases/(default)/documents`;
const DOCS = `http://${FS}/v1/${RAIZ}`;
const salida = { fecha: new Date().toISOString(), etiqueta: process.env.ETIQUETA ?? 'corrida', consultas: [], concurrencia: [], integridad: {} };

async function http(method, url, { token, body } = {}) {
  const t0 = performance.now();
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch { /* vacío */ }
  return { status: r.status, json, bytes: buf.length, ms: performance.now() - t0 };
}
const api = (m, p, o) => http(m, API + p, o);
const fs = (m, p, body) => http(m, DOCS + p, { token: 'Bearer owner', body });
const runQuery = (padre, sq) => fs('POST', `${padre}:runQuery`, { structuredQuery: sq });
const ops = async () => (await api('GET', '/api/sistema/estado')).json.operaciones;
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { min: +s[0].toFixed(2), prom: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), max: +s.at(-1).toFixed(2) }; };
const login = async (pin) => (await api('POST', '/api/auth/login', { body: { pin } })).json;

const juan = await login('0000'), maria = await login('1111'), ana = await login('2222'), laura = await login('3333'), admin = await login('1234');
const J = juan.usuario.id, M = maria.usuario.id;

// ---------- siembra (idempotente: mismos IDs) ----------
async function commit(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const r = await fetch(`http://${FS}/v1/${RAIZ}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ writes: writes.slice(i, i + 400) }) });
    if (!r.ok) throw new Error('siembra ' + r.status);
  }
}
const ahora = Date.now();
await commit(Array.from({ length: 2000 }, (_, k) => ({ update: { name: `${RAIZ}/usuarios/${J}/mediciones/seed${String(k).padStart(5, '0')}`, fields: {
  frecuenciaCardiaca: { integerValue: 55 + (k % 70) }, temperatura: { doubleValue: 36.6 }, spo2: { integerValue: 97 }, pasos: { integerValue: 50 }, calorias: { integerValue: 3 },
  actividad: { stringValue: k % 3 ? 'caminando' : 'reposo' }, bateria: { integerValue: 80 }, idLocal: { stringValue: `seed${k}` }, pacienteId: { stringValue: J },
  alertas: k % 70 > 55 ? { arrayValue: { values: [{ stringValue: 'Frecuencia cardiaca alta' }] } } : { arrayValue: {} },
  fecha: { timestampValue: new Date(ahora - k * 5000).toISOString() } } } })));
// Historial de SOS ya atendidos (para la consulta de recepción, que hoy descarga la colección completa)
await commit(Array.from({ length: 1500 }, (_, k) => ({ update: { name: `${RAIZ}/emergencias/hist${String(k).padStart(5, '0')}`, fields: {
  pacienteId: { stringValue: k % 2 ? J : M }, paciente: { stringValue: k % 2 ? 'Juan Pérez' : 'María López' }, fecha: { timestampValue: new Date(ahora - 86400000 - k * 60000).toISOString() },
  latitud: { nullValue: null }, longitud: { nullValue: null }, frecuenciaCardiaca: { integerValue: 120 }, spo2: { nullValue: null }, temperatura: { nullValue: null },
  estado: { stringValue: 'ATENDIDA' }, version: { integerValue: 2 }, atendidaPor: { stringValue: 'Dra. Ana Torres' } } } })));
console.log('Siembra: 2 000 mediciones de Juan y 1 500 SOS atendidos');

async function medir(id, nombre, directo, porApi, registros) {
  await directo?.(); await porApi?.();
  const d = [], a = []; let rd = null, ra = null, opsPorSolic = null;
  for (let i = 0; i < 10; i++) {
    if (directo) { rd = await directo(); d.push(rd.ms); }
    if (porApi) {
      const o0 = await ops(); ra = await porApi(); a.push(ra.ms); const o1 = await ops();
      opsPorSolic = { lecturas: o1.lecturasFirestore - o0.lecturasFirestore - 1, perfil: o1.lecturasPerfil - o0.lecturasPerfil, verificaciones: o1.verificacionesToken - o0.verificacionesToken };
    }
  }
  const fila = { id, nombre, directo: d.length ? { ...stats(d), registros: registros(rd, 'directo'), bytes: rd.bytes } : null,
    api: a.length ? { ...stats(a), registros: registros(ra, 'api'), bytes: ra.bytes, codigo: ra.status, operacionesPorSolicitud: opsPorSolic } : null };
  salida.consultas.push(fila);
  console.log(`${id} ${nombre}\n   directo: ${JSON.stringify(fila.directo)}\n   api: ${JSON.stringify(fila.api)}`);
}
const nDocs = (r, modo) => modo === 'directo' ? (Array.isArray(r.json) ? r.json.filter((x) => x.document).length : (r.json?.fields ? 1 : 0)) : (Array.isArray(r.json) ? r.json.length : (r.json ? 1 : 0));

// 1. por identificador
await medir('DB-1', 'Consulta individual por identificador (usuarios/{uid}/mediciones/{id} · perfil por la API)',
  () => fs('GET', `/usuarios/${J}/mediciones/seed00010`), () => api('GET', '/api/auth/me', { token: juan.token }), nDocs);
// 2. conjunto pequeño
const q = (limite, extra = {}) => ({ from: [{ collectionId: 'mediciones' }], orderBy: [{ field: { fieldPath: 'fecha' }, direction: 'DESCENDING' }], limit: limite, ...extra });
await medir('DB-2', 'Conjunto pequeño: 20 lecturas más recientes', () => runQuery(`/usuarios/${J}`, q(20)), () => api('GET', '/api/mediciones/historial?limite=20', { token: juan.token }), nDocs);
// 3. conjunto grande
await medir('DB-3', 'Conjunto grande: 500 lecturas (máximo de la API) · 2 000 directo', () => runQuery(`/usuarios/${J}`, q(2000)), () => api('GET', '/api/mediciones/historial?limite=500', { token: juan.token }), nDocs);
// 4. con filtros
await medir('DB-4a', 'Filtro por campo: SOS de una paciente (where pacienteId == uid)',
  () => runQuery('', { from: [{ collectionId: 'emergencias' }], where: { fieldFilter: { field: { fieldPath: 'pacienteId' }, op: 'EQUAL', value: { stringValue: M } } } }),
  () => api('GET', '/api/emergencias', { token: maria.token }), nDocs);
await medir('DB-4b', 'Filtro para recepción: lista de SOS (API) · SOS activos where estado in [ABIERTA, CANALIZADA] (directo)',
  () => runQuery('', { from: [{ collectionId: 'emergencias' }], where: { fieldFilter: { field: { fieldPath: 'estado' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'ABIERTA' }, { stringValue: 'CANALIZADA' }] } } } } }),
  () => api('GET', '/api/emergencias', { token: laura.token }), nDocs);
await medir('DB-4c', 'Filtro en el cliente: alertas de las últimas 100 lecturas (/api/alertas)', null, () => api('GET', '/api/alertas', { token: juan.token }), nDocs);

// 5. actualizaciones concurrentes (registros distintos) y 6. escrituras simultáneas sobre el mismo registro
async function nuevoSos() {
  for (const e of (await api('GET', '/api/emergencias', { token: maria.token })).json.filter((x) => x.estado !== 'ATENDIDA')) {
    if (e.estado === 'ABIERTA') await api('PATCH', `/api/emergencias/${e.id}/canalizar`, { token: laura.token, body: { doctorId: ana.usuario.id } });
    await api('PATCH', `/api/emergencias/${e.id}/atender`, { token: admin.token });
  }
  return (await api('POST', '/api/emergencias', { token: maria.token, body: {} })).json.id;
}
{ // DB-5: 10 actualizaciones concurrentes sobre registros DISTINTOS (10 lecturas reenviadas a la vez por 2 pacientes)
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', '/api/mediciones', { token: i % 2 ? maria.token : juan.token, body: { frecuenciaCardiaca: 70, temperatura: 36.5, spo2: 97, pasos: 1, calorias: 1, actividad: 'reposo', bateria: 50, idLocal: `conc${salida.etiqueta}${ahora}${i}` } })));
  const c = {}; rs.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
  const fila = { id: 'DB-5', nombre: '20 escrituras concurrentes sobre registros distintos (2 pacientes)', ms: +(performance.now() - t0).toFixed(1), codigos: c, tiempos: stats(rs.map((r) => r.ms)) };
  salida.concurrencia.push(fila); console.log(fila.id, JSON.stringify(fila));
}
{ // DB-6a: 10 canalizaciones simultáneas del MISMO SOS (transacción + version)
  const id = await nuevoSos();
  const cuentas = [laura, admin];
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => api('PATCH', `/api/emergencias/${id}/canalizar`, { token: cuentas[i % 2].token, body: { doctorId: ana.usuario.id } })));
  const c = {}; rs.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
  const doc = (await fs('GET', `/emergencias/${id}`)).json.fields;
  const avisos = (await runQuery(`/conversaciones/${M}`, { from: [{ collectionId: 'mensajes' }] })).json.filter((x) => x.document && x.document.fields.texto.stringValue.startsWith('Recepción canalizó')).length;
  const fila = { id: 'DB-6a', nombre: '10 canalizaciones simultáneas del mismo SOS', ms: +(performance.now() - t0).toFixed(1), codigos: c, tiempos: stats(rs.map((r) => r.ms)), versionFinal: Number(doc.version.integerValue), estadoFinal: doc.estado.stringValue, avisosCanalizacion: avisos };
  salida.concurrencia.push(fila); console.log(fila.id, JSON.stringify(fila));
}
{ // DB-6b: 20 escrituras simultáneas del MISMO documento (mismo idLocal)
  const body = { frecuenciaCardiaca: 71, temperatura: 36.5, spo2: 97, pasos: 1, calorias: 1, actividad: 'reposo', bateria: 50, idLocal: `mismo${salida.etiqueta}${ahora}` };
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 20 }, () => api('POST', '/api/mediciones', { token: juan.token, body })));
  const c = {}; rs.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
  const existe = (await fs('GET', `/usuarios/${J}/mediciones/${body.idLocal}`)).status === 200;
  const fila = { id: 'DB-6b', nombre: '20 escrituras simultáneas del mismo registro (mismo idLocal)', ms: +(performance.now() - t0).toFixed(1), codigos: c, tiempos: stats(rs.map((r) => r.ms)), documentosResultantes: existe ? 1 : 0 };
  salida.concurrencia.push(fila); console.log(fila.id, JSON.stringify(fila));
}
{ // DB-6c: 10 SOS simultáneos de la misma paciente
  await nuevoSos(); await (async () => { const l = (await api('GET', '/api/emergencias', { token: maria.token })).json.filter((x) => x.estado !== 'ATENDIDA'); for (const e of l) { await api('PATCH', `/api/emergencias/${e.id}/canalizar`, { token: laura.token, body: { doctorId: ana.usuario.id } }); await api('PATCH', `/api/emergencias/${e.id}/atender`, { token: admin.token }); } })();
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/api/emergencias', { token: maria.token, body: {} })));
  const c = {}; rs.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
  const activas = (await runQuery('', { from: [{ collectionId: 'emergencias' }], where: { fieldFilter: { field: { fieldPath: 'pacienteId' }, op: 'EQUAL', value: { stringValue: M } } } })).json.filter((x) => x.document && x.document.fields.estado.stringValue !== 'ATENDIDA').length;
  const fila = { id: 'DB-6c', nombre: '10 SOS simultáneos de la misma paciente', ms: +(performance.now() - t0).toFixed(1), codigos: c, tiempos: stats(rs.map((r) => r.ms)), sosActivosResultantes: activas };
  salida.concurrencia.push(fila); console.log(fila.id, JSON.stringify(fila));
}

// ---------- integridad ----------
const versiones = (await runQuery('', { from: [{ collectionId: 'emergencias' }] })).json.filter((x) => x.document).map((x) => x.document.fields);
const incoherentes = versiones.filter((f) => { const v = Number(f.version?.integerValue ?? 0), e = f.estado?.stringValue; return (e === 'ABIERTA' && v !== 0) || (e === 'CANALIZADA' && v !== 1) || (e === 'ATENDIDA' && v !== 2); }).length;
const activasPorPaciente = {}; versiones.filter((f) => f.estado.stringValue !== 'ATENDIDA').forEach((f) => { const p = f.pacienteId.stringValue; activasPorPaciente[p] = (activasPorPaciente[p] ?? 0) + 1; });
salida.integridad = { emergencias: versiones.length, versionIncoherente: incoherentes, pacientesConMasDeUnSosActivo: Object.values(activasPorPaciente).filter((n) => n > 1).length };
console.log('Integridad:', JSON.stringify(salida.integridad));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(salida, null, 2));
process.exit(0);
