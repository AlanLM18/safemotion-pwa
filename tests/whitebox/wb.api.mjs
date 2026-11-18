// Práctica 11 · Fase 3: White Box del servicio web (Spring Boot sobre Firebase, safemotion-ai/backend).
// Cada caso nombra el controlador/servicio que lo resuelve y verifica código HTTP, estructura JSON y que no se
// expongan datos sensibles. Corre contra el backend conectado al EMULADOR de Firebase (crea, cambia y deshabilita
// cuentas): no usar contra el proyecto real.
// Ejecutar: API_URL=http://localhost:8080 node tests/whitebox/wb.api.mjs [salida.json]
import { writeFile } from 'node:fs/promises';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT = process.argv[2];
const resultados = [];

export async function http(method, path, { token, body, raw, headers = {} } = {}) {
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: token } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* no JSON */ }
  return { status: res.status, json, text, headers: res.headers, bytes: Buffer.byteLength(text), ms: +(performance.now() - t0).toFixed(1) };
}

async function caso(id, componente, descripcion, esperado, fn) {
  let estado = 'Aprobado', observado = '';
  try { observado = await fn(); } catch (e) { estado = 'Fallido'; observado = e.message; }
  if (estado === 'Aprobado' && observado.startsWith('No aplica')) estado = 'No aplica';
  resultados.push({ id, componente, descripcion, esperado, observado, estado });
  console.log(`${estado === 'Aprobado' ? '✔' : estado === 'No aplica' ? '–' : '✖'} ${id} ${descripcion}\n     esperado: ${esperado}\n     observado: ${observado}`);
}
const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };
const sinSecretos = (t) => !/"pin"|"password"|SafeMotion-\d{4}|"refreshToken"/i.test(t);
const login = async (pin) => (await http('POST', '/api/auth/login', { body: { pin } })).json;
const idLocal = () => 'wb' + crypto.randomUUID().replace(/-/g, '');

const juan = await login('0000'), maria = await login('1111'), ana = await login('2222'), admin = await login('1234');
let luis = await login('4444');
let laura = await login('3333');
const EMULADOR = (await http('GET', '/api/sistema/estado')).json?.emulador === true;
exigir([juan, maria, ana, laura, luis, admin].every((x) => x?.token), 'No se pudo iniciar sesión con las cuentas de prueba (¿se sembró el emulador?)');
const medicion = (extra = {}) => ({ frecuenciaCardiaca: 78, temperatura: 36.5, spo2: 97, pasos: 100, calorias: 4, actividad: 'caminando', bateria: 88, idLocal: idLocal(), ...extra });
// Estado limpio: sin SOS activos de María (de corridas anteriores)
for (const e of (await http('GET', '/api/emergencias', { token: maria.token })).json.filter((x) => x.estado !== 'ATENDIDA')) {
  if (e.estado === 'ABIERTA') await http('PATCH', `/api/emergencias/${e.id}/canalizar`, { token: laura.token, body: { doctorId: ana.usuario.id } });
  await http('PATCH', `/api/emergencias/${e.id}/atender`, { token: admin.token });
}

