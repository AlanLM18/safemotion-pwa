// Práctica 11 · Pruebas contra PRODUCCIÓN: PWA en Vercel → /api/** (rewrite) → backend Spring en Render → Firebase real.
// SOLO pruebas que no crean, modifican ni borran datos: lecturas, validaciones que se rechazan antes de escribir,
// permisos (401/403/404), latencia, transferencia y carga de solo lectura. (El login actualiza ultimoInicioSesion,
// igual que cuando el usuario entra desde la app.)
// Ejecutar: node tests/whitebox/wb.prod.mjs [salida.json]
import { writeFile } from 'node:fs/promises';

const VERCEL = 'https://safemotion-pwa.vercel.app';
const RENDER = 'https://safemotion-backend.onrender.com';
const PROYECTO = 'mesaayuda-a631d';
const FS = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;
const salida = { fecha: new Date().toISOString(), base: VERCEL, casos: [], series: {}, transferencia: {}, carga: [] };

async function http(method, url, { token, body, raw, headers = {} } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method, signal: AbortSignal.timeout(90000),
      headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: token } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* no JSON */ }
    return { status: res.status, json, text, bytes: buf.length, headers: res.headers, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: e.message, bytes: 0, headers: new Headers(), ms: performance.now() - t0 };
  }
}
const api = (m, p, o) => http(m, VERCEL + p, o);
async function caso(id, descripcion, esperado, fn) {
  let estado = 'Aprobado', observado = '';
  try { observado = await fn(); } catch (e) { estado = 'Fallido'; observado = e.message; }
  salida.casos.push({ id, descripcion, esperado, observado, estado });
  console.log(`${estado === 'Aprobado' ? '✔' : '✖'} ${id} ${descripcion}\n     ${observado}`);
}
const exigir = (c, m) => { if (!c) throw new Error(m); };
const sinSecretos = (t) => !/"pin"|"password"|SafeMotion-\d{4}|"refreshToken"|private_key/i.test(t);
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const p = s.reduce((a, b) => a + b, 0) / s.length; const de = Math.sqrt(s.reduce((a, b) => a + (b - p) ** 2, 0) / s.length); return { n: s.length, min: +s[0].toFixed(1), prom: +p.toFixed(1), max: +s.at(-1).toFixed(1), de: +de.toFixed(1), p95: +s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)].toFixed(1) }; };
const mbps = (bytes, ms) => +((bytes * 8) / (ms / 1000) / 1e6).toFixed(2);

// Despertar el servicio (Render gratuito se suspende tras 15 min) y medir ese arranque
const frio = await api('GET', '/api/sistema/estado');
salida.arranque = { status: frio.status, ms: +frio.ms.toFixed(0) };
console.log(`Primera petición (posible arranque en frío): HTTP ${frio.status} en ${frio.ms.toFixed(0)} ms`);

const login = async (pin) => (await api('POST', '/api/auth/login', { body: { pin } })).json;
const juan = await login('0000'), maria = await login('1111'), ana = await login('2222'), laura = await login('3333'), admin = await login('1234');
exigir([juan, maria, ana, laura, admin].every((x) => x?.token), 'No se pudo iniciar sesión con las cuentas de prueba en producción');

