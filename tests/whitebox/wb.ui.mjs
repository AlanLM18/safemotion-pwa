// Práctica 11 · WB-06 y NET-05 en la interfaz real (Microsoft Edge sin ventana, viewport de teléfono).
//  A) Rendimiento de carga de la PWA publicada en Vercel: Navigation Timing, FCP, bytes transferidos y heap JS (3 cargas
//     sin caché + 1 con red 4G lenta y CPU 4x más lenta, como un teléfono de gama media).
//  B) La app conectada a Spring Boot: tiempo de login y SOS sin conexión (no debe mostrarse como enviado) y al recuperar red.
// Ejecutar: API_URL=http://localhost:8080 node tests/whitebox/wb.ui.mjs <carpeta-salida>
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT = process.argv[2] ?? 'wb-ui';
await mkdir(OUT, { recursive: true });
const salida = { fecha: new Date().toISOString(), cargas: [], sos: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
salida.navegador = await browser.version();

async function medirCarga(url, etiqueta, { lenta = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await page.setCacheEnabled(false);
  if (lenta) {
    await page.emulateNetworkConditions({ download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8, latency: 150 });
    await page.emulateCPUThrottling(4);
  }
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  const total = Date.now() - t0;
  const m = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const rec = performance.getEntriesByType('resource');
    return {
      ttfb: +(n.responseStart - n.requestStart).toFixed(1), dcl: +n.domContentLoadedEventEnd.toFixed(1), load: +n.loadEventEnd.toFixed(1),
      fcp: fcp ? +fcp.startTime.toFixed(1) : null, recursos: rec.length + 1,
      bytes: rec.reduce((a, r) => a + (r.transferSize || 0), 0) + (n.transferSize || 0)
    };
  });
  const pm = await page.metrics();
  const fila = { etiqueta, url, ...m, hastaRedInactiva: total, heapMB: +(pm.JSHeapUsedSize / 1048576).toFixed(2), nodosDOM: pm.Nodes };
  salida.cargas.push(fila);
  console.log(etiqueta, JSON.stringify(fila));
  if (lenta) await page.screenshot({ path: join(OUT, 'UI-carga-vercel.png') });
  await ctx.close();
}

// ── A) PWA publicada
for (let i = 1; i <= 3; i++) await medirCarga('https://safemotion-pwa.vercel.app/', `Vercel carga ${i} (Wi-Fi, sin caché)`);
await medirCarga('https://safemotion-pwa.vercel.app/', 'Vercel con 4G lenta (1.6 Mbps, 150 ms) y CPU 4x', { lenta: true });

// ── B) App local contra Spring Boot
process.env.VITE_API_URL = API;
Object.assign(process.env, { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' });
const server = await createServer({ server: { port: 4173, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });

const apiJson = async (method, path, token, body) => (await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => null);
const juan = await apiJson('POST', '/api/auth/login', null, { pin: '0000' });
const doctora = await apiJson('POST', '/api/auth/login', null, { pin: '2222' });
const recepcion = await apiJson('POST', '/api/auth/login', null, { pin: '3333' });
// Cerrar SOS previos de Juan con el flujo real: recepción canaliza a la doctora y ella lo atiende
for (const e of (await apiJson('GET', '/api/emergencias', juan.token)).filter((x) => x.estado !== 'ATENDIDA')) {
  if (e.estado === 'ABIERTA') await apiJson('PATCH', `/api/emergencias/${e.id}/canalizar`, recepcion.token, { doctorId: doctora.usuario.id });
  await apiJson('PATCH', `/api/emergencias/${e.id}/atender`, doctora.token);
}
const sosDeJuan = async () => (await apiJson('GET', '/api/emergencias', juan.token)).length;

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('input[name=pin]');
await page.type('input[name=pin]', '0000');
let t0 = performance.now();
await page.click('#go');
await page.waitForFunction(() => location.hash === '#/inicio' && document.querySelector('main')?.textContent.includes('Juan'), { timeout: 8000 });
salida.loginMs = +(performance.now() - t0).toFixed(1);
console.log('Login hasta Inicio:', salida.loginMs, 'ms');

await page.evaluate(() => { location.hash = '/doctor'; });
await page.waitForSelector('#sos');
const antes = await sosDeJuan();

async function intentarSOS(etiqueta, offline) {
  await page.setOfflineMode(offline);
  await page.click('#sos');
  await page.waitForSelector('dialog #ok');
  const t = performance.now();
  await page.click('dialog #ok');
  await page.waitForFunction(() => { const s = document.querySelector('dialog #st')?.textContent ?? ''; return s && s !== 'Enviando...'; }, { timeout: 20000 });
  const ms = +(performance.now() - t).toFixed(1);
  const texto = await page.$eval('dialog #st', (e) => e.textContent);
  const clase = await page.$eval('dialog #st', (e) => e.className);
  const boton = await page.$eval('dialog #ok', (e) => e.textContent);
  await page.screenshot({ path: join(OUT, `UI-${etiqueta}.png`) });
  await page.setOfflineMode(false);
  const fila = { etiqueta, offline, ms, texto, clase, boton, sosEnServidor: await sosDeJuan() };
  salida.sos.push(fila);
  console.log(etiqueta, JSON.stringify(fila));
  await page.$eval('dialog #no', (b) => b.click()).catch(() => {});
  await page.evaluate(() => document.querySelector('dialog')?.close());
  await sleep(300);
}
salida.sosAntes = antes;
await intentarSOS('SOS-sin-red', true);
await intentarSOS('SOS-red-recuperada', false);
await intentarSOS('SOS-repetido', false);

await writeFile(join(OUT, 'wb-ui.json'), JSON.stringify(salida, null, 2));
await browser.close();
await server.close();
process.exit(0);