// ───── 2xx
await caso('API-01', 'AuthController.login → AuthService.login (Identity Toolkit)', 'POST /api/auth/login con PIN válido', '200 {token, expiraEnSegundos, usuario{id,nombre,rol}}; sin PIN ni contraseña', async () => {
  const r = await http('POST', '/api/auth/login', { body: { pin: '0000' } });
  exigir(r.status === 200, `HTTP ${r.status}`);
  exigir(r.json.token.split('.').length === 3, 'el token no es un JWT');
  exigir(JSON.stringify(Object.keys(r.json.usuario).sort()) === '["id","nombre","rol"]', 'claves de usuario: ' + Object.keys(r.json.usuario));
  exigir(sinSecretos(r.text), 'expone credenciales');
  return `HTTP ${r.status}, ${r.bytes} B, ${r.ms} ms, JWT de Firebase (${r.json.expiraEnSegundos} s), usuario.id = UID`;
});
let medId;
await caso('API-02', 'MedicionController.registrar → MedicionService (transacción)', 'POST /api/mediciones válida', '201 Created + Location; id = idLocal', async () => {
  const body = medicion();
  const r = await http('POST', '/api/mediciones', { token: juan.token, body });
  exigir(r.status === 201 && r.json.id === body.idLocal, `HTTP ${r.status} id=${r.json?.id}`);
  exigir(r.headers.get('location') === `/api/mediciones/${body.idLocal}`, 'sin Location');
  medId = body;
  return `HTTP ${r.status}, Location ${r.headers.get('location')}, claves: ${Object.keys(r.json).sort().join(',')}`;
});
await caso('API-03', 'MedicionService.registrar (idempotencia)', 'Reenviar la misma lectura (mismo idLocal)', '200 con la lectura ya guardada; no crea otra', async () => {
  const r = await http('POST', '/api/mediciones', { token: juan.token, body: medId });
  exigir(r.status === 200 && r.json.id === medId.idLocal, `HTTP ${r.status}`);
  return `HTTP ${r.status}, mismo id ${r.json.id}`;
});
let sosId;
await caso('API-04', 'EmergenciaController.crear → AtencionService (transacción)', 'POST /api/emergencias (paciente sin SOS activo)', '201 y duplicada=false', async () => {
  const r = await http('POST', '/api/emergencias', { token: maria.token, body: { latitud: 20.59, longitud: -100.39, frecuenciaCardiaca: 120 } });
  exigir(r.status === 201 && r.json.duplicada === false, `HTTP ${r.status} duplicada=${r.json?.duplicada}`);
  sosId = r.json.id;
  return `HTTP ${r.status}, id=${sosId}, estado=${r.json.estado}, version=${r.json.version}`;
});
await caso('API-05', 'AtencionService.crearEmergencia', 'POST /api/emergencias repetido', '200 y duplicada=true (mismo id)', async () => {
  const r = await http('POST', '/api/emergencias', { token: maria.token, body: {} });
  exigir(r.status === 200 && r.json.duplicada === true && r.json.id === sosId, `HTTP ${r.status} id=${r.json?.id}`);
  return `HTTP ${r.status}, mismo id`;
});
await caso('API-06', 'ChatController.limpiar → AtencionService.limpiar (WriteBatch)', 'DELETE /api/chat/{uid}/mensajes como doctora', '204 sin cuerpo', async () => {
  await http('POST', `/api/chat/${juan.usuario.id}/mensajes`, { token: juan.token, body: { texto: 'mensaje para borrar' } });
  const r = await http('DELETE', `/api/chat/${juan.usuario.id}/mensajes`, { token: ana.token });
  exigir(r.status === 204 && r.bytes === 0, `HTTP ${r.status} ${r.bytes} B`);
  return `HTTP ${r.status}, ${r.bytes} B`;
});
await caso('API-07', 'ChatController.enviar', 'POST mensaje del paciente a su chat', '201 Created con el mensaje', async () => {
  const r = await http('POST', `/api/chat/${juan.usuario.id}/mensajes`, { token: juan.token, body: { texto: '  Hola doctora  ' } });
  exigir(r.status === 201 && r.json.texto === 'Hola doctora' && r.json.pacienteId === juan.usuario.id, `HTTP ${r.status} ${r.text}`);
  return `HTTP ${r.status}, texto recortado "${r.json.texto}"`;
});

