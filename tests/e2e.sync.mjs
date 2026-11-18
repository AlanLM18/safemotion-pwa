// Evaluación de pruebas · Fase 4: E2E del flujo crítico "capturar lectura -> guardar sin red -> sincronizar -> persistir".
// Levanta el servidor HTTP con el contrato de Spring Boot, Vite con VITE_API_URL apuntando a él (la app sale del
// modo simulado y hace peticiones reales) y Microsoft Edge sin ventana (Puppeteer). Una captura por paso.
// Ejecutar: npm run test:e2e:sync   (EDGE_PATH=... si Edge no está en la ruta por defecto)
// Con Spring Boot real:  API_URL=http://localhost:8080 npm run test:e2e:sync   (capturas en evidencias-spring)
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { iniciarServidorContrato } from './support/servidorContrato.js';
import { createApi } from '../src/services/api.js';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const API_URL = process.env.API_URL ?? '';
const OUT = new URL(API_URL ? '../docs/evaluacion-pruebas/evidencias-spring/' : '../docs/evaluacion-pruebas/evidencias/', import.meta.url);
await mkdir(OUT, { recursive: true });

const backend = API_URL ? null : await iniciarServidorContrato();
const spring = API_URL ? createApi({ baseUrl: API_URL }) : null;
process.env.VITE_API_URL = API_URL || backend.url;      // Vite lo expone como import.meta.env.VITE_API_URL
Object.assign(process.env, { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' });   // esta E2E no usa Firebase aunque .env lo configure
const server = await createServer({ server: { port: 5198, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const ir = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await sleep(300); };
const esperarTexto = (sel, t, timeout = 6000) => page.waitForFunction((s, x) => document.querySelector(s)?.textContent.includes(x), { timeout }, sel, t);
const etiquetas = () => page.$$eval('#ls .tag', (t) => t.map((x) => x.textContent));
const esperar = (cond, msg) => { if (!cond) throw new Error(msg); };
const tokenSesion = () => page.evaluate(() => JSON.parse(localStorage.getItem('sm_session')).token);
// Mediciones de Juan en el servidor, de la más reciente a la más antigua (contrato: lo persistido; Spring Boot: su historial).
const medicionesServidor = async () => (backend ? [...backend.mediciones].reverse() : await spring.historial(await tokenSesion(), 200));
let previas = 0;                                        // Spring Boot puede traer mediciones de corridas anteriores
const nuevas = async () => (await medicionesServidor()).length - previas;

const pasos = [];
let abortado = false;
async function paso(id, accion, esperado, fn) {
  if (abortado) { pasos.push({ id, accion, esperado, real: 'No ejecutado (falló un paso anterior)', estado: 'No ejecutado', captura: null }); return; }
  let estado = 'Aprobado', real;
  try { real = await fn(); } catch (e) { estado = 'Fallido'; real = e.message.split('\n')[0]; abortado = true; }
  const captura = `${id}.png`;
  await page.screenshot({ path: fileURLToPath(new URL(captura, OUT)) });
  pasos.push({ id, accion, esperado, real, estado, captura });
  console.log(`${estado === 'Aprobado' ? '✔' : '✖'} ${id} ${accion} -> ${real}`);
}

const t0 = Date.now();
try {
  await page.goto('http://localhost:5198/', { waitUntil: 'load' });

  await paso('S-01', 'Iniciar sesión con el PIN 0000', 'Entra a Inicio con "Juan Pérez"; el login viaja por HTTP al servidor', async () => {
    await page.waitForSelector('input[name=pin]');
    await page.type('input[name=pin]', '0000');
    await page.click('#go');
    await page.waitForFunction(() => location.hash === '#/inicio', { timeout: 6000 });
    await esperarTexto('main', 'Juan Pérez');
    if (backend) esperar(backend.peticiones.some((p) => p.path === '/api/auth/login'), 'el servidor no recibió el login');
    previas = (await medicionesServidor()).length;
    return `Hash ${await page.evaluate(() => location.hash)}; token emitido por ${backend ? 'el servidor de contrato' : 'Spring Boot'}; mediciones previas de Juan: ${previas}`;
  });

  await paso('S-02', 'Conectar el wearable simulado (escenario reposo)', 'El wearable reporta signos vitales', async () => {
    await ir('/dispositivo');
    await page.select('#esc', 'reposo');
    await page.click('#sim');
    await page.waitForFunction(() => Number(document.querySelector('#hr')?.textContent) > 0, { timeout: 6000 });
    return `FC ${await texto('#hr')} bpm, SpO2 ${await texto('#spo2')} %, ${await texto('#temp')} °C`;
  });

  await paso('S-03', 'Guardar una lectura desde Wearable', 'Mensaje "Lectura guardada (teléfono + wearable)"', async () => {
    await page.$eval('#sv', (b) => b.click());   // queda bajo la barra de pestañas en pantallas chicas
    await esperarTexto('#msg', 'Lectura guardada');
    return await texto('#msg');
  });

  await paso('S-04', 'Sin red, pulsar "Enviar pendientes" en Historial', 'Mensaje de error; la lectura sigue Pendiente y el servidor no recibe nada', async () => {
    await ir('/historial');
    await page.waitForSelector('#ls .tag');
    await page.setOfflineMode(true);
    await page.click('#sync');
    await esperarTexto('#msg', 'No fue posible obtener la información.');
    await sleep(300);
    const tags = await etiquetas();
    esperar(tags.length === 1 && tags[0] === 'Pendiente', `estados: ${tags}`);
    await page.setOfflineMode(false);                  // solo para consultar el servidor desde Node
    const n = await nuevas();
    await page.setOfflineMode(true);
    esperar(n === 0, `el servidor tiene ${n} medición(es) nueva(s)`);
    return `"${await texto('#msg')}" · estado: ${tags.join(', ')} · mediciones nuevas en el servidor: 0`;
  });

  await paso('S-05', 'Recuperar la red y pulsar "Enviar pendientes"', '"1 enviada(s), 0 rechazada(s)"; estado Enviada', async () => {
    await page.setOfflineMode(false);
    await page.click('#sync');
    await esperarTexto('#msg', 'enviada(s)');
    await sleep(300);
    const tags = await etiquetas();
    esperar(tags.every((t) => t === 'Enviada'), `estados: ${tags}`);
    return `"${await texto('#msg')}" · estado: ${tags.join(', ')}`;
  });

  await paso('S-06', 'Comprobar en el servidor la medición recibida', 'Exactamente 1 medición de Juan Pérez, con su token y los mismos signos que muestra Historial', async () => {
    const resumen = await page.$eval('#ls li span.muted', (e) => e.textContent);
    const fc = Number(/FC (\d+)/.exec(resumen)?.[1]);
    const n = await nuevas();
    esperar(n === 1, `mediciones nuevas en el servidor: ${n}`);
    const [m] = await medicionesServidor();
    esperar(m.usuario.nombre === 'Juan Pérez', `usuario: ${m.usuario.nombre}`);
    if (backend) {
      const post = backend.peticiones.find((p) => p.method === 'POST' && p.path === '/api/mediciones');
      esperar(post.auth === await tokenSesion(), 'el POST no llevó el token de la sesión');
    }
    esperar(m.frecuenciaCardiaca === fc, `FC servidor ${m.frecuenciaCardiaca} vs Historial ${fc}`);
    return `Servidor: id ${m.id}, FC ${m.frecuenciaCardiaca}, SpO2 ${m.spo2}, ${m.temperatura} °C, actividad "${m.actividad}", usuario ${m.usuario.nombre}`;
  });

  await paso('S-07', 'Recargar la app y volver a sincronizar', 'La lectura sigue Enviada (IndexedDB) y no se reenvía', async () => {
    await page.reload({ waitUntil: 'load' });
    await ir('/historial');
    await page.waitForSelector('#ls .tag');
    const tags = await etiquetas();
    esperar(tags.length === 1 && tags[0] === 'Enviada', `estados tras recargar: ${tags}`);
    await page.click('#sync');
    await esperarTexto('#msg', 'No hay lecturas pendientes.');
    const n = await nuevas();
    esperar(n === 1, `mediciones nuevas en el servidor: ${n}`);
    return `Estado tras recargar: ${tags.join(', ')} · "${await texto('#msg')}" · mediciones nuevas en el servidor: ${n}`;
  });
} finally {
  await browser.close();
  await server.close();
  await backend?.cerrar();
}

const aprobados = pasos.filter((p) => p.estado === 'Aprobado').length;
const resultado = { prueba: 'E2E-SYNC-01', backend: API_URL || 'servidor de contrato (tests/support/servidorContrato.js)', fecha: new Date().toISOString(), duracionMs: Date.now() - t0, navegador: 'Microsoft Edge (headless)', estado: aprobados === pasos.length ? 'Aprobado' : 'Fallido', pasos };
await writeFile(new URL('resultados-e2e-sync.json', OUT), JSON.stringify(resultado, null, 2));
console.log(`\n${aprobados}/${pasos.length} pasos aprobados · E2E-SYNC-01 ${resultado.estado} · ${resultado.duracionMs} ms`);
process.exit(resultado.estado === 'Aprobado' ? 0 : 1);