// ───── Casos funcionales (sin escrituras)
await caso('PROD-01', 'Estado del servicio por el dominio de Vercel', '200, Firestore real disponible, sin datos de usuarios', async () => {
  const r = await api('GET', '/api/sistema/estado');
  exigir(r.status === 200 && r.json.emulador === false && r.json.firestore === 'disponible' && !('usuariosRegistrados' in r.json), `HTTP ${r.status}`);
  return `HTTP ${r.status}, ${r.json.baseDatos}, latencia interna a Firestore ${r.json.latenciaFirestoreMs} ms`;
});
await caso('PROD-02', 'Login con PIN y sesión', '200 con JWT de Firebase y usuario {id,nombre,rol}; /me 200', async () => {
  const r = await api('POST', '/api/auth/login', { body: { pin: '0000' } });
  const me = await api('GET', '/api/auth/me', { token: r.json.token });
  exigir(r.status === 200 && r.json.token.split('.').length === 3 && me.status === 200 && me.json.id === r.json.usuario.id, `HTTP ${r.status}/${me.status}`);
  exigir(sinSecretos(r.text), 'expone credenciales');
  return `HTTP ${r.status} y ${me.status}; ${r.json.usuario.nombre} (${r.json.usuario.rol}), UID de Firebase`;
});
await caso('PROD-03', 'PIN incorrecto y PIN mal formado', '401 y 400', async () => {
  const a = await api('POST', '/api/auth/login', { body: { pin: '9999' } });
  const b = await api('POST', '/api/auth/login', { body: { pin: '12' } });
  exigir(a.status === 401 && b.status === 400, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} "${a.json.error}" · HTTP ${b.status} "${b.json.error}"`;
});
await caso('PROD-04', 'Sin token, token inventado y JWT con el UID cambiado por el del admin', '401 en los tres (firma RS256 verificada)', async () => {
  const p = juan.token.split('.');
  const alterado = [p[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p[1], 'base64url')), user_id: admin.usuario.id, sub: admin.usuario.id })).toString('base64url'), p[2]].join('.');
  const rs = await Promise.all([undefined, 'token-inventado', alterado].map((t) => api('GET', '/api/usuarios', { token: t })));
  exigir(rs.every((r) => r.status === 401), rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')}`;
});
await caso('PROD-05', 'Permisos por rol (autenticado sin permiso)', '403: paciente→bandeja, recepción→bandeja, paciente→usuarios, doctora→pedir SOS', async () => {
  const rs = await Promise.all([
    api('GET', '/api/chat/conversaciones', { token: juan.token }), api('GET', '/api/chat/conversaciones', { token: laura.token }),
    api('GET', '/api/usuarios', { token: juan.token }), api('POST', '/api/emergencias', { token: ana.token, body: {} })
  ]);
  exigir(rs.every((r) => r.status === 403), rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')}`;
});
await caso('PROD-06', 'Juan intenta leer el chat de María (por la API y directo en Firestore)', '403 en ambos caminos', async () => {
  const a = await api('GET', `/api/chat/${maria.usuario.id}/mensajes`, { token: juan.token });
  const b = await http('GET', `${FS}/conversaciones/${maria.usuario.id}/mensajes?pageSize=1`, { token: `Bearer ${juan.token}` });
  exigir(a.status === 403 && b.status === 403, `API ${a.status}, Firestore ${b.status}`);
  return `API HTTP ${a.status} · Firestore (reglas) HTTP ${b.status}`;
});
await caso('PROD-07', 'Validaciones (se rechazan antes de escribir)', '400: FC 300, temperatura ausente, JSON mal formado, limite=0, mensaje vacío', async () => {
  const rs = await Promise.all([
    api('POST', '/api/mediciones', { token: juan.token, body: { frecuenciaCardiaca: 300, temperatura: 36.5, pasos: 1, calorias: 1, actividad: 'reposo', bateria: 50 } }),
    api('POST', '/api/mediciones', { token: juan.token, body: { frecuenciaCardiaca: 80, pasos: 1, calorias: 1, actividad: 'reposo', bateria: 50 } }),
    api('POST', '/api/mediciones', { token: juan.token, raw: '{"frecuenciaCardiaca": 80,' }),
    api('GET', '/api/mediciones/historial?limite=0', { token: juan.token }),
    api('POST', `/api/chat/${juan.usuario.id}/mensajes`, { token: juan.token, body: { texto: '   ' } })
  ]);
  exigir(rs.every((r) => r.status === 400 && !/trace|Exception|\.java/.test(r.text)), rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')}; p. ej. "${rs[0].json.error}"`;
});
await caso('PROD-08', 'Recursos inexistentes y método no permitido', '404, 404, 404 y 405 con formato JSON', async () => {
  const rs = await Promise.all([
    api('PATCH', '/api/emergencias/no-existe-wb/atender', { token: ana.token }),
    api('PATCH', '/api/emergencias/no-existe-wb/canalizar', { token: laura.token, body: { doctorId: ana.usuario.id } }),
    api('GET', '/api/chat/no-existe-wb/mensajes', { token: ana.token }),
    api('PUT', '/api/mediciones', { token: juan.token, body: {} })
  ]);
  exigir(rs.map((r) => r.status).join('/') === '404/404/404/405' && rs.every((r) => r.json?.status), rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')}`;
});
await caso('PROD-09', 'Lecturas por rol', '200: admin→usuarios, doctora→bandeja, recepción→doctores y SOS, paciente→historial y alertas', async () => {
  const rs = await Promise.all([
    api('GET', '/api/usuarios', { token: admin.token }), api('GET', '/api/chat/conversaciones', { token: ana.token }),
    api('GET', '/api/emergencias/doctores', { token: laura.token }), api('GET', '/api/emergencias', { token: laura.token }),
    api('GET', '/api/mediciones/historial?limite=5', { token: juan.token }), api('GET', '/api/alertas', { token: juan.token })
  ]);
  exigir(rs.every((r) => r.status === 200), rs.map((r) => r.status).join('/'));
  return `HTTP 200 ×6 · ${rs[0].json.length} cuentas · ${rs[1].json.length} pacientes en la bandeja · ${rs[2].json.length} doctores · ${rs[3].json.length} SOS · ${rs[4].json.length} lecturas · ${rs[5].json.length} alertas`;
});
await caso('PROD-10', 'Mismos datos por la API y directo en Firestore (token de Juan, reglas activas)', 'Las 5 lecturas más recientes coinciden', async () => {
  const a = (await api('GET', '/api/mediciones/historial?limite=5', { token: juan.token })).json.map((m) => m.id);
  const q = { structuredQuery: { from: [{ collectionId: 'mediciones' }], orderBy: [{ field: { fieldPath: 'fecha' }, direction: 'DESCENDING' }], limit: 5 } };
  const r = await http('POST', `${FS}/usuarios/${juan.usuario.id}:runQuery`, { token: `Bearer ${juan.token}`, body: q });
  const b = r.json.filter((x) => x.document).map((x) => x.document.name.split('/').pop());
  exigir(r.status === 200 && JSON.stringify(a) === JSON.stringify(b), `API ${a.join(',')} vs Firestore ${b.join(',')}`);
  return `${a.length} lecturas idénticas en el mismo orden (API y Firestore directo)`;
});
await caso('PROD-11', 'Datos sensibles en las respuestas', 'Sin PIN, contraseña, refresh token ni llaves', async () => {
  const cs = await Promise.all([api('POST', '/api/auth/login', { body: { pin: '0000' } }), api('GET', '/api/usuarios', { token: admin.token }),
    api('GET', '/api/emergencias', { token: ana.token }), api('GET', '/api/mediciones/historial?limite=20', { token: juan.token }), api('GET', '/api/sistema/estado')]);
  exigir(cs.every((c) => sinSecretos(c.text)), 'expone secretos');
  return 'Ningún cuerpo contiene PIN, contraseña, refresh token ni private_key';
});
await caso('PROD-12', 'CORS en producción', 'Origen ajeno sin Allow-Origin; la PWA y el dashboard permitidos', async () => {
  const pre = (o) => fetch(RENDER + '/api/mediciones', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } });
  const [a, b, c] = await Promise.all([pre('https://sitio-malicioso.example'), pre(VERCEL), pre('https://safemotion-dashboard.vercel.app')]);
  exigir(!a.headers.get('access-control-allow-origin') && b.headers.get('access-control-allow-origin') === VERCEL && c.headers.get('access-control-allow-origin'), `${a.status}/${b.status}/${c.status}`);
  return `ajeno HTTP ${a.status} sin Allow-Origin · PWA ${b.status} · dashboard ${c.status}`;
});

// ───── Latencia: 10 solicitudes consecutivas (endpoint real) por Vercel, directo a Render y directo a Firestore
async function serie(nombre, fn) {
  await fn();   // calentamiento
  const filas = [];
  for (let i = 1; i <= 10; i++) { const r = await fn(); filas.push({ solicitud: i, codigo: r.status, ms: +r.ms.toFixed(1), bytes: r.bytes }); }
  salida.series[nombre] = { filas, tiempo: stats(filas.map((f) => f.ms)) };
  console.log(`⏱ ${nombre}: ${JSON.stringify(salida.series[nombre].tiempo)} · ${filas[0].bytes} B · códigos ${[...new Set(filas.map((f) => f.codigo))]}`);
}
const q20 = { structuredQuery: { from: [{ collectionId: 'mediciones' }], orderBy: [{ field: { fieldPath: 'fecha' }, direction: 'DESCENDING' }], limit: 20 } };
await serie('historial20_vercel', () => api('GET', '/api/mediciones/historial?limite=20', { token: juan.token }));
await serie('historial20_render', () => http('GET', RENDER + '/api/mediciones/historial?limite=20', { token: juan.token }));
await serie('historial20_firestore_directo', () => http('POST', `${FS}/usuarios/${juan.usuario.id}:runQuery`, { token: `Bearer ${juan.token}`, body: q20 }));
await serie('estado_vercel', () => api('GET', '/api/sistema/estado'));
await serie('me_vercel', () => api('GET', '/api/auth/me', { token: juan.token }));
await serie('perfil_firestore_directo', () => http('GET', `${FS}/usuarios/${juan.usuario.id}`, { token: `Bearer ${juan.token}` }));
await serie('emergencias_vercel', () => api('GET', '/api/emergencias', { token: maria.token }));

// ───── Transferencia: descarga (historial grande) y subida (1 MiB que el backend rechaza con 400: no se guarda nada)
const desc = [], sub = [];
for (let i = 0; i < 3; i++) { const r = await api('GET', '/api/mediciones/historial?limite=500', { token: juan.token }); desc.push({ codigo: r.status, bytes: r.bytes, ms: +r.ms.toFixed(1), mbps: mbps(r.bytes, r.ms) }); }
const grande = JSON.stringify({ frecuenciaCardiaca: 300, temperatura: 36.5, pasos: 1, calorias: 1, actividad: 'reposo', bateria: 50, relleno: 'x'.repeat(1024 * 1024) });
for (let i = 0; i < 3; i++) { const r = await api('POST', '/api/mediciones', { token: juan.token, raw: grande }); sub.push({ codigo: r.status, bytes: Buffer.byteLength(grande), ms: +r.ms.toFixed(1), mbps: mbps(Buffer.byteLength(grande), r.ms) }); }
salida.transferencia = { descargas: desc, subidas: sub };
console.log('Descarga:', desc.map((d) => `${d.bytes} B ${d.ms} ms ${d.mbps} Mbps (HTTP ${d.codigo})`).join(' | '));
console.log('Subida  :', sub.map((d) => `${d.bytes} B ${d.ms} ms ${d.mbps} Mbps (HTTP ${d.codigo})`).join(' | '));

// ───── Carga controlada de SOLO LECTURA: 1, 5 y 10 usuarios, 40 solicitudes por escenario
async function escenario(nombre, usuarios, total, fn) {
  const tiempos = [], codigos = {}; let bytes = 0, fallidas = 0, i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: usuarios }, async () => {
    while (i < total) { i++; const r = await fn(); tiempos.push(r.ms); bytes += r.bytes; codigos[r.status] = (codigos[r.status] ?? 0) + 1; if (r.status < 200 || r.status >= 300) fallidas++; }
  }));
  const dur = performance.now() - t0;
  const fila = { escenario: nombre, usuarios, solicitudes: tiempos.length, exitosas: tiempos.length - fallidas, fallidas, codigos, ...stats(tiempos), rps: +(tiempos.length / (dur / 1000)).toFixed(1), mbps: mbps(bytes, dur) };
  salida.carga.push(fila);
  console.log(`${nombre} x${usuarios}: prom ${fila.prom} ms, p95 ${fila.p95} ms, ok ${fila.exitosas}/${fila.solicitudes}, ${fila.rps} req/s, códigos ${JSON.stringify(codigos)}`);
}
for (const u of [1, 5, 10]) await escenario('Lectura GET /api/mediciones/historial?limite=20', u, 40, () => api('GET', '/api/mediciones/historial?limite=20', { token: juan.token }));
for (const u of [1, 5, 10]) await escenario('Lectura GET /api/sistema/estado', u, 40, () => api('GET', '/api/sistema/estado'));

const ok = salida.casos.filter((c) => c.estado === 'Aprobado').length;
console.log(`\n${ok}/${salida.casos.length} casos aprobados en producción · ${salida.fecha}`);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(salida, null, 2));