// ───── 400
await caso('API-08', 'ManejadorErrores (HttpMessageNotReadable)', 'POST /api/mediciones con JSON mal formado', '400 {status,error} sin traza', async () => {
  const r = await http('POST', '/api/mediciones', { token: juan.token, raw: '{"frecuenciaCardiaca": 80,' });
  exigir(r.status === 400 && !/trace|Exception|\.java/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  return `HTTP ${r.status}, cuerpo: ${r.text}`;
});
await caso('API-09', 'Solicitudes.Medicion (@Max 220, @NotNull)', 'FC = 300 y temperatura omitida', '400 con el campo que falló', async () => {
  const a = await http('POST', '/api/mediciones', { token: juan.token, body: medicion({ frecuenciaCardiaca: 300 }) });
  const { temperatura, ...sinTemp } = medicion();
  const b = await http('POST', '/api/mediciones', { token: juan.token, body: sinTemp });
  exigir(a.status === 400 && b.status === 400, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} "${a.json.error}" · HTTP ${b.status} "${b.json.error}"`;
});
await caso('API-10', 'Solicitudes.Login (@Pattern \\d{4})', 'PIN "12" y "\' OR \'1\'=\'1"', '400 (no llega a Firebase)', async () => {
  const a = await http('POST', '/api/auth/login', { body: { pin: '12' } });
  const b = await http('POST', '/api/auth/login', { body: { pin: "' OR '1'='1" } });
  exigir(a.status === 400 && b.status === 400, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} y ${b.status}`;
});
await caso('API-11', 'Solicitudes.Mensaje (@NotBlank @Size 500)', 'Mensaje vacío y de 501 caracteres', '400', async () => {
  const a = await http('POST', `/api/chat/${juan.usuario.id}/mensajes`, { token: juan.token, body: { texto: '   ' } });
  const b = await http('POST', `/api/chat/${juan.usuario.id}/mensajes`, { token: juan.token, body: { texto: 'x'.repeat(501) } });
  exigir(a.status === 400 && b.status === 400, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} y ${b.status}`;
});
await caso('API-12', 'MedicionService.historial (Reglas.limiteValido)', 'limite=abc, 0, −5 y 1000; limite=1 y 500 válidos', '400 fuera de 1..500; 200 en los límites', async () => {
  const malos = await Promise.all(['abc', '0', '-5', '1000', '501'].map((l) => http('GET', `/api/mediciones/historial?limite=${l}`, { token: juan.token })));
  const buenos = await Promise.all(['1', '500'].map((l) => http('GET', `/api/mediciones/historial?limite=${l}`, { token: juan.token })));
  exigir(malos.every((r) => r.status === 400) && buenos.every((r) => r.status === 200), `malos ${malos.map((r) => r.status)} buenos ${buenos.map((r) => r.status)}`);
  return `abc/0/−5/1000/501 → ${malos.map((r) => r.status).join('/')} · 1/500 → ${buenos.map((r) => r.status).join('/')}`;
});
await caso('API-13', 'EmergenciaController.canalizar', 'Canalizar a alguien que no es doctor (a un paciente)', '400', async () => {
  const r = await http('PATCH', `/api/emergencias/${sosId}/canalizar`, { token: laura.token, body: { doctorId: juan.usuario.id } });
  exigir(r.status === 400, `HTTP ${r.status}`);
  return `HTTP ${r.status} "${r.json.error}"`;
});

// ───── 401 / 403
await caso('API-14', 'AuthService.autenticar (verifyIdToken)', 'Sin token y token inventado', '401 en ambos', async () => {
  const rs = await Promise.all([undefined, 'token-inventado'].map((t) => http('GET', '/api/mediciones/historial', { token: t })));
  exigir(rs.every((r) => r.status === 401), rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')}`;
});
// El emulador de Auth emite tokens SIN firma (alg "none") y el Admin SDK no verifica la firma en modo emulador, así que
// un JWT alterado solo puede rechazarse contra el Firebase real (firma RS256 de Google). En emulador se registra la limitación.
await caso('API-14b', 'AuthService.autenticar (firma del JWT)', 'JWT con el UID cambiado por el del admin', '401 (firma inválida)', async () => {
  const p = juan.token.split('.');
  const alterado = [p[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p[1], 'base64url')), user_id: admin.usuario.id, sub: admin.usuario.id })).toString('base64url'), p[2]].join('.');
  const r = await http('GET', '/api/usuarios', { token: alterado });
  if (EMULADOR) return `No aplica en emulador: los tokens del emulador no tienen firma (alg "none") y el SDK la omite; observado HTTP ${r.status}. Se verifica contra el Firebase real.`;
  exigir(r.status === 401, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});
