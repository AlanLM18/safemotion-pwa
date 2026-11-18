// Práctica 11 · WB-06 / NET-05 sobre la PWA PUBLICADA (https://safemotion-pwa.vercel.app, Firebase real).
// Mide la carga de la app, el login real con PIN (Firebase directo) y que un SOS sin conexión NO se registre.
// No crea datos: el SOS se intenta solo sin red y se comprueba por la API que no aparece ninguno nuevo.
// Ejecutar: node tests/whitebox/wb.ui.prod.mjs <carpeta-salida>
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_APP = 'https://safemotion-pwa.vercel.app/';
const OUT = process.argv[2] ?? 'wb-ui-prod';
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const salida = { fecha: new Date().toISOString(), url: URL_APP, cargas: [], pasos: [] };

const apiJson = async (m, p, token, body) => (await fetch(URL_APP.replace(/\/$/, '') + p, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const juanApi = await apiJson('POST', '/api/auth/login', null, { pin: '0000' });
const sosDeJuan = async () => (await apiJson('GET', '/api/emergencias', juanApi.token)).length;

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
salida.navegador = await browser.version();

// Carga en frío (contexto nuevo, sin caché): 3 en Wi-Fi + 1 con 4G lenta y CPU 4x
for (const [i, lenta] of [[1, false], [2, false], [3, false], [4, true]]) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await page.setCacheEnabled(false);
  if (lenta) { await page.emulateNetworkConditions({ download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8, latency: 150 }); await page.emulateCPUThrottling(4); }
  const t0 = Date.now();
  await page.goto(URL_APP, { waitUntil: 'networkidle0', timeout: 90000 });
  const m = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0], fcp = performance.getEntriesByName('first-contentful-paint')[0], rec = performance.getEntriesByType('resource');
    return { ttfb: +(n.responseStart - n.requestStart).toFixed(1), dcl: +n.domContentLoadedEventEnd.toFixed(1), fcp: fcp ? +fcp.startTime.toFixed(1) : null, recursos: rec.length + 1, bytes: rec.reduce((a, r) => a + (r.transferSize || 0), 0) + (n.transferSize || 0) };
  });
  const pm = await page.metrics();
  const fila = { etiqueta: lenta ? 'Producción con 4G lenta (1,6 Mbps, 150 ms) y CPU 4x' : `Producción carga ${i} (Wi-Fi, sin caché)`, ...m, hastaRedInactiva: Date.now() - t0, heapMB: +(pm.JSHeapUsedSize / 1048576).toFixed(2), nodosDOM: pm.Nodes };
  salida.cargas.push(fila);
  console.log(JSON.stringify(fila));
  await ctx.close();
}

// Login real con PIN (Firebase Authentication + Firestore directo desde la PWA)
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await page.goto(URL_APP, { waitUntil: 'networkidle0', timeout: 90000 });
await page.waitForSelector('input[name=pin]');
await page.type('input[name=pin]', '0000');
let t = performance.now();
await page.click('#go');
await page.waitForFunction(() => location.hash === '#/inicio' && document.querySelector('main')?.textContent.includes('Juan'), { timeout: 30000 });
salida.loginMs = +(performance.now() - t).toFixed(1);
await page.screenshot({ path: join(OUT, 'PROD-inicio.png') });
console.log('Login real hasta Inicio:', salida.loginMs, 'ms');

// Historial (lecturas guardadas en este teléfono) y pantalla del doctor
await page.evaluate(() => { location.hash = '/historial'; });
t = performance.now();
await page.waitForSelector('#ls');
salida.historialMs = +(performance.now() - t).toFixed(1);

await page.evaluate(() => { location.hash = '/doctor'; });
await page.waitForSelector('#sos');
await sleep(1500);
const antes = await sosDeJuan();
await page.setOfflineMode(true);
await page.click('#sos');
await page.waitForSelector('dialog #ok');
t = performance.now();
await page.click('dialog #ok');
await page.waitForFunction(() => { const s = document.querySelector('dialog #st')?.textContent ?? ''; return s && s !== 'Enviando...'; }, { timeout: 30000 });
const sos = { ms: +(performance.now() - t).toFixed(1), texto: await page.$eval('dialog #st', (e) => e.textContent), clase: await page.$eval('dialog #st', (e) => e.className), boton: await page.$eval('dialog #ok', (e) => e.textContent) };
await page.screenshot({ path: join(OUT, 'PROD-SOS-sin-red.png') });
await page.$eval('dialog #no', (b) => b.click());   // cancelar: no se reintenta con red
await page.setOfflineMode(false);
await sleep(2000);
sos.sosAntes = antes; sos.sosDespues = await sosDeJuan();
salida.sosSinRed = sos;
console.log('SOS sin red:', JSON.stringify(sos));

await writeFile(join(OUT, 'wb-ui-prod.json'), JSON.stringify(salida, null, 2));
await browser.close();
process.exit(0);
