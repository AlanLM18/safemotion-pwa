// Práctica 12 · Fase 2: profiling de la aplicación (PWA) con el protocolo de depuración de Edge (CDP).
// La app es la compilación de producción (vite build) apuntando al EMULADOR de Firebase, servida en local.
// Se mide por fase: CPU del hilo principal (Performance.getMetrics → TaskDuration), memoria JS (JSHeapUsedSize),
// tareas largas (> 50 ms, PerformanceObserver "longtask"), solicitudes de red al backend de datos y tiempos de operación.
// Pruebas: consulta repetida, escritura, navegación, procesamiento de datos y la operación crítica de sincronización.
// Ejecutar: node tests/estres/profiling-app.mjs <carpeta-dist> <salida.json> [etiqueta]
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';
import { writeFile } from 'node:fs/promises';

const DIST = process.argv[2];
const OUT = process.argv[3];
const ETIQUETA = process.argv[4] ?? 'corrida';
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PUERTO = 4174;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const salida = { etiqueta: ETIQUETA, fecha: new Date().toISOString(), fases: [], operaciones: {} };

const server = await preview({ preview: { port: PUERTO, strictPort: true }, build: { outDir: DIST }, logLevel: 'error' });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--enable-precise-memory-info'] });
salida.navegador = await browser.version();
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
await cdp.send('Network.enable');
await page.evaluateOnNewDocument(() => {
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ inicio: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* sin soporte */ }
});

// Red: solicitudes y bytes hacia Firestore/Auth (emulador) y al resto
let red = { solicitudes: 0, bytes: 0, firestore: 0, firestoreBytes: 0 };
const urls = new Map();
cdp.on('Network.requestWillBeSent', (e) => { urls.set(e.requestId, e.request.url); red.solicitudes++; if (/:8085|:9099/.test(e.request.url)) red.firestore++; });
cdp.on('Network.loadingFinished', (e) => { red.bytes += e.encodedDataLength; if (/:8085|:9099/.test(urls.get(e.requestId) ?? '')) red.firestoreBytes += e.encodedDataLength; });

async function metricas() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { t: m.Timestamp, task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, heap: m.JSHeapUsedSize, nodos: m.Nodes };
}
// Ejecuta una fase muestreando CPU y memoria cada 250 ms
async function fase(nombre, fn) {
  const red0 = { ...red };
  const lt0 = await page.evaluate(() => (window.__lt ?? []).length);
  const muestras = [await metricas()];
  let activo = true;
  const bucle = (async () => { while (activo) { await sleep(250); muestras.push(await metricas()); } })();
  const t0 = performance.now();
  const detalle = await fn();
  const dur = performance.now() - t0;
  activo = false; await bucle; muestras.push(await metricas());
  // CPU del hilo principal = tiempo ocupado / tiempo transcurrido, por ventanas de ~1 s
  const cpuVentanas = [];
  for (let i = 4; i < muestras.length; i += 4) { const a = muestras[i - 4], b = muestras[i]; if (b.t > a.t) cpuVentanas.push(100 * (b.task - a.task) / (b.t - a.t)); }
  const ini = muestras[0], fin = muestras.at(-1);
  const lt = (await page.evaluate(() => window.__lt ?? [])).slice(lt0);
  const fila = {
    fase: nombre, duracionMs: +dur.toFixed(0),
    cpuProm: +(100 * (fin.task - ini.task) / (fin.t - ini.t)).toFixed(1), cpuMax: cpuVentanas.length ? +Math.max(...cpuVentanas).toFixed(1) : null,
    scriptMs: +((fin.script - ini.script) * 1000).toFixed(0), layoutMs: +((fin.layout - ini.layout) * 1000).toFixed(0),
    heapIniMB: +(ini.heap / 1048576).toFixed(2), heapMaxMB: +(Math.max(...muestras.map((m) => m.heap)) / 1048576).toFixed(2), heapFinMB: +(fin.heap / 1048576).toFixed(2),
    nodosFin: fin.nodos, tareasLargas: lt.length, tareaLargaMaxMs: lt.length ? +Math.max(...lt.map((x) => x.ms)).toFixed(0) : 0,
    solicitudes: red.solicitudes - red0.solicitudes, solicitudesFirebase: red.firestore - red0.firestore, kbFirebase: +((red.firestoreBytes - red0.firestoreBytes) / 1024).toFixed(1),
    detalle
  };
  salida.fases.push(fila);
  console.log(`${nombre}: ${fila.duracionMs} ms · CPU ${fila.cpuProm}% (máx ${fila.cpuMax}%) · heap ${fila.heapIniMB}→${fila.heapMaxMB}→${fila.heapFinMB} MB · tareas largas ${fila.tareasLargas} (máx ${fila.tareaLargaMaxMs} ms) · Firebase ${fila.solicitudesFirebase} solic / ${fila.kbFirebase} KB · ${JSON.stringify(detalle)}`);
  return fila;
}
const ir = async (hash, selector) => {
  const t = performance.now();
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(selector, { timeout: 15000 });
  return performance.now() - t;
};
const prom = (xs) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);

