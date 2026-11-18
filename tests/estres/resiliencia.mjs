// Práctica 12 · Fase 5: pruebas de resiliencia y recuperación (RES-01 a RES-08).
// Código real de la app (cola IndexedDB con fake-indexeddb, sync.js, cliente REST de api.js y, en RES-06, la política
// de reintento del monitoreo) contra el backend Spring + emulador, pasando por un proxy que provoca fallos controlados.
// RES-08 incluye una prueba en la interfaz (Edge) con respuesta tardía y varios toques al botón SOS.
// Ejecutar: API_URL=http://localhost:8080 node tests/estres/resiliencia.mjs <salida.json> [etiqueta]
import 'fake-indexeddb/auto';
import http from 'node:http';
import { mock } from 'node:test';
import { writeFile } from 'node:fs/promises';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = memStorage(); globalThis.sessionStorage = memStorage(); globalThis.location = { hash: '' };

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT = process.argv[2];
const ETIQUETA = process.argv[3] ?? 'corrida';
const { api, createApi } = await import('../../src/services/api.js');
const { enviarPendientes } = await import('../../src/services/sync.js');
const { measurementsDao } = await import('../../src/services/db.js');
const { createMeasurement } = await import('../../src/models/measurement.js');
// POLITICA=fija reproduce la versión original (reintento cada 5 s); sin ella se usa src/services/reintento.js
const politica = process.env.POLITICA === 'fija' ? null : await import('../../src/services/reintento.js').catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const salida = { etiqueta: ETIQUETA, fecha: new Date().toISOString(), casos: [] };

