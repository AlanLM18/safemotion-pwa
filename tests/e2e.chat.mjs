// E2E del chat médico y el SOS con DOS dispositivos a la vez: paciente (Juan, 0000) y doctor (Dra. Ana, 2222),
// cada uno en su propia sesión de navegador. Cima de la pirámide: pocas pruebas, lentas, sobre la app completa.
// Con API_URL usa Spring Boot (comunicación real entre dispositivos); sin API_URL, el modo simulado con el asistente.
//   API_URL=http://localhost:8080 npm run test:e2e:chat
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApi } from '../src/services/api.js';

const API_URL = process.env.API_URL ?? '';
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = process.env.E2E_OUT ? pathToFileURL(process.env.E2E_OUT.replace(/\/?$/, '/')) : new URL('../docs/chat-medico/evidencias/', import.meta.url);
await mkdir(OUT, { recursive: true });

// Estado inicial conocido en el backend: sin SOS abiertos y el chat de Juan vacío.
if (API_URL) {
  const api = createApi({ baseUrl: API_URL });
  const dra = await api.login('2222'), juan = await api.login('0000');
  for (const e of await api.emergencias(dra.token)) if (e.estado === 'ABIERTA') await api.atenderEmergencia(e.id, dra.token);
  await api.limpiarChat(juan.usuario.id, dra.token);
  await api.logout(dra.token); await api.logout(juan.token);
}

