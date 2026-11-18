// Práctica 11 · Fase 4: White Box de la base de datos (Cloud Firestore).
// Las operaciones se hacen por la API de Spring (como lo haría un cliente) y se verifican LEYENDO DIRECTAMENTE los
// documentos en Firestore (API REST del emulador con privilegios de administrador). También se prueban las reglas de
// seguridad (firestore.rules) con el token de un paciente y se miden tiempos de consulta directos vs. por la API.
// Solo emulador: siembra datos, deshabilita cuentas y genera concurrencia.
// Ejecutar: API_URL=http://localhost:8080 FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tests/whitebox/wb.db.mjs [salida.json]
import { writeFile } from 'node:fs/promises';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const FS = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const PROYECTO = process.env.GCLOUD_PROJECT ?? 'demo-safemotion';
const DOCS = `http://${FS}/v1/projects/${PROYECTO}/databases/(default)/documents`;
const resultados = [];
const salida = { fecha: new Date().toISOString(), resultados, tiempos: [] };

// ---------- clientes ----------
async function http(method, path, token, body) {
  const t0 = performance.now();
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, ms: performance.now() - t0 };
}
// Firestore REST directo. token = 'owner' (administrador del emulador, ignora reglas) o un ID token (aplica reglas).
async function fs(method, ruta, { token = 'owner', body } = {}) {
  const t0 = performance.now();
  const r = await fetch(`${DOCS}${ruta}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, ms: performance.now() - t0 };
}
const valor = (v) => v == null ? undefined : 'nullValue' in v ? null : v.integerValue != null ? Number(v.integerValue) : v.doubleValue ?? v.stringValue ?? v.booleanValue ?? v.timestampValue ?? (v.arrayValue ? (v.arrayValue.values ?? []).map(valor) : v);
const plano = (doc) => Object.fromEntries(Object.entries(doc?.fields ?? {}).map(([k, v]) => [k, valor(v)]));
const tipos = (doc) => Object.fromEntries(Object.entries(doc?.fields ?? {}).map(([k, v]) => [k, Object.keys(v)[0]]));
// Consulta estructurada (runQuery) sobre una colección dentro de "padre"
async function consulta(padre, coleccion, { where, orderBy, limit, token = 'owner' } = {}) {
  const sq = { from: [{ collectionId: coleccion }] };
  if (where) sq.where = { fieldFilter: { field: { fieldPath: where[0] }, op: 'EQUAL', value: { stringValue: where[1] } } };
  if (orderBy) sq.orderBy = [{ field: { fieldPath: orderBy }, direction: 'DESCENDING' }];
  if (limit) sq.limit = limit;
  const r = await fs('POST', `${padre}:runQuery`, { token, body: { structuredQuery: sq } });
  return { ...r, docs: Array.isArray(r.json) ? r.json.filter((x) => x.document).map((x) => x.document) : [] };
}
const contar = async (padre, coleccion) => (await consulta(padre, coleccion)).docs.length;
const idToken = async (pin) => (await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulador`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${pin}@pin.safemotion.app`, password: `SafeMotion-${pin}`, returnSecureToken: true })
})).json()).idToken;

async function caso(id, descripcion, esperado, fn) {
  let estado = 'Aprobado', observado = '';
  try { observado = await fn(); } catch (e) { estado = 'Fallido'; observado = e.message; }
  resultados.push({ id, descripcion, esperado, observado, estado });
  console.log(`${estado === 'Aprobado' ? '✔' : '✖'} ${id} ${descripcion}\n     esperado: ${esperado}\n     observado: ${observado}`);
}
const exigir = (c, m) => { if (!c) throw new Error(m); };
const login = async (pin) => (await http('POST', '/api/auth/login', null, { pin })).json;
const nuevoId = () => 'wb' + crypto.randomUUID().replace(/-/g, '');
const medicion = (extra = {}) => ({ frecuenciaCardiaca: 72, temperatura: 36.4, spo2: 98, pasos: 30, calorias: 2, actividad: 'reposo', bateria: 70, idLocal: nuevoId(), ...extra });

let juan = await login('0000');
const maria = await login('1111'), ana = await login('2222'), laura = await login('3333'), admin = await login('1234');
const J = juan.usuario.id, M = maria.usuario.id;
async function cerrarSosDe(uid) {
  for (const e of (await http('GET', '/api/emergencias', admin.token)).json.filter((x) => x.pacienteId === uid && x.estado !== 'ATENDIDA')) {
    if (e.estado === 'ABIERTA') await http('PATCH', `/api/emergencias/${e.id}/canalizar`, laura.token, { doctorId: ana.usuario.id });
    await http('PATCH', `/api/emergencias/${e.id}/atender`, admin.token);
  }
}
await cerrarSosDe(J); await cerrarSosDe(M);

// ---------- CRUD ----------
let medId;
await caso('DB-01', 'Inserción válida (POST /api/mediciones) y lectura directa del documento', 'Documento usuarios/{uid}/mediciones/{idLocal} con los mismos valores y tipos', async () => {
  const body = medicion();
  const r = await http('POST', '/api/mediciones', juan.token, body);
  const d = await fs('GET', `/usuarios/${J}/mediciones/${body.idLocal}`);
  const p = plano(d.json), t = tipos(d.json);
  exigir(r.status === 201 && d.status === 200 && p.frecuenciaCardiaca === 72 && p.temperatura === 36.4 && p.pacienteId === J, `HTTP ${r.status}/${d.status}`);
  exigir(t.frecuenciaCardiaca === 'integerValue' && t.temperatura === 'doubleValue' && t.fecha === 'timestampValue', JSON.stringify(t));
  medId = body.idLocal;
  return `HTTP ${r.status}; Firestore: FC ${p.frecuenciaCardiaca} (${t.frecuenciaCardiaca}), temp ${p.temperatura} (${t.temperatura}), fecha ${t.fecha}, pacienteId = UID`;
});
await caso('DB-02', 'Inserción con datos incompletos o inválidos (actividad vacía, FC 10, sin batería)', '400 y ningún documento creado', async () => {
  const ids = [nuevoId(), nuevoId(), nuevoId()];
  const { bateria, ...sinBateria } = medicion({ idLocal: ids[2] });
  const rs = [await http('POST', '/api/mediciones', juan.token, medicion({ idLocal: ids[0], actividad: '' })),
    await http('POST', '/api/mediciones', juan.token, medicion({ idLocal: ids[1], frecuenciaCardiaca: 10 })),
    await http('POST', '/api/mediciones', juan.token, sinBateria)];
  const existen = await Promise.all(ids.map((id) => fs('GET', `/usuarios/${J}/mediciones/${id}`)));
  exigir(rs.every((r) => r.status === 400) && existen.every((d) => d.status === 404), `${rs.map((r) => r.status)} / ${existen.map((d) => d.status)}`);
  return `HTTP ${rs.map((r) => r.status).join('/')}; los 3 documentos responden 404 en Firestore`;
});
let sosId;
await caso('DB-03', 'Consulta por identificador existente (SOS creado por la API)', 'Mismos datos en la API y en el documento emergencias/{id}', async () => {
  const c = await http('POST', '/api/emergencias', maria.token, { latitud: 20.6, longitud: -100.4 });
  sosId = c.json.id;
  const d = plano((await fs('GET', `/emergencias/${sosId}`)).json);
  exigir(d.estado === 'ABIERTA' && d.pacienteId === M && d.version === 0 && d.latitud === 20.6, JSON.stringify(d));
  return `id ${sosId}: API estado ${c.json.estado} = Firestore ${d.estado}, version ${d.version}, pacienteId = UID de María`;
});
await caso('DB-04', 'Consulta por identificador inexistente', '404 en la API y 404 en Firestore', async () => {
  const a = await http('PATCH', '/api/emergencias/id-que-no-existe/atender', ana.token);
  const b = await fs('GET', '/emergencias/id-que-no-existe');
  exigir(a.status === 404 && b.status === 404, `${a.status}/${b.status}`);
  return `API HTTP ${a.status} · Firestore HTTP ${b.status}`;
});
await caso('DB-05', 'Actualización: canalizar y atender; consulta posterior (persistencia)', 'estado ATENDIDA, version 2, atendidaPorUid y fechas guardadas', async () => {
  await http('PATCH', `/api/emergencias/${sosId}/canalizar`, laura.token, { doctorId: ana.usuario.id });
  await http('PATCH', `/api/emergencias/${sosId}/atender`, ana.token);
  const d = plano((await fs('GET', `/emergencias/${sosId}`)).json);
  exigir(d.estado === 'ATENDIDA' && d.version === 2 && d.atendidaPorUid === ana.usuario.id && d.fechaCanalizacion && d.fechaAtencion, JSON.stringify(d));
  return `Firestore: ${d.estado}, version ${d.version}, canalizadaA ${d.canalizadaANombre}, atendidaPor ${d.atendidaPor}`;
});
await caso('DB-06', 'Eliminación: DELETE /api/chat/{uid}/mensajes y conteo posterior', '0 mensajes de Juan; los de María no cambian', async () => {
  for (const t of ['uno', 'dos', 'tres']) await http('POST', `/api/chat/${J}/mensajes`, juan.token, { texto: t });
  const antesM = await contar(`/conversaciones/${M}`, 'mensajes');
  const r = await http('DELETE', `/api/chat/${J}/mensajes`, ana.token);
  const j = await contar(`/conversaciones/${J}`, 'mensajes'), m = await contar(`/conversaciones/${M}`, 'mensajes');
  exigir(r.status === 204 && j === 0 && m === antesM, `${r.status} ${j} ${m}/${antesM}`);
  return `HTTP ${r.status}; Juan ${j} mensajes; María ${m} (sin cambio)`;
});
await caso('DB-07', 'Persistencia tras cerrar sesión y entrar de nuevo', 'La lectura de DB-01 sigue en el historial con el token nuevo', async () => {
  await new Promise((r) => setTimeout(r, 1100));
  await http('POST', '/api/auth/logout', juan.token);
  juan = await login('0000');
  const h = (await http('GET', '/api/mediciones/historial?limite=500', juan.token)).json;
  exigir(h.some((x) => x.id === medId), 'no está');
  return `Lectura ${medId.slice(0, 12)}… presente con la sesión nueva`;
});
await caso('DB-08', 'Atomicidad: el SOS crea la emergencia y el mensaje en una sola transacción', 'Ambos documentos existen (o ninguno)', async () => {
  await cerrarSosDe(J);
  const antes = await contar(`/conversaciones/${J}`, 'mensajes');
  const r = await http('POST', '/api/emergencias', juan.token, { frecuenciaCardiaca: 130, spo2: 90 });
  const e = await fs('GET', `/emergencias/${r.json.id}`);
  const despues = await contar(`/conversaciones/${J}`, 'mensajes');
  exigir(r.status === 201 && e.status === 200 && despues === antes + 1, `${r.status} ${e.status} ${antes}->${despues}`);
  await cerrarSosDe(J);
  return `HTTP ${r.status}; emergencia guardada y mensajes ${antes} → ${despues} ("SOS: … FC 130 bpm. SpO2 90 %.")`;
});

// ---------- Concurrencia ----------
await caso('DB-09', 'Concurrencia: 2 SOS simultáneos del mismo paciente (10 rondas)', 'Nunca más de 1 emergencia activa por paciente', async () => {
  let duplicadas = 0; const codigos = {};
  for (let i = 0; i < 10; i++) {
    const rs = await Promise.all([1, 2].map(() => http('POST', '/api/emergencias', maria.token, { latitud: 20 + i / 100, longitud: -100 })));
    rs.forEach((r) => { codigos[r.status] = (codigos[r.status] ?? 0) + 1; });
    const activas = (await consulta('', 'emergencias', { where: ['pacienteId', M] })).docs.map(plano).filter((e) => e.estado !== 'ATENDIDA').length;
    if (activas > 1) duplicadas++;
    await cerrarSosDe(M);
  }
  exigir(duplicadas === 0, `${duplicadas}/10 rondas con 2 activas`);
  return `0/10 rondas con duplicado; respuestas: ${Object.entries(codigos).map(([k, v]) => `${v}× HTTP ${k}`).join(', ')}`;
});
await caso('DB-10', 'Concurrencia: dos recepcionistas canalizan el mismo SOS a la vez (5 rondas)', 'Una gana (200), la otra recibe 409 con cómo quedó; un solo aviso', async () => {
  const det = [];
  for (let i = 0; i < 5; i++) {
    const id = (await http('POST', '/api/emergencias', maria.token, {})).json.id;
    const antes = await contar(`/conversaciones/${M}`, 'mensajes');
    const rs = await Promise.all([laura, admin].map((u) => http('PATCH', `/api/emergencias/${id}/canalizar`, u.token, { doctorId: ana.usuario.id })));
    const avisos = (await contar(`/conversaciones/${M}`, 'mensajes')) - antes;
    const st = rs.map((r) => r.status).sort().join('/');
    det.push(`${st}·${avisos}`);
    exigir(st === '200/409' && avisos === 1, `ronda ${i + 1}: ${st}, avisos ${avisos}`);
    await cerrarSosDe(M);
  }
  return `5/5 rondas con 200/409 y 1 aviso (${det.join(' ')})`;
});
await caso('DB-11', 'Concurrencia: la doctora y el admin atienden el mismo SOS a la vez', 'Un solo cambio de estado y un solo aviso "fue atendida"', async () => {
  const id = (await http('POST', '/api/emergencias', maria.token, {})).json.id;
  await http('PATCH', `/api/emergencias/${id}/canalizar`, laura.token, { doctorId: ana.usuario.id });
  const antes = await contar(`/conversaciones/${M}`, 'mensajes');
  const rs = await Promise.all([ana, admin].map((u) => http('PATCH', `/api/emergencias/${id}/atender`, u.token)));
  const avisos = (await contar(`/conversaciones/${M}`, 'mensajes')) - antes;
  const d = plano((await fs('GET', `/emergencias/${id}`)).json);
  exigir(avisos === 1 && d.version === 2, `HTTP ${rs.map((r) => r.status)}, avisos ${avisos}, version ${d.version}`);
  return `HTTP ${rs.map((r) => r.status).join('/')}; 1 aviso; version ${d.version}; atendidaPor ${d.atendidaPor}`;
});
await caso('DB-12', 'Concurrencia: 5 reintentos simultáneos de la misma lectura (mismo idLocal)', '1 documento; 1×201 y 4×200', async () => {
  const body = medicion();
  const rs = await Promise.all(Array.from({ length: 5 }, () => http('POST', '/api/mediciones', juan.token, body)));
  const d = await fs('GET', `/usuarios/${J}/mediciones/${body.idLocal}`);
  const c = rs.map((r) => r.status).sort().join('/');
  exigir(d.status === 200 && c === '200/200/200/200/201', c);
  return `HTTP ${c}; un solo documento ${body.idLocal.slice(0, 12)}…`;
});

// ---------- Seguridad: reglas de Firestore para clientes directos (la app) ----------
await caso('DB-13', 'Reglas: acceso directo a Firestore sin pasar por Spring', 'Sin sesión 403; Juan no lee a María, no escribe FC 300 ni cambia su rol', async () => {
  const tj = await idToken('0000');
  const anon = await fs('GET', '/usuarios', { token: null });
  const ajena = await consulta(`/usuarios/${M}`, 'mediciones', { token: tj });
  const id = nuevoId();
  const fuera = await fs('PATCH', `/usuarios/${J}/mediciones/${id}`, { token: tj, body: { fields: { frecuenciaCardiaca: { integerValue: 300 }, temperatura: { doubleValue: 36.5 }, pasos: { integerValue: 1 }, calorias: { integerValue: 1 }, actividad: { stringValue: 'reposo' }, bateria: { integerValue: 50 }, idLocal: { stringValue: id }, pacienteId: { stringValue: J } } } });
  const rol = await fs('PATCH', `/usuarios/${J}?updateMask.fieldPaths=rol`, { token: tj, body: { fields: { rol: { stringValue: 'admin' } } } });
  exigir(anon.status === 403 && ajena.status === 403 && fuera.status === 403 && rol.status === 403, `${anon.status} ${ajena.status} ${fuera.status} ${rol.status}`);
  return `HTTP ${anon.status} / ${ajena.status} / ${fuera.status} / ${rol.status} (PERMISSION_DENIED)`;
});
await caso('DB-14', 'Inyección en un sistema NoSQL', 'El texto se guarda literal como string; no altera la consulta', async () => {
  const payload = "'); DROP TABLE mensajes; -- {\"$where\": \"1==1\"}";
  const r = await http('POST', `/api/chat/${J}/mensajes`, juan.token, { texto: payload });
  const d = (await consulta(`/conversaciones/${J}`, 'mensajes')).docs.map(plano).find((m) => m.texto === payload);
  const t = tipos((await consulta(`/conversaciones/${J}`, 'mensajes')).docs.find((x) => plano(x).texto === payload));
  exigir(r.status === 201 && d && t.texto === 'stringValue', `HTTP ${r.status}`);
  return `HTTP ${r.status}; guardado literal como ${t.texto}; Firestore no interpreta texto como consulta`;
});

// ---------- Tiempos de consulta: directo a Firestore vs. por la API ----------
const sembrar = async (n) => {
  for (let i = 0; i < n; i += 250) {
    const writes = Array.from({ length: Math.min(250, n - i) }, (_, k) => {
      const id = `seed${String(i + k).padStart(5, '0')}`;
      return { update: { name: `projects/${PROYECTO}/databases/(default)/documents/usuarios/${J}/mediciones/${id}`, fields: {
        frecuenciaCardiaca: { integerValue: 60 + ((i + k) % 40) }, temperatura: { doubleValue: 36.6 }, spo2: { integerValue: 97 }, pasos: { integerValue: 50 },
        calorias: { integerValue: 3 }, actividad: { stringValue: 'caminando' }, bateria: { integerValue: 80 }, idLocal: { stringValue: id }, pacienteId: { stringValue: J },
        alertas: { arrayValue: {} }, fecha: { timestampValue: new Date(Date.now() - (i + k) * 5000).toISOString() } } } };
    });
    const r = await fetch(`http://${FS}/v1/projects/${PROYECTO}/databases/(default)/documents:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ writes }) });
    if (!r.ok) throw new Error(`siembra: HTTP ${r.status}`);
  }
};
const ya = await contar(`/usuarios/${J}`, 'mediciones');
if (ya < 2000) await sembrar(2000);
salida.medicionesDeJuan = await contar(`/usuarios/${J}`, 'mediciones');
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const p = s.reduce((a, b) => a + b, 0) / s.length; return { min: +s[0].toFixed(2), prom: +p.toFixed(2), max: +s.at(-1).toFixed(2) }; };
async function medir(nombre, directo, porApi) {
  await directo(); await porApi();   // calentamiento
  const d = [], a = [];
  for (let i = 0; i < 10; i++) { d.push((await directo()).ms); a.push((await porApi()).ms); }
  const fila = { consulta: nombre, directo: stats(d), api: stats(a) };
  salida.tiempos.push(fila);
  console.log(`⏱ ${nombre}: directo ${JSON.stringify(fila.directo)} · API ${JSON.stringify(fila.api)}`);
}
await medir('Q1 historial: usuarios/{uid}/mediciones orderBy fecha desc limit 20', () => consulta(`/usuarios/${J}`, 'mediciones', { orderBy: 'fecha', limit: 20 }), () => http('GET', '/api/mediciones/historial?limite=20', juan.token));
await medir('Q2 SOS del paciente: emergencias where pacienteId == uid', () => consulta('', 'emergencias', { where: ['pacienteId', M] }), () => http('GET', '/api/emergencias', maria.token));
await medir('Q3 perfil: usuarios/{uid} (lo hace cada petición autenticada)', () => fs('GET', `/usuarios/${J}`), () => http('GET', '/api/auth/me', juan.token));
await medir('Q4 doctores: usuarios where rol == doctor', () => consulta('', 'usuarios', { where: ['rol', 'doctor'] }), () => http('GET', '/api/emergencias/doctores', laura.token));

const ok = resultados.filter((r) => r.estado === 'Aprobado').length;
console.log(`\n${ok}/${resultados.length} casos aprobados · ${salida.medicionesDeJuan} mediciones de Juan en Firestore`);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(salida, null, 2));