await caso('API-14c', 'AuthService.autenticar (formato del header)', 'Token tal cual (como la PWA) y con prefijo "Bearer "', '200 en ambos', async () => {
  const a = await http('GET', '/api/auth/me', { token: juan.token });
  const b = await http('GET', '/api/auth/me', { token: `Bearer ${juan.token}` });
  exigir(a.status === 200 && b.status === 200 && b.json.id === juan.usuario.id, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} y ${b.status}`;
});
await caso('API-15','AtencionService.conversaciones (Reglas.esClinico)', 'Paciente y recepcionista piden la bandeja de conversaciones', '403 (autenticados sin permiso)', async () => {
  const a = await http('GET', '/api/chat/conversaciones', { token: juan.token });
  const b = await http('GET', '/api/chat/conversaciones', { token: laura.token });
  exigir(a.status === 403 && b.status === 403, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} y ${b.status}`;
});
await caso('API-16', 'Reglas.puedeVerChat', 'Juan lee el chat de María', '403', async () => {
  const r = await http('GET', `/api/chat/${maria.usuario.id}/mensajes`, { token: juan.token });
  exigir(r.status === 403, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});
await caso('API-17', 'AtencionService.crearEmergencia', 'La doctora intenta pedir un SOS', '403', async () => {
  const r = await http('POST', '/api/emergencias', { token: ana.token, body: {} });
  exigir(r.status === 403, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});
await caso('API-18', 'UsuarioController → UsuarioService.listar', 'GET /api/usuarios sin token, como paciente y como admin', '401 / 403 / 200', async () => {
  const rs = await Promise.all([undefined, juan.token, admin.token].map((t) => http('GET', '/api/usuarios', { token: t })));
  exigir(rs[0].status === 401 && rs[1].status === 403 && rs[2].status === 200, rs.map((r) => r.status).join('/'));
  return `HTTP ${rs.map((r) => r.status).join(' / ')} (${rs[2].json.length} cuentas)`;
});
await caso('API-19', 'UsuarioService.cambiarEstado', 'PATCH /api/usuarios/{uid}/estado sin token y como recepción', '401 y 403; la cuenta no cambia', async () => {
  const a = await http('PATCH', `/api/usuarios/${ana.usuario.id}/estado`, { body: { habilitado: false } });
  const b = await http('PATCH', `/api/usuarios/${ana.usuario.id}/estado`, { token: laura.token, body: { habilitado: false } });
  const sigue = (await http('GET', '/api/auth/me', { token: ana.token })).status;
  exigir(a.status === 401 && b.status === 403 && sigue === 200, `HTTP ${a.status}/${b.status}, doctora ${sigue}`);
  return `HTTP ${a.status} y ${b.status}; la doctora sigue activa`;
});
await caso('API-20', 'AuthService.login / perfil', 'PIN incorrecto vs. cuenta deshabilitada', '401 (autenticación) vs. 403 (autorización)', async () => {
  const mal = await http('POST', '/api/auth/login', { body: { pin: '9999' } });
  await http('PATCH', `/api/usuarios/${luis.usuario.id}/estado`, { token: admin.token, body: { habilitado: false } });
  const des = await http('POST', '/api/auth/login', { body: { pin: '4444' } });
  await http('PATCH', `/api/usuarios/${luis.usuario.id}/estado`, { token: admin.token, body: { habilitado: true } });
  exigir(mal.status === 401 && des.status === 403, `HTTP ${mal.status}/${des.status}`);
  return `HTTP ${mal.status} "${mal.json.error}" · HTTP ${des.status} "${des.json.error}"`;
});
await caso('API-21', 'UsuarioService.cambiarEstado → AuthService.revocar', 'Token de una cuenta que el admin deshabilita después del login', '401/403: el token deja de servir de inmediato', async () => {
  const s = await login('4444');
  await http('PATCH', `/api/usuarios/${s.usuario.id}/estado`, { token: admin.token, body: { habilitado: false } });
  const r = await http('GET', '/api/emergencias', { token: s.token });
  await http('PATCH', `/api/usuarios/${s.usuario.id}/estado`, { token: admin.token, body: { habilitado: true } });
  await new Promise((res) => setTimeout(res, 1100));   // al deshabilitar se revocaron sus tokens: nueva sesión para las pruebas siguientes
  luis = await login('4444');
  exigir(r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});
await caso('API-22', 'AuthController.logout → revokeRefreshTokens', 'Usar el token después de cerrar sesión', '204 en logout y 401 después', async () => {
  const s = await login('3333');
  await new Promise((r) => setTimeout(r, 1100));   // la revocación de Firebase tiene resolución de 1 s
  const out = await http('POST', '/api/auth/logout', { token: s.token });
  const r = await http('GET', '/api/emergencias', { token: s.token });
  const otraSesion = await http('GET', '/api/emergencias', { token: laura.token });   // sesión anterior de la misma cuenta
  laura = await login('3333');
  exigir(out.status === 204 && r.status === 401, `HTTP ${out.status}/${r.status}`);
  return `HTTP ${out.status} y luego ${r.status}; la otra sesión de la misma cuenta también quedó en ${otraSesion.status} (revokeRefreshTokens cierra todas)`;
});

// ───── 404 / 405 / 409
await caso('API-23', 'AtencionService (noExiste)', 'Atender una emergencia y leer un chat que no existen', '404 con cuerpo JSON', async () => {
  const a = await http('PATCH', '/api/emergencias/no-existe-123/atender', { token: ana.token });
  const b = await http('GET', '/api/chat/no-existe-123/mensajes', { token: ana.token });
  exigir(a.status === 404 && b.status === 404 && a.json?.error, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} "${a.json.error}" y ${b.status}`;
});
await caso('API-24', 'ManejadorErrores', 'Ruta inexistente y método no permitido', '404 y 405 en el mismo formato JSON', async () => {
  const a = await http('GET', '/api/no-existe', { token: juan.token });
  const b = await http('PUT', '/api/mediciones', { token: juan.token, body: {} });
  exigir(a.status === 404 && b.status === 405 && a.json?.status === 404, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} y ${b.status}`;
});
await caso('API-25', 'AtencionService.atender', 'El doctor intenta atender un SOS que recepción no ha canalizado', '409 con la emergencia actual', async () => {
  const r = await http('PATCH', `/api/emergencias/${sosId}/atender`, { token: ana.token });
  exigir(r.status === 409 && r.json.actual?.estado === 'ABIERTA', `HTTP ${r.status}`);
  return `HTTP ${r.status}, actual.estado = ${r.json.actual.estado}`;
});
await caso('API-26', 'AtencionService.canalizar (transacción + version)', 'Recepción canaliza a la Dra. Ana; luego otra canalización', '200 (version 1) y después 409 con cómo quedó', async () => {
  const a = await http('PATCH', `/api/emergencias/${sosId}/canalizar`, { token: laura.token, body: { doctorId: ana.usuario.id } });
  const b = await http('PATCH', `/api/emergencias/${sosId}/canalizar`, { token: admin.token, body: { doctorId: luis.usuario.id } });
  exigir(a.status === 200 && a.json.version === 1 && b.status === 409 && b.json.actual.canalizadaANombre === 'Dra. Ana Torres', `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} (version ${a.json.version}) y ${b.status} (actual: ${b.json.actual.canalizadaANombre})`;
});
await caso('API-27', 'AtencionService.atender', 'Doctor no asignado, doctor asignado y repetir', '403, 200 (version 2) y 200 idempotente', async () => {
  const a = await http('PATCH', `/api/emergencias/${sosId}/atender`, { token: luis.token });
  const b = await http('PATCH', `/api/emergencias/${sosId}/atender`, { token: ana.token });
  const c = await http('PATCH', `/api/emergencias/${sosId}/atender`, { token: ana.token });
  exigir(a.status === 403 && b.status === 200 && b.json.version === 2 && c.status === 200 && c.json.version === 2, `HTTP ${a.status}/${b.status}/${c.status}`);
  return `HTTP ${a.status} / ${b.status} (version ${b.json.version}) / ${c.status} (version ${c.json.version})`;
});

// ───── Lógica e integridad
await caso('API-28', 'Solicitudes.Medicion (Integer spo2) + Reglas.alertas', 'Lectura sin SpO₂ (spo2 = null)', 'Se guarda spo2 = null y sin alerta de saturación', async () => {
  const r = await http('POST', '/api/mediciones', { token: juan.token, body: medicion({ spo2: null }) });
  exigir(r.status === 201 && r.json.spo2 === null && r.json.alertas.length === 0, `HTTP ${r.status} spo2=${r.json?.spo2} alertas=${r.json?.alertas}`);
  return `HTTP ${r.status}, spo2 = null, alertas = []`;
});
await caso('API-29', 'Reglas.alertas', 'FC 130, temp 38.5 y SpO₂ 88', '3 alertas', async () => {
  const r = await http('POST', '/api/mediciones', { token: juan.token, body: medicion({ frecuenciaCardiaca: 130, temperatura: 38.5, spo2: 88 }) });
  const al = await http('GET', '/api/alertas', { token: juan.token });
  exigir(r.json.alertas.length === 3 && al.json.filter((a) => a.medicionId === r.json.id).length === 3, `alertas ${r.json.alertas}`);
  return `alertas = ${r.json.alertas.join(', ')}`;
});
await caso('API-30', 'Exposición de datos', 'Cuerpos de login, mediciones, alertas, emergencias, usuarios y estado', 'Sin PIN, contraseña ni refresh token', async () => {
  const cs = await Promise.all([
    http('POST', '/api/auth/login', { body: { pin: '0000' } }), http('GET', '/api/mediciones/historial?limite=5', { token: juan.token }),
    http('GET', '/api/alertas', { token: juan.token }), http('GET', '/api/emergencias', { token: ana.token }),
    http('GET', '/api/usuarios', { token: admin.token }), http('GET', '/api/sistema/estado')
  ]);
  exigir(cs.every((c) => sinSecretos(c.text)), 'expone credenciales');
  return 'Ningún cuerpo contiene PIN, contraseña ni refresh token';
});
await caso('API-31', 'CorsConfig (app.cors.origins)', 'Preflight desde un origen ajeno y desde la PWA', 'Ajeno sin Allow-Origin; PWA permitido', async () => {
  const pre = (o) => fetch(API + '/api/mediciones', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } });
  const [a, b] = await Promise.all([pre('https://sitio-malicioso.example'), pre('https://safemotion-pwa.vercel.app')]);
  exigir(!a.headers.get('access-control-allow-origin') && b.headers.get('access-control-allow-origin') === 'https://safemotion-pwa.vercel.app', `ajeno ${a.status} ${a.headers.get('access-control-allow-origin')}`);
  return `ajeno HTTP ${a.status} sin Allow-Origin · PWA HTTP ${b.status} permitido`;
});
await caso('API-32', 'SistemaController.estado', 'GET /api/sistema/estado sin sesión', '200 con el estado de Firestore, sin datos de usuarios', async () => {
  const r = await http('GET', '/api/sistema/estado');
  exigir(r.status === 200 && r.json.firestore === 'disponible' && !('usuariosRegistrados' in r.json), `HTTP ${r.status}`);
  return `HTTP ${r.status}: ${r.text}`;
});
await caso('API-33', 'AtencionService.conversaciones (consulta + count() por paciente)', 'Bandeja de la doctora con un SOS activo de María', '200; el paciente con SOS activo va primero', async () => {
  const sos = (await http('POST', '/api/emergencias', { token: maria.token, body: {} })).json;
  const r = await http('GET', '/api/chat/conversaciones', { token: ana.token });
  await http('PATCH', `/api/emergencias/${sos.id}/canalizar`, { token: laura.token, body: { doctorId: ana.usuario.id } });
  await http('PATCH', `/api/emergencias/${sos.id}/atender`, { token: ana.token });
  exigir(r.status === 200 && r.json[0].pacienteId === maria.usuario.id && r.json[0].emergenciaAbierta?.id === sos.id
    && r.json.every((c) => typeof c.mensajes === 'number'), `HTTP ${r.status} primero=${r.json?.[0]?.paciente}`);
  return `HTTP ${r.status}, ${r.json.length} pacientes; primero ${r.json[0].paciente} (SOS ${r.json[0].emergenciaAbierta.estado}), ${r.json[0].mensajes} mensajes contados con count()`;
});
await caso('API-34', 'MedicionController.actual', 'Lectura actual de quien no tiene lecturas (recepción) y de Juan', '204 sin cuerpo y 200 con la más reciente', async () => {
  const a = await http('GET', '/api/mediciones/actual', { token: laura.token });
  const b = await http('GET', '/api/mediciones/actual', { token: juan.token });
  exigir(a.status === 204 && a.bytes === 0 && b.status === 200 && b.json.pacienteId === juan.usuario.id, `HTTP ${a.status}/${b.status}`);
  return `HTTP ${a.status} (${a.bytes} B) y ${b.status}`;
});
await caso('API-35', 'MedicionService.ultimaDePaciente (Reglas.esClinico)', 'Última lectura de Juan pedida por la doctora, por recepción y de un paciente sin lecturas', '200 / 403 / 204', async () => {
  const a = await http('GET', `/api/pacientes/${juan.usuario.id}/mediciones/ultima`, { token: ana.token });
  const b = await http('GET', `/api/pacientes/${juan.usuario.id}/mediciones/ultima`, { token: laura.token });
  const c = await http('GET', `/api/pacientes/${laura.usuario.id}/mediciones/ultima`, { token: ana.token });
  exigir(a.status === 200 && b.status === 403 && c.status === 204, `HTTP ${a.status}/${b.status}/${c.status}`);
  return `HTTP ${a.status} / ${b.status} / ${c.status}`;
});

const ok = resultados.filter((r) => r.estado === 'Aprobado').length;
console.log(`\n${ok}/${resultados.length} casos aprobados · ${new Date().toISOString()} · ${API}`);
if (OUT) await writeFile(OUT, JSON.stringify({ fecha: new Date().toISOString(), api: API, resultados }, null, 2));