process.env.VITE_API_URL = API_URL;
Object.assign(process.env, { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' });   // esta E2E no usa Firebase aunque .env lo configure
const server = await createServer({ server: { port: 5198, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const BASE = 'http://localhost:5198/';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispositivo() {
  const ctx = await browser.createBrowserContext();               // almacenamiento separado = otro teléfono
  await ctx.overridePermissions(BASE, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.setGeolocation({ latitude: 20.5888, longitude: -100.3899 });   // Querétaro
  page.on('dialog', (d) => d.accept());                           // confirmación de "Limpiar historial"
  // "Sin red" hacia el backend: se cortan solo las peticiones a la API (la emulación offline de Chrome
  // no se restablece bien cuando el Service Worker ya controla la página).
  page.sinRed = false;
  await page.setRequestInterception(true);
  page.on('request', (r) => (page.sinRed && API_URL && r.url().startsWith(API_URL) ? r.abort('internetdisconnected') : r.continue()));
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1500);
  await page.reload({ waitUntil: 'load' });                       // el Service Worker toma control en la primera carga
  return page;
}
const paciente = await dispositivo();
const doctor = await dispositivo();

const resultados = [];
const ir = async (page, h) => { await page.evaluate((x) => { location.hash = x; }, h); await sleep(400); };
const hash = (page) => page.evaluate(() => location.hash);
const esperar = (cond, msg) => { if (!cond) throw new Error(msg); };
class Omitido extends Error {}
const requiereBackend = (motivo = 'Requiere backend') => { if (!API_URL) throw new Omitido(motivo); };
const esperarTexto = (page, sel, t, timeout = 6000) =>
  page.waitForFunction((s, x) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(x)), { timeout }, sel, t);
const tabs = (page) => page.$$eval('nav.tabs a span', (s) => s.map((x) => x.textContent).join(', '));
const burbujas = (page) => page.$$eval('#msgs .msg', (l) => l.map((m) => m.textContent.replace(/\s+/g, ' ').trim()));

async function caso(id, req, descripcion, page, fn) {
  let estado = 'Aprobado', detalle = '';
  try { detalle = (await fn()) ?? ''; } catch (e) { estado = e instanceof Omitido ? 'Omitido' : 'Fallido'; detalle = e.message.split('\n')[0]; }
  const captura = `${id}.png`;
  await page.screenshot({ path: fileURLToPath(new URL(captura, OUT)) });
  resultados.push({ id, req, descripcion, estado, detalle, captura });
  console.log(`${{ Aprobado: '✔', Omitido: '-', Fallido: '✖' }[estado]} ${id} [${req}] ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
}

async function login(page, pin) {
  await ir(page, '/login');
  await page.waitForSelector('input[name=pin]');
  await page.type('input[name=pin]', pin);
  await page.click('#go');
  await page.waitForSelector('nav.tabs', { timeout: 6000 });
}

try {
  await caso('CH-01', 'Roles', 'Cada dispositivo ve las pantallas de su rol', doctor, async () => {
    await login(paciente, '0000');
    await login(doctor, '2222');
    const tp = await tabs(paciente), td = await tabs(doctor);
    esperar(tp.includes('Doctor') && !tp.includes('Consultas'), `paciente: ${tp}`);
    esperar(td === 'Consultas, Cuenta' && (await hash(doctor)) === '#/consultas', `doctor: ${td}`);
    return `Paciente: ${tp} · Doctor: ${td}`;
  });

  await caso('CH-02', 'Alerta', 'Una alerta del wearable muestra un aviso con acceso al doctor', paciente, async () => {
    await ir(paciente, '/dispositivo');
    await paciente.select('#esc', 'alerta');
    await paciente.click('#sim');
    await paciente.waitForSelector('.toast.alerta .toast-accion', { timeout: 15000 });
    return await paciente.$eval('.toast.alerta', (t) => t.textContent);
  });

  await caso('CH-03', 'P6-4', 'Desde el aviso se abre el chat y se envía el mensaje de la alerta', paciente, async () => {
    await paciente.click('.toast.alerta .toast-accion');
    await esperarTexto(paciente, '#msgs .msg.mio', 'Tengo una alerta');
    esperar((await hash(paciente)) === '#/doctor', await hash(paciente));
    return (await burbujas(paciente))[0];
  });

  await caso('CH-04', 'P6-6', 'Un mensaje vacío no se envía y muestra la validación', paciente, async () => {
    const antes = (await burbujas(paciente)).length;
    await paciente.type('#txt', '    ');
    await paciente.click('#send');
    await esperarTexto(paciente, '#err', 'Escribe un mensaje');
    await sleep(800);
    esperar((await burbujas(paciente)).length === antes, 'se envió un mensaje vacío');
    await paciente.$eval('#txt', (e) => { e.value = ''; });
    return 'Escribe un mensaje antes de enviarlo.';
  });

  await caso('CH-05', 'P6-1, P6-5', 'El doctor ve al paciente en su bandeja y abre la conversación', doctor, async () => {
    requiereBackend('Modo simulado: cada navegador tiene sus propios datos');
    await esperarTexto(doctor, '#ls li', 'Juan Pérez');
    await doctor.click('a[href="#/consultas?p=2"]');
    await esperarTexto(doctor, '#msgs .msg', 'Tengo una alerta');
    return (await burbujas(doctor)).join(' | ');
  });

  await caso('CH-06', 'P6-4, P6-7', 'El doctor responde y recibe el aviso de "Mensaje enviado"', doctor, async () => {
    requiereBackend();
    await doctor.type('#txt', 'Siéntate y respira lento. Te reviso tus signos y te digo qué tomar.');
    await doctor.click('#send');
    await esperarTexto(doctor, '.toast', 'Mensaje enviado');
    return 'Mensaje enviado';
  });

  await caso('CH-07', 'P6-5, A1, A2', 'El paciente recibe la respuesta con hora y el contador por emisor', paciente, async () => {
    const autor = API_URL ? 'Dra. Ana Torres' : 'Asistente médico (simulado)';
    await esperarTexto(paciente, '#msgs .msg', autor, 8000);   // llega por la consulta periódica (3 s)
    const cnt = await paciente.$eval('#cnt', (e) => e.textContent);
    esperar(/Juan Pérez: 1/.test(cnt), cnt);
    const ultima = (await burbujas(paciente)).at(-1);
    esperar(/\d{2}:\d{2}/.test(ultima), 'sin hora: ' + ultima);
    return `${ultima} · contador${cnt}`;
  });

  await caso('CH-08', 'SOS', 'El SOS manda ubicación y signos y confirma al paciente', paciente, async () => {
    await paciente.click('#sos');
    await paciente.waitForSelector('dialog.sos-dialog[open]');
    await paciente.click('dialog #ok');
    await esperarTexto(paciente, 'dialog #st', 'Ayuda solicitada');
    return await paciente.$eval('dialog #st', (e) => e.textContent);
  });

  await caso('CH-09', 'SOS', 'El doctor ve el SOS primero, con signos y mapa, y lo marca como atendido', doctor, async () => {
    requiereBackend();
    await ir(doctor, '/consultas');
    await esperarTexto(doctor, '#ls li.urgente', 'Juan Pérez');
    await doctor.click('a[href="#/consultas?p=2"]');
    await doctor.waitForSelector('#emg:not([hidden]) #atender');
    const detalle = await doctor.$eval('#emg', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    esperar(await doctor.$('#emg a[href*="maps?q=20.5888"]'), 'sin enlace al mapa');
    await doctor.screenshot({ path: fileURLToPath(new URL('CH-09a.png', OUT)) });
    await doctor.click('#atender');
    await esperarTexto(doctor, '.toast', 'atendida');
    return detalle;
  });

  await caso('CH-10', 'SOS', 'El paciente ve que su SOS fue atendido', paciente, async () => {
    await paciente.click('dialog #ok');                         // "Ir al chat" cierra la ventana
    requiereBackend();
    await esperarTexto(paciente, '#emg', 'Atendido por Dra. Ana Torres', 8000);
    await esperarTexto(paciente, '#msgs .msg', 'fue atendida por Dra. Ana Torres', 8000);
    return await paciente.$eval('#emg', (e) => e.textContent);
  });

  await caso('CH-11', 'TC07', 'Sin conexión, el mensaje no se pierde y se avisa', paciente, async () => {
    requiereBackend('En modo simulado no hay red de por medio');
    paciente.sinRed = true;
    await paciente.type('#txt', 'Sigo mareado');
    await paciente.click('#send');
    await esperarTexto(paciente, '#err', 'No se pudo enviar', 12000);
    await sleep(3500);                                          // pasa una consulta periódica fallida
    const aviso = await paciente.$eval('#err', (e) => e.textContent);
    const queda = await paciente.$eval('#txt', (e) => e.value);
    paciente.sinRed = false;
    esperar(aviso.startsWith('No se pudo enviar'), `el aviso cambió a: ${aviso}`);
    esperar(queda === 'Sigo mareado', `texto: "${queda}"`);
    return 'Aviso de error y el texto se conserva para reintentar';
  });

  await caso('CH-12', 'A3', 'Limpiar historial deja la conversación vacía', paciente, async () => {
    await paciente.$eval('#txt', (e) => { e.value = ''; });
    await paciente.click('#clr');
    await esperarTexto(paciente, '.toast', 'Historial limpiado');
    await esperarTexto(paciente, '#msgs', 'Aún no hay mensajes');
    return 'Conversación vacía';
  });

  await caso('CH-13', 'Roles', 'Las rutas de otro rol redirigen a la pantalla propia', doctor, async () => {
    await ir(paciente, '/consultas');
    await ir(doctor, '/inicio');
    const hp = await hash(paciente), hd = await hash(doctor);
    esperar(hp === '#/inicio' && hd === '#/consultas', `${hp} / ${hd}`);
    return `Paciente #/consultas -> ${hp} · Doctor #/inicio -> ${hd}`;
  });
} finally {
  await writeFile(new URL('resultados-chat.json', OUT), JSON.stringify({ backend: API_URL || 'simulado', resultados }, null, 2));
  await browser.close();
  await server.close();
  const cuenta = (e) => resultados.filter((r) => r.estado === e).length, fallidos = cuenta('Fallido');
  console.log(`\n${resultados.length} casos · ${cuenta('Aprobado')} aprobados · ${cuenta('Omitido')} omitidos · ${fallidos} fallidos`);
  process.exitCode = fallidos ? 1 : 0;
}