// ---------- F0: carga y login ----------
await fase('Carga de la app y login con PIN', async () => {
  await page.goto(`http://localhost:${PUERTO}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[name=pin]');
  await page.type('input[name=pin]', '0000');
  const t = performance.now();
  await page.click('#go');
  await page.waitForFunction(() => location.hash === '#/inicio' && document.querySelector('main')?.textContent.includes('Juan'), { timeout: 20000 });
  salida.operaciones.loginMs = +(performance.now() - t).toFixed(0);
  return { loginMs: salida.operaciones.loginMs };
});

// Conversación realista: 150 mensajes en el chat de Juan (emulador, privilegios de administrador)
{
  const FSH = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085';
  const RAIZ = 'projects/demo-safemotion/databases/(default)/documents';
  const u = await page.evaluate(() => JSON.parse(localStorage.getItem('sm_session')).user);
  const base = Date.now() - 150 * 60000;
  const writes = Array.from({ length: 150 }, (_, i) => ({ update: { name: `${RAIZ}/conversaciones/${u.id}/mensajes/perf${String(i).padStart(3, '0')}`, fields: {
    autorId: { stringValue: i % 2 ? u.id : 'medico' }, autor: { stringValue: i % 2 ? u.nombre : 'Dra. Ana Torres' }, rol: { stringValue: i % 2 ? 'usuario' : 'doctor' },
    texto: { stringValue: `Mensaje de prueba ${i}: seguimiento de signos vitales y recomendaciones.` }, fecha: { timestampValue: new Date(base + i * 60000).toISOString() } } } }));
  const r = await fetch(`http://${FSH}/v1/${RAIZ}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ writes }) });
  if (!r.ok) throw new Error('siembra de mensajes ' + r.status);
  salida.mensajesSembrados = 150;
}

// ---------- F1: consulta repetida (chat del paciente con el médico) ----------
await fase('Consulta repetida: abrir el chat 10 veces', async () => {
  const xs = [];
  for (let i = 0; i < 10; i++) {
    await ir('/inicio', '#mst');
    const t = performance.now();
    await page.evaluate(() => { location.hash = '/doctor'; });
    await page.waitForFunction(() => document.querySelectorAll('#msgs li').length > 0, { timeout: 15000 });
    xs.push(performance.now() - t);
  }
  salida.operaciones.abrirChatMs = prom(xs);
  return { abrirChatProm: prom(xs), min: +Math.min(...xs).toFixed(0), max: +Math.max(...xs).toFixed(0) };
});
await fase('Consulta periódica: chat abierto 30 s sin actividad', async () => {
  await sleep(30000);
  return { mensajesEnPantalla: await page.evaluate(() => document.querySelectorAll('#msgs li').length) };
});

// ---------- F2: escritura (lectura del wearable simulado → sincronizar) ----------
await fase('Escritura: guardar 5 lecturas del wearable y enviarlas', async () => {
  await ir('/dispositivo', '#sv');
  const btn = await page.$eval('#sim', (b) => b.textContent);
  if (!/detener|apagar/i.test(btn)) await page.click('#sim');
  await page.waitForFunction(() => Number(document.querySelector('#hr')?.textContent) > 0, { timeout: 10000 });
  for (let i = 0; i < 5; i++) { await page.$eval('#sv', (b) => b.click()); await sleep(300); }
  await ir('/historial', '#sync');
  const t = performance.now();
  await page.$eval('#sync', (b) => b.click());
  await page.waitForFunction(() => /enviada|No hay lecturas/.test(document.querySelector('#msg')?.textContent ?? ''), { timeout: 60000 });
  const ms = performance.now() - t;
  return { enviarMs: +ms.toFixed(0), mensaje: await page.$eval('#msg', (e) => e.textContent) };
});

// ---------- F3: navegación entre pantallas ----------
await fase('Navegación: 5 vueltas por Inicio, Wearable, Historial, Doctor y Cuenta', async () => {
  const pantallas = [['/inicio', '#mst'], ['/dispositivo', '#sv'], ['/historial', '#ls'], ['/doctor', '#msgs li'], ['/cuenta', '#uid']];
  const tiempos = {};
  for (let v = 0; v < 5; v++) for (const [h, s] of pantallas) (tiempos[h] ??= []).push(await ir(h, s));
  const r = Object.fromEntries(Object.entries(tiempos).map(([k, v]) => [k, prom(v)]));
  salida.operaciones.navegacion = r;
  return r;
});

// ---------- F4: procesamiento de datos (1 000 lecturas locales en Historial) ----------
const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('sm_session')).user.id);
await page.evaluate(async (userId) => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('safemotion', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  await new Promise((ok, no) => {
    const tx = db.transaction('measurements', 'readwrite'), s = tx.objectStore('measurements');
    for (let i = 0; i < 1000; i++) {
      s.put({ id: `perf-${i}`, userId, deviceId: 'wearable-simulado', timestamp: new Date(Date.now() - i * 5000).toISOString(), source: 'merged',
        wearable: { heartRate: 60 + (i % 40), spo2: 97, steps: i, calories: 1, temperature: 36.6, battery: 80, simulated: true },
        gyroscope: { x: 0.1, y: 0.2, z: 0.3, unit: 'rad/s' }, accelerometer: null, phoneSteps: i, activity: 'caminando', synced: true, error: null });
    }
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  db.close();
}, uid);
await fase('Procesamiento: mostrar Historial con 1 000 lecturas locales (5 veces)', async () => {
  const xs = [];
  for (let i = 0; i < 5; i++) {
    await ir('/inicio', '#mst');
    const t = performance.now();
    await page.evaluate(() => { location.hash = '/historial'; });
    // versión original: las 1 000 en pantalla · versión optimizada: la primera página (100) y el botón "Mostrar más"
    await page.waitForFunction(() => document.querySelectorAll('#ls li').length >= 1000 || (document.querySelectorAll('#ls li').length >= 100 && !document.querySelector('#mas')?.hidden), { timeout: 30000 });
    xs.push(performance.now() - t);
  }
  salida.operaciones.historial1000Ms = prom(xs);
  return { historial1000Prom: prom(xs), elementos: await page.evaluate(() => document.querySelectorAll('#ls li').length) };
});
await fase('Procesamiento: recorrer todas las páginas del Historial (si existen)', async () => {
  // Recorrer todas las páginas (para medir el costo de ver las 1 000 cuando el usuario sí las pide)
  let paginas = 0; const tp = performance.now();
  while (await page.evaluate(() => { const b = document.querySelector('#mas'); return b && !b.hidden; })) {
    const n = await page.evaluate(() => document.querySelectorAll('#ls li').length);
    await page.$eval('#mas', (b) => b.click());
    await page.waitForFunction((x) => document.querySelectorAll('#ls li').length > x, { timeout: 10000 }, n);
    paginas++;
  }
  return { elementos: await page.evaluate(() => document.querySelectorAll('#ls li').length), paginasExtra: paginas, msVerTodas: +(performance.now() - tp).toFixed(0) };
});

// ---------- F5: operación crítica (sincronizar 100 lecturas pendientes) ----------
await page.evaluate(async (userId) => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('safemotion', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  await new Promise((ok, no) => {
    const tx = db.transaction('measurements', 'readwrite'), s = tx.objectStore('measurements');
    for (let i = 0; i < 1000; i++) s.delete(`perf-${i}`);
    const base = Date.now();
    for (let i = 0; i < 100; i++) {
      s.put({ id: crypto.randomUUID(), userId, deviceId: 'wearable-simulado', timestamp: new Date(base - i * 5000).toISOString(), source: 'merged',
        wearable: { heartRate: 60 + (i % 40), spo2: 97, steps: i, calories: 1, temperature: 36.6, battery: 80, simulated: true },
        gyroscope: { x: 0.1, y: 0.2, z: 0.3, unit: 'rad/s' }, accelerometer: null, phoneSteps: i, activity: 'caminando', synced: false, error: null });
    }
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  db.close();
}, uid);
await fase('Operación crítica: sincronizar 100 lecturas pendientes', async () => {
  await ir('/inicio', '#mst');
  await ir('/historial', '#sync');
  const t = performance.now();
  await page.$eval('#sync', (b) => b.click());
  await page.waitForFunction(() => /enviada/.test(document.querySelector('#msg')?.textContent ?? ''), { timeout: 180000 });
  const ms = performance.now() - t;
  salida.operaciones.sincronizar100Ms = +ms.toFixed(0);
  return { sincronizar100Ms: +ms.toFixed(0), mensaje: await page.$eval('#msg', (e) => e.textContent) };
});

const tl = await page.evaluate(() => window.__lt ?? []);
salida.tareasLargasTotales = { cantidad: tl.length, maxMs: tl.length ? Math.max(...tl.map((x) => x.ms)) : 0 };
await page.screenshot({ path: OUT.replace(/\.json$/, '.png') });
if (OUT) await writeFile(OUT, JSON.stringify(salida, null, 2));
await browser.close();
server.httpServer.close();
process.exit(0);