// ---------- proxy de fallos ----------
let modo = 'normal', retraso = 0, peticiones = [];
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    peticiones.push({ metodo: req.method, ruta: req.url, t: performance.now() });
    if (modo === 'caida') { req.socket.destroy(); return; }
    if (modo === 'colgado') return;                                          // nunca responde
    if (modo === 'http500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"status":500,"error":"Error interno del servidor"}'); return; }
    if (retraso) await sleep(retraso);
    const up = http.request(API + req.url, { method: req.method, headers: { ...req.headers, host: new URL(API).host } }, (r) => {
      const body = [];
      r.on('data', (c) => body.push(c));
      r.on('end', () => {
        if (modo === 'cortar-respuesta') { req.socket.destroy(); return; }   // el servidor ya procesó
        res.writeHead(r.statusCode, r.headers); res.end(Buffer.concat(body));
      });
    });
    up.on('error', (e) => { peticiones.push({ metodo: 'ERROR-PROXY', ruta: e.code ?? e.message, t: performance.now() }); res.destroy(); });
    up.end(Buffer.concat(chunks));
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${proxy.address().port}`;
const cliente = createApi({ baseUrl: PROXY, timeoutMs: 8000 });   // mismo timeout que la app (API_TIMEOUT_MS)
mock.method(api, 'enviarMedicion', cliente.enviarMedicion);

// ---------- sesión ----------
const directo = createApi({ baseUrl: API });
const sesion = await directo.login('1111');
const ponerSesion = (s) => localStorage.setItem('sm_session', JSON.stringify({ token: s.token, user: s.usuario, expiresAt: Date.now() + 3600_000 }));
ponerSesion(sesion);
const enServidor = async () => (await (await fetch(`${API}/api/mediciones/historial?limite=500`, { headers: { Authorization: sesion.token } })).json()).length;
const local = async () => { const t = await measurementsDao.obtenerTodos(sesion.usuario.id); return { pendientes: t.filter((m) => !m.synced && !m.error).length, enviadas: t.filter((m) => m.synced).length }; };
const encolar = async (n) => { for (let i = 0; i < n; i++) await measurementsDao.insertar(createMeasurement({ userId: sesion.usuario.id, wearable: { heartRate: 70 + i, spo2: 97, temperature: 36.5, steps: 5, calories: 1, battery: 90 }, activity: 'reposo' })); };
const limpiarCola = async () => { for (const m of await measurementsDao.obtenerTodos(sesion.usuario.id)) await measurementsDao.eliminar(m.id); };
async function intentar(fn) { const t = performance.now(); try { const v = await fn(); return { ok: true, valor: v, ms: +(performance.now() - t).toFixed(1) }; } catch (e) { return { ok: false, error: e.message, status: e.status ?? null, ms: +(performance.now() - t).toFixed(1) }; } }
function caso(id, escenario, esperado, observado, cumple, datos = {}) {
  salida.casos.push({ id, escenario, esperado, observado, resultado: cumple ? 'Cumple' : 'No cumple', ...datos });
  console.log(`${cumple ? '✔' : '✖'} ${id} ${escenario}\n     ${observado}`);
}

// RES-01 · pérdida de Internet durante una consulta
modo = 'caida';
let r = await intentar(() => cliente.historial(sesion.token, 20));
modo = 'cortar-respuesta';
const r2 = await intentar(() => cliente.historial(sesion.token, 20));
modo = 'normal';
caso('RES-01', 'Pérdida de Internet durante una consulta', 'Error controlado', `Conexión cortada antes de llegar: "${r.error}" (status ${r.status}) en ${r.ms} ms · cortada durante la respuesta: "${r2.error}" en ${r2.ms} ms; la app no se cae`,
  !r.ok && r.status === 0 && !r2.ok && r2.status === 0, { deteccionMs: Math.max(r.ms, r2.ms) });

// RES-02 · pérdida de Internet durante una escritura
await limpiarCola(); await encolar(3);
let antes = await enServidor();
modo = 'caida';
r = await intentar(() => enviarPendientes());
let l = await local(), srv = await enServidor();
modo = 'normal';
caso('RES-02', 'Pérdida de Internet durante una escritura', 'No confirmar falsamente el registro', `Sincronizar 3 lecturas sin red: "${r.error}" en ${r.ms} ms · cola local: ${l.pendientes} pendientes, ${l.enviadas} marcadas como enviadas · servidor: ${antes} → ${srv}`,
  !r.ok && l.enviadas === 0 && l.pendientes === 3 && srv === antes, { deteccionMs: r.ms });

// RES-03 · servidor sin respuesta
modo = 'colgado';
r = await intentar(() => cliente.historial(sesion.token, 20));
modo = 'normal';
caso('RES-03', 'Servidor sin respuesta', 'Timeout controlado', `La solicitud se cancela a los ${r.ms} ms con "${r.error}" (AbortController, API_TIMEOUT_MS = 8 000 ms; en modo Firebase el límite es 10 000 ms)`,
  !r.ok && r.ms >= 7900 && r.ms < 9500, { deteccionMs: r.ms });

// RES-04 · respuesta HTTP 500
modo = 'http500';
r = await intentar(() => enviarPendientes());
const rLect = await intentar(() => cliente.historial(sesion.token, 20));
l = await local();
modo = 'normal';
caso('RES-04', 'Respuesta HTTP 500', 'Mostrar error y conservar estabilidad', `Sincronizar: error "${r.error}" (status ${r.status}) y las ${l.pendientes} lecturas siguen pendientes · consulta: ApiError ${rLect.status} con datos ${JSON.stringify(rLect.ok ? null : 'del cuerpo')}; el proceso continúa`,
  !r.ok && r.status === 500 && l.pendientes === 3 && !rLect.ok && rLect.status === 500);

// RES-05 · 401 y 403
{
  const temporal = await directo.login('1111');
  ponerSesion(temporal);
  await sleep(1100);
  await directo.logout(temporal.token);                 // el token queda revocado
  location.hash = '';
  r = await intentar(() => enviarPendientes());
  const expiro = location.hash === '/login' && localStorage.getItem('sm_session') === null;
  const admin = await directo.login('1234');
  const luis = await directo.login('4444');
  await fetch(`${API}/api/usuarios/${luis.usuario.id}/estado`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: admin.token }, body: '{"habilitado":false}' });
  const r403 = await intentar(() => directo.login('4444'));
  await fetch(`${API}/api/usuarios/${luis.usuario.id}/estado`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: admin.token }, body: '{"habilitado":true}' });
  Object.assign(sesion, await directo.login('1111')); ponerSesion(sesion);
  caso('RES-05', 'Respuesta HTTP 401 o 403', 'Gestionar correctamente autenticación o permisos', `401 (token revocado): la sincronización se detiene, se borra la sesión y se envía a /login (${expiro ? 'sí' : 'no'}) · 403 (cuenta deshabilitada): "${r403.error}" (status ${r403.status}), distinto de "Credenciales inválidas"`,
    !r.ok && r.status === 401 && expiro && r403.status === 403 && /deshabilitada/.test(r403.error));
}

// RES-06 · recuperación de la conexión: 40 s sin red y luego red normal, con la política de reintento del monitoreo
{
  await limpiarCola(); await encolar(3);
  antes = await enServidor();
  peticiones = [];
  const INTERVALO = 5000;                                // MONITOR_INTERVAL_MS
  const reintento = politica?.crearReintento?.({ aleatorio: () => 0.5 }) ?? null;
  const t0 = performance.now(); let recuperado = null, intentosSinRed = 0;
  modo = 'caida';
  setTimeout(() => { modo = 'normal'; }, 40000);
  while (performance.now() - t0 < 90000 && recuperado === null) {
    const puede = reintento ? reintento.puedeIntentar() : true;   // antes: se intenta en cada ciclo
    if (puede) {
      const sinRed = modo === 'caida';
      try { await enviarPendientes(); reintento?.registrarExito(); if ((await local()).pendientes === 0) recuperado = performance.now() - t0; }
      catch (e) { reintento?.registrarFallo(); }
      if (sinRed) intentosSinRed++;
    }
    await sleep(INTERVALO);
  }
  srv = await enServidor();
  const despuesDeVolver = recuperado === null ? null : +((recuperado - 40000) / 1000).toFixed(1);
  caso('RES-06', 'Recuperación de conexión', 'Restablecer comunicación', `Política: ${reintento ? 'espera progresiva (exponential backoff 5-10-20-30 s, tope de 30 s)' : 'reintento fijo cada 5 s'} · ${intentosSinRed} intentos durante 40 s sin red · lo pendiente se envió ${despuesDeVolver} s después de volver la red · servidor ${antes} → ${srv}`,
    recuperado !== null && srv === antes + 3, { intentosSinRed, recuperacionS: despuesDeVolver, solicitudesAlServidor: peticiones.length });
}

// RES-07 · reintento de una escritura (la respuesta se pierde después de que el servidor guardó)
{
  await limpiarCola(); await encolar(3);
  antes = await enServidor();
  modo = 'cortar-respuesta';
  const r1 = await intentar(() => enviarPendientes());
  const tras1 = await enServidor();
  modo = 'normal';
  const r2b = await intentar(() => enviarPendientes());
  srv = await enServidor();
  caso('RES-07', 'Reintento de una escritura', 'Evitar duplicados inesperados', `1.er intento: "${r1.error}" pero el servidor ya guardó (${antes} → ${tras1}) · reintento: ${r2b.ok ? r2b.valor.enviadas + ' enviadas' : r2b.error} · total ${srv - antes} lecturas para 3 envíos (idLocal como ID del documento)`,
    srv - antes === 3);
}

// RES-08 · respuesta tardía: 3 toques seguidos a "Enviar pendientes" mientras el servidor tarda 3 s
{
  await limpiarCola(); await encolar(2);
  antes = await enServidor();
  peticiones = [];
  retraso = 3000;
  const t = performance.now();
  const promesas = [enviarPendientes(), enviarPendientes(), enviarPendientes()];
  const misma = promesas[0] === promesas[1] && promesas[1] === promesas[2];
  const rs = await Promise.allSettled(promesas);
  retraso = 0;
  srv = await enServidor();
  const posts = peticiones.filter((p) => p.metodo === 'POST').length;
  const fallo = rs.find((x) => x.status === 'rejected');
  caso('RES-08', 'Respuesta tardía (varios toques al botón)', 'Evitar operaciones duplicadas o inconsistentes en la interfaz', `3 llamadas simultáneas compartieron la misma sincronización (${misma ? 'misma promesa' : 'distintas'}) · ${posts} POST al servidor para 2 lecturas · ${srv - antes} guardadas · ${(performance.now() - t).toFixed(0)} ms` + (fallo ? ` · error: "${fallo.reason.message}" (status ${fallo.reason.status}) · peticiones: ${JSON.stringify(peticiones.map((p) => p.metodo + ' ' + p.ruta.split('?')[0] + ' +' + (p.t - t).toFixed(0) + 'ms'))}` : ''),
    misma && posts === 2 && srv - antes === 2 && !fallo);
}

proxy.close(); mock.restoreAll();

// RES-08b · interfaz: SOS con respuesta tardía y 3 toques
{
  const { createServer } = await import('vite');
  const puppeteer = (await import('puppeteer-core')).default;
  process.env.VITE_API_URL = API;
  Object.assign(process.env, { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' });
  const server = await createServer({ server: { port: 4173, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  const juan = await directo.login('0000');
  const recep = await directo.login('3333'), doc = await directo.login('2222');
  for (const e of (await directo.emergencias(juan.token)).filter((x) => x.estado !== 'ATENDIDA')) {
    if (e.estado === 'ABIERTA') await directo.canalizarEmergencia(e.id, doc.usuario.id, recep.token);
    await directo.atenderEmergencia(e.id, doc.token);
  }
  const antesSos = (await directo.emergencias(juan.token)).length;
  await page.goto('http://localhost:4173/', { waitUntil: 'load' });
  await page.waitForSelector('input[name=pin]'); await page.type('input[name=pin]', '0000'); await page.click('#go');
  await page.waitForFunction(() => location.hash === '#/inicio', { timeout: 15000 });
  await page.evaluate(() => { location.hash = '/doctor'; }); await page.waitForSelector('#sos');
  await page.setRequestInterception(true);
  let postsSos = 0;
  page.on('request', async (rq) => {
    if (rq.method() === 'POST' && rq.url().includes('/api/emergencias')) { postsSos++; await sleep(4000); }
    rq.continue();
  });
  await page.click('#sos'); await page.waitForSelector('dialog #ok');
  const t = performance.now();
  for (let i = 0; i < 3; i++) { await page.$eval('dialog #ok', (b) => b.click()); await sleep(150); }
  const deshabilitado = await page.$eval('dialog #ok', (b) => b.disabled);
  await page.waitForFunction(() => { const s = document.querySelector('dialog #st')?.textContent ?? ''; return s && s !== 'Enviando...'; }, { timeout: 30000 });
  const texto = await page.$eval('dialog #st', (e) => e.textContent);
  const despuesSos = (await directo.emergencias(juan.token)).length;
  await browser.close(); await server.close();
  caso('RES-08b', 'Respuesta tardía en la interfaz (SOS, 3 toques, servidor tarda 4 s)', 'No crear SOS duplicados ni mostrar estados contradictorios', `Botón deshabilitado mientras se envía: ${deshabilitado ? 'sí' : 'no'} · ${postsSos} POST · SOS de Juan ${antesSos} → ${despuesSos} · mensaje final: "${texto}" (${(performance.now() - t).toFixed(0)} ms)`,
    postsSos === 1 && despuesSos === antesSos + 1);
}

if (OUT) await writeFile(OUT, JSON.stringify(salida, null, 2));
process.exit(0);
