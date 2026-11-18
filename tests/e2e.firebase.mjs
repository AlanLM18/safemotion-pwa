// Prácticas 9 y 10 · E2E con Firebase y dispositivos Android emulados: paciente (Pixel 5), recepción (Galaxy S9+
// y un segundo teléfono, Galaxy S8) y doctora (Pixel 4). Todos usan la misma app contra el mismo proyecto.
// Flujo real de SafeMotion: el paciente pide SOS -> recepción lo canaliza -> la doctora lo atiende y ve la medición.
//   Emulador:       npm run test:e2e:firebase
//   Proyecto real:  FIREBASE_REAL=1 npm run test:e2e:firebase:real   (cuentas de .env.pruebas)
import { createServer } from 'vite';
import puppeteer, { KnownDevices } from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp } from 'firebase/firestore';
import { createFirebaseApi } from '../src/services/apiFirebase.js';
import { createMeasurement, toMedicionRequest } from '../src/models/measurement.js';
import { entornoFirebase, prepararEmulador } from './support/firebaseCuentas.js';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ent = entornoFirebase();
if (!ent.disponible) { console.error('Ejecuta con el emulador (npm run test:e2e:firebase) o con FIREBASE_REAL=1.'); process.exit(2); }
if (ent.emulador) await prepararEmulador(ent);
const C = ent.cuentas;
const SUB = ent.real ? 'firebase-real' : 'firebase-emulador';
const OUT9 = new URL(`../docs/practica9-sos-compartido/evidencias-${SUB}/`, import.meta.url);
const OUT10 = new URL(`../docs/practica10-roles/evidencias-${SUB}/`, import.meta.url);
await mkdir(OUT9, { recursive: true }); await mkdir(OUT10, { recursive: true });

Object.assign(process.env, {
  VITE_API_URL: '', VITE_FIREBASE_API_KEY: ent.config.apiKey, VITE_FIREBASE_PROJECT_ID: ent.config.projectId, VITE_FIREBASE_AUTH_DOMAIN: ent.config.authDomain,
  ...(ent.emulador ? { VITE_FIREBASE_EMULADOR: '1', VITE_FIREBASE_EMULADOR_AUTH: ent.emulador.auth, VITE_FIREBASE_EMULADOR_FIRESTORE: ent.emulador.firestore } : { VITE_FIREBASE_EMULADOR: '' })
});
const server = await createServer({ server: { port: 5195, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const BASE = 'http://localhost:5195/';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inicio = new Date();

// Verificador: cuentas fuera de los dispositivos, para ver lo que quedó en Firestore y hacer peticiones directas.
const v = {};
for (const k of ['juan', 'maria', 'laura', 'ana', 'admin']) {
  v[k] = createFirebaseApi({ config: ent.config, emulador: ent.emulador, nombre: `verif-${k}` });
  await v[k].login(C[k].pin);
}
const uid = (k) => v[k].auth.currentUser.uid;
// Deja sin SOS activos a los pacientes de la prueba (recepción canaliza con Ana y el admin lo cierra).
async function cerrarSos(paciente) {
  for (const e of await v[paciente].emergencias()) {
    if (e.estado === 'ABIERTA') await v.laura.canalizarEmergencia(e.id, uid('ana'));
    if (e.estado !== 'ATENDIDA') await v.admin.atenderEmergencia(e.id);
  }
}
const sosActivo = async (paciente) => (await v[paciente].emergencias()).find((e) => e.estado !== 'ATENDIDA') ?? null;

// ---------- dispositivos ----------
async function nuevaPagina(d) {
  const page = await d.ctx.newPage();
  const m = KnownDevices[d.modelo];
  await page.emulate({ userAgent: m.userAgent, viewport: { ...m.viewport, deviceScaleFactor: 2 } });
  page.on('dialog', (dl) => dl.accept());
  await page.goto(BASE, { waitUntil: 'load' });
  d.page = page;
}
async function dispositivo(letra, modelo, rol) { const d = { letra, modelo, rol, ctx: await browser.createBrowserContext() }; await nuevaPagina(d); return d; }
const ir = async (d, h) => { await d.page.bringToFront(); await d.page.evaluate((x) => { location.hash = x; }, h); await sleep(500); };
async function pulsar(d, sel) { await d.page.bringToFront(); await d.page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await d.page.click(sel); }
const texto = (d, sel) => d.page.$eval(sel, (e) => e.textContent.trim());
const esperarTexto = (d, sel, t, timeout = 15000) => d.page.waitForFunction((s, x) => document.querySelector(s)?.textContent.includes(x), { timeout, polling: 100 }, sel, t);
async function escribir(d, sel, valor) { await d.page.$eval(sel, (e) => { e.value = ''; }); await d.page.type(sel, valor); }
async function entrar(d, cuenta, pin = cuenta.pin) {
  await ir(d, '/login');
  await d.page.waitForSelector('input[name=pin]');
  await escribir(d, '#f input[name=pin]', pin);
  // Espera a que se abra la sesión o aparezca el error; si el clic se perdió (página recién abierta), se repite.
  for (let intento = 0; intento < 3; intento++) {
    await pulsar(d, '#go');
    const ok = await d.page.waitForFunction(() => location.hash !== '#/login' || !document.querySelector('#err')?.hidden, { timeout: 15000, polling: 100 }).then(() => true, () => false);
    if (ok) break;
  }
  await sleep(500);
}
async function salir(d) { await ir(d, '/cuenta'); await pulsar(d, '#out'); await d.page.waitForSelector('input[name=pin]', { timeout: 10000 }); }
async function pedirSos(d) {
  await ir(d, '/doctor');
  await d.page.waitForSelector('#sos');
  await pulsar(d, '#sos');
  await d.page.waitForSelector('dialog #ok');
  await pulsar(d, 'dialog #ok');
  await d.page.waitForFunction(() => { const t = document.querySelector('dialog #st')?.textContent ?? ''; return t && t !== 'Enviando...'; }, { timeout: 20000, polling: 100 });
  const t = await texto(d, 'dialog #st');
  return t;
}
const cerrarDialogo = (d) => d.page.evaluate(() => document.querySelector('dialog')?.close());
async function foto(d, out, nombre, ver = null) {
  await d.page.bringToFront();
  await d.page.evaluate((s) => (s ? document.querySelector(s)?.scrollIntoView({ block: 'center' }) : scrollTo(0, 0)), ver);
  await sleep(250);
  await d.page.screenshot({ path: fileURLToPath(new URL(`${nombre}-${d.letra}.png`, out)) });
  return `${nombre}-${d.letra}.png`;
}
// Consola: Emulator UI (vista equivalente a Firebase Console). Con el proyecto real no hay captura automática.
async function consola(out, nombre, ruta) {
  if (ent.real) return null;
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
  try {
    await p.goto(`http://127.0.0.1:4000/firestore/default/data/${ruta}`, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(1500);
    await p.screenshot({ path: fileURLToPath(new URL(`${nombre}.png`, out)) });
    return `${nombre}.png`;
  } catch { return null; } finally { await p.close(); }
}

// ---------- matrices ----------
const matriz9 = [], matriz10 = [];
let abortado = null, A, B, B2, D;
async function prueba(matriz, id, nombre, esperado, fn) {
  if (abortado) { matriz.push({ id, nombre, esperado, resultado: 'No ejecutado', observacion: `Falló un paso anterior (${abortado})`, evidencias: [] }); return; }
  const fila = { id, nombre, esperado, resultado: 'Aprobado', observacion: '', evidencias: [] };
  for (const d of [A, B, B2, D].filter(Boolean)) await d.page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())).catch(() => {});
  try { Object.assign(fila, await fn(fila.evidencias)); } catch (e) {
    fila.resultado = 'Fallido'; fila.observacion = e.message.split('\n')[0]; abortado = id;
    for (const d of [A, B, B2, D].filter(Boolean)) {
      await d.page.screenshot({ path: fileURLToPath(new URL(`FALLO-${id}-${d.letra}.png`, matriz === matriz9 ? OUT9 : OUT10)) }).catch(() => {});
      console.log(`  ${d.letra}:`, await d.page.evaluate(() => `${location.hash} · ${document.querySelector('main')?.innerText.slice(0, 220).replace(/\n/g, ' | ')}`).catch((x) => x.message));
    }
  }
  fila.evidencias = fila.evidencias.filter(Boolean);
  matriz.push(fila);
  console.log(`${fila.resultado === 'Aprobado' ? '✔' : '✖'} ${id} ${nombre} -> ${fila.observacion}`);
}
const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };
const seg = (ms) => (ms < 100 ? 'menos de 0.1 s' : `${(ms / 1000).toFixed(1)} s`);
const tiempos = {};
const registro = [];   // peticiones directas a Firestore y su respuesta (Práctica 10)
let sos1;

try {
  await cerrarSos('juan'); await cerrarSos('maria');
  A = await dispositivo('A', 'Pixel 5', 'paciente');
  B = await dispositivo('B', 'Galaxy S9+', 'recepción');
  D = await dispositivo('D', 'Pixel 4', 'doctora');

  // ================= PRÁCTICA 9 =================
  await prueba(matriz9, 'DB-01', 'Conexión compartida', 'Ambos dispositivos acceden al mismo proyecto y colección.', async (ev) => {
    await entrar(A, C.juan); await entrar(B, C.laura); await entrar(D, C.ana);
    const destinos = [await A.page.evaluate(() => location.hash), await B.page.evaluate(() => location.hash), await D.page.evaluate(() => location.hash)];
    exigir(destinos.join() === '#/inicio,#/recepcion,#/consultas', `pantallas de inicio: ${destinos}`);
    const bases = [];
    for (const d of [A, B, D]) { await ir(d, '/cuenta'); bases.push(await d.page.$$eval('section.card p', (p) => p.at(-1).textContent)); ev.push(await foto(d, OUT9, 'F1-cuenta')); }
    exigir(new Set(bases).size === 1 && bases[0].includes(ent.config.projectId), bases.join(' / '));
    ev.push(await consola(OUT9, 'F1-consola-usuarios', 'usuarios'));
    return { observacion: `Paciente (Juan, ${A.modelo}), recepción (Laura, ${B.modelo}) y doctora (Ana, ${D.modelo}) iniciaron sesión con su PIN; cada uno entró a su pantalla (Inicio, Recepción, Consultas) y todos muestran "${bases[0]}".` };
  });

  await prueba(matriz9, 'DB-02', 'Escritura desde A', 'La incidencia creada por A aparece en la base remota.', async (ev) => {
    await ir(B, '/recepcion');
    const t = await pedirSos(A);
    tiempos.sos = Date.now();
    exigir(t.includes('recepción ya la recibió'), t);
    ev.push(await foto(A, OUT9, 'F2-sos-enviado'));
    await cerrarDialogo(A);
    sos1 = await sosActivo('juan');
    exigir(sos1?.estado === 'ABIERTA', 'no está en Firestore');
    return { observacion: `El paciente pulsó SOS y la app confirmó "${t}". Firestore tiene el SOS ${sos1.id} en estado ABIERTA con sus signos.` };
  });

  await prueba(matriz9, 'DB-03', 'Lectura desde B', 'B puede recuperar la incidencia creada por A.', async (ev) => {
    await B.page.waitForFunction((id) => document.querySelector(`li[data-id="${id}"] .tag`)?.textContent === 'Nuevo', { timeout: 20000, polling: 100 }, sos1.id);
    tiempos.sosEnRecepcion = Date.now() - tiempos.sos;
    ev.push(await foto(B, OUT9, 'F2-sos-en-recepcion', `li[data-id="${sos1.id}"]`));
    return { observacion: `El SOS apareció solo en Recepción, sin recargar, ${seg(tiempos.sosEnRecepcion)} después de la confirmación en el teléfono del paciente (la lista se consulta cada 3 s).` };
  });

  await prueba(matriz9, 'DB-04', 'Escritura desde B', 'La incidencia creada por B se almacena correctamente.', async (ev) => {
    await B.page.select(`li[data-id="${sos1.id}"] select`, uid('ana'));
    await pulsar(B, `[data-canalizar="${sos1.id}"]`);
    tiempos.canalizado = Date.now();
    await B.page.waitForFunction((id) => document.querySelector(`li[data-id="${id}"] .tag`)?.textContent === 'Canalizado', { timeout: 20000, polling: 100 }, sos1.id);
    const s = await sosActivo('juan');
    exigir(s.estado === 'CANALIZADA' && s.canalizadaANombre === 'Dra. Ana Torres', `${s.estado} / ${s.canalizadaANombre}`);
    ev.push(await foto(B, OUT9, 'F2-canalizado', `li[data-id="${sos1.id}"]`));
    return { observacion: `Recepción eligió a la Dra. Ana Torres y pulsó Canalizar. Firestore: CANALIZADA, canalizada por ${s.canalizadaPorNombre}, versión ${s.version}.` };
  });

  await prueba(matriz9, 'DB-05', 'Lectura desde A', 'A puede recuperar la incidencia creada por B.', async (ev) => {
    await ir(A, '/doctor');
    await esperarTexto(A, '#emg', 'Canalizado con Dra. Ana Torres', 20000);
    await esperarTexto(A, '#msgs', 'canalizó tu solicitud', 20000);
    tiempos.pacienteVeCanalizado = Date.now() - tiempos.canalizado;
    ev.push(await foto(A, OUT9, 'F2-paciente-ve-canalizado', '#msgs'));
    return { observacion: `El paciente vio "Canalizado con Dra. Ana Torres" y el aviso de recepción en su chat ${seg(tiempos.pacienteVeCanalizado)} después.` };
  });

  await prueba(matriz9, 'DB-06', 'Actualización cruzada', 'El cambio confirmado es visible en el otro dispositivo.', async (ev) => {
    // El paciente guarda y envía una lectura (wearable simulado + pasos del teléfono); la doctora la ve con el SOS.
    await ir(A, '/dispositivo');
    await pulsar(A, '#sim');
    await sleep(2500);
    await pulsar(A, '#sv');
    await esperarTexto(A, '#msg', 'Lectura guardada');
    ev.push(await foto(A, OUT9, 'F3-wearable-pasos'));
    await ir(A, '/historial');
    await A.page.waitForSelector('#ls .tag');
    await pulsar(A, '#sync');
    await esperarTexto(A, '#msg', 'enviada(s)', 20000);
    const m = await v.ana.ultimaMedicion(uid('juan'));
    exigir(m, 'la medición no llegó a Firestore');
    await ir(D, `/consultas?p=${uid('juan')}`);
    await D.page.waitForSelector('#atender', { timeout: 20000 });
    await esperarTexto(D, '#med-signos', `FC ${m.frecuenciaCardiaca}`, 20000);
    ev.push(await foto(A, OUT9, 'F3-medicion-enviada', '#ls'), await foto(D, OUT9, 'F3-doctora-ve-sos-y-medicion'));
    await pulsar(D, '#atender');
    const t0 = Date.now();
    await ir(A, '/doctor');
    await esperarTexto(A, '#emg', 'Atendido por Dra. Ana Torres', 20000);
    tiempos.atendidoVisto = Date.now() - t0;
    await B.page.waitForFunction((id) => document.querySelector(`li[data-id="${id}"] .tag`)?.textContent === 'Atendido', { timeout: 20000, polling: 100 }, sos1.id);
    ev.push(await foto(A, OUT9, 'F3-paciente-ve-atendido'), await foto(B, OUT9, 'F3-recepcion-ve-atendido', `li[data-id="${sos1.id}"]`));
    ev.push(await consola(OUT9, 'F3-consola-emergencia', `emergencias/${sos1.id}`));
    // La doctora pide una ambulancia desde el chat y el paciente recibe el aviso
    await ir(D, `/consultas?p=${uid('juan')}`);
    await D.page.waitForSelector('#ambulancia');
    await pulsar(D, '#ambulancia');
    await esperarTexto(D, '#amb-msg', 'Ambulancia solicitada', 20000);
    await ir(A, '/doctor');
    await A.page.waitForFunction(() => document.querySelector('#msgs .msg.ambulancia'), { timeout: 20000, polling: 100 });
    ev.push(await foto(D, OUT9, 'F3-doctora-pide-ambulancia', '#amb'), await foto(A, OUT9, 'F3-paciente-ve-ambulancia', '#msgs .msg.ambulancia'));
    const final = (await v.juan.emergencias()).find((e) => e.id === sos1.id);
    exigir(final.estado === 'ATENDIDA' && final.version === 2, `${final.estado} v${final.version}`);
    return { observacion: `La medición del paciente (FC ${m.frecuenciaCardiaca} bpm, ${m.pasos} pasos) llegó a Firestore y la doctora la vio junto al SOS. La doctora lo marcó como atendido y el paciente vio "Atendido por Dra. Ana Torres" en ${seg(tiempos.atendidoVisto)}; recepción también lo vio. Final en Firestore: ATENDIDA, versión 2. Después la doctora pidió una ambulancia desde el chat y al paciente le llegó el aviso "🚑 AMBULANCIA EN CAMINO" (simulado).` };
  });

  await prueba(matriz9, 'DB-07', 'Modificación concurrente', 'El resultado final cumple la política de actualización definida.', async (ev) => {
    B2 = await dispositivo('B2', 'Galaxy S8', 'recepción');
    await entrar(B2, C.laura);
    await ir(A, '/doctor');
    const t = await pedirSos(A);
    exigir(t.includes('recepción ya la recibió'), t);
    await cerrarDialogo(A);
    const sos2 = await sosActivo('juan');
    for (const d of [B, B2]) { await ir(d, '/recepcion'); await d.page.waitForSelector(`[data-canalizar="${sos2.id}"]`, { timeout: 20000 }); }
    await B.page.select(`li[data-id="${sos2.id}"] select`, uid('ana'));
    await B2.page.select(`li[data-id="${sos2.id}"] select`, C.luis.uid ?? (await v.laura.doctores()).find((x) => x.nombre.includes('Luis')).id);
    ev.push(await foto(B, OUT9, 'F4-recepcion1-elige-ana', `li[data-id="${sos2.id}"]`), await foto(B2, OUT9, 'F4-recepcion2-elige-luis', `li[data-id="${sos2.id}"]`));
    // Los dos teléfonos pulsan "Canalizar" al mismo tiempo
    await Promise.all([B, B2].map((d) => d.page.$eval(`[data-canalizar="${sos2.id}"]`, (b) => b.click())));
    await Promise.all([B, B2].map((d) => d.page.waitForSelector('.toast', { timeout: 20000 })));
    const avisos = [await texto(B, '.toast'), await texto(B2, '.toast')];
    const final = (await v.juan.emergencias()).find((e) => e.id === sos2.id);
    exigir(avisos.filter((x) => x.startsWith('SOS de')).length === 1 && avisos.filter((x) => x.startsWith('Ya lo había canalizado')).length === 1, avisos.join(' | '));
    exigir(final.version === 1 && final.estado === 'CANALIZADA', `v${final.version} ${final.estado}`);
    ev.push(await foto(B, OUT9, 'F4-resultado-recepcion1'), await foto(B2, OUT9, 'F4-resultado-recepcion2'));
    return { observacion: `Dos teléfonos de recepción canalizaron el mismo SOS al mismo tiempo, uno con la Dra. Ana Torres y otro con el Dr. Luis Ramírez. Ganó uno: "${avisos.find((x) => x.startsWith('SOS de'))}". El otro recibió "${avisos.find((x) => x.startsWith('Ya lo'))}" y no sobrescribió. Firestore: CANALIZADA con ${final.canalizadaANombre}, versión 1.` };
  });

  await prueba(matriz9, 'DB-08', 'Persistencia', 'Los registros confirmados permanecen tras cerrar y abrir la app.', async (ev) => {
    await A.page.close();
    await nuevaPagina(A);
    await ir(A, '/historial');
    await A.page.waitForSelector('#ls .tag');
    const tags = await A.page.$$eval('#ls .tag', (t) => t.map((x) => x.textContent));
    exigir(tags.includes('Enviada'), `estados: ${tags}`);
    await ir(A, '/doctor');
    await esperarTexto(A, '#emg', 'Canalizado con', 20000);
    ev.push(await foto(A, OUT9, 'F5-reabrir-historial'), await foto(A, OUT9, 'F5-reabrir-sos'));
    return { observacion: 'Al cerrar y abrir la app, la sesión siguió activa: Historial muestra la lectura Enviada y la pantalla Doctor trae de Firestore el estado del SOS (canalizado) y el chat con los avisos de recepción y de la doctora.' };
  });

  await prueba(matriz9, 'DB-09', 'Pérdida de conexión', 'La aplicación informa o gestiona la operación sin confirmar falsamente el éxito.', async (ev) => {
    await cerrarSos('juan');
    await ir(A, '/doctor');
    await A.page.setOfflineMode(true);
    const t = await pedirSos(A);
    ev.push(await foto(A, OUT9, 'F6-sos-sin-red'));
    await cerrarDialogo(A);
    exigir(t.includes('No fue posible') && t.includes('911'), t);
    await A.page.setOfflineMode(false);
    await sleep(3000);
    exigir(!(await sosActivo('juan')), 'el SOS sin confirmar llegó a Firestore al volver la red');
    const t2 = await pedirSos(A);
    await cerrarDialogo(A);
    exigir(t2.includes('recepción ya la recibió'), t2);
    ev.push(await foto(A, OUT9, 'F6-sos-con-red'));
    await cerrarSos('juan');
    return { observacion: `Sin red, el SOS respondió "${t}": no se confirmó nada y ofrece llamar al 911. Al volver la red, Firestore no tenía ningún SOS pendiente de enviarse solo; el siguiente intento sí llegó a recepción.` };
  });

  // ================= PRÁCTICA 10 =================
  await prueba(matriz10, 'SEG-02', 'Inicio de sesión inválido', 'Acceso rechazado.', async (ev) => {
    await salir(A);
    await entrar(A, C.maria, '9876');                   // PIN que no es de ninguna cuenta
    await esperarTexto(A, '#err', 'Datos de acceso no válidos.');
    exigir((await A.page.evaluate(() => location.hash)) === '#/login', 'entró');
    ev.push(await foto(A, OUT10, 'SEG-02-pin-incorrecto'));
    return { observacion: 'Con un PIN que no es de ninguna cuenta, Firebase Authentication rechazó el acceso y la app mostró el mensaje genérico "Datos de acceso no válidos." sin abrir sesión.' };
  });

  await prueba(matriz10, 'SEG-01', 'Inicio de sesión válido', 'Autenticación exitosa.', async (ev) => {
    await entrar(A, C.maria);
    exigir((await A.page.evaluate(() => location.hash)) === '#/inicio', 'no entró');
    for (const d of [A, B]) { await ir(d, '/cuenta'); ev.push(await foto(d, OUT10, 'SEG-01-uid')); }
    const [uA, uB] = [await texto(A, '#uid'), await texto(B, '#uid')];
    exigir(uA === uid('maria') && uB === uid('laura'), `${uA} · ${uB}`);
    return { observacion: `Paciente: María López, UID ${uA}. Recepción: Laura Gómez, UID ${uB}. Cada dispositivo muestra en Cuenta el UID y el rol de su usuario.` };
  });

  let sosMaria;
  await prueba(matriz10, 'SEG-03', 'Creación propia', 'Documento creado con propietario A.', async (ev) => {
    const t = await pedirSos(A);
    await cerrarDialogo(A);
    exigir(t.includes('recepción ya la recibió'), t);
    sosMaria = await sosActivo('maria');
    const s = await getDoc(doc(v.maria.db, 'emergencias', sosMaria.id));
    exigir(s.data().pacienteId === uid('maria'), 'propietario incorrecto');
    ev.push(await foto(A, OUT10, 'SEG-03-sos-propio'), await consola(OUT10, 'SEG-03-consola-emergencias', 'emergencias'));
    return { observacion: `El SOS ${sosMaria.id} quedó con pacienteId = ${uid('maria')} (el UID de la sesión), y las mediciones de cada paciente viven en usuarios/{su UID}/mediciones.` };
  });

  // Peticiones directas a Firestore con la sesión de cada cuenta, fuera de la app (cliente modificado)
  const directo = async (accion, fn) => {
    try { await fn(); registro.push(`${accion} → PERMITIDA`); return 'permitida'; }
    catch (e) { registro.push(`${accion} → ${e.code ?? e.status}`); return e.code ?? String(e.status); }
  };
  const lectura = (k) => toMedicionRequest(createMeasurement({ userId: uid(k), wearable: { heartRate: 80, spo2: 97, temperature: 36.6, steps: 10, calories: 0, battery: 90 }, activity: 'reposo' }));

  await prueba(matriz10, 'SEG-04', 'Suplantación de propietario', 'Firestore rechaza la escritura.', async () => {
    const r1 = await directo('Juan crea un SOS con pacienteId de María', () => setDoc(doc(collection(v.juan.db, 'emergencias')), { pacienteId: uid('maria'), paciente: 'María López', fecha: serverTimestamp(), estado: 'ABIERTA', version: 0 }));
    const req = lectura('maria');
    const r2 = await directo('Juan escribe una medición en usuarios/{María}/mediciones', () => setDoc(doc(v.juan.db, 'usuarios', uid('maria'), 'mediciones', req.idLocal), { ...req, pacienteId: uid('maria'), fecha: serverTimestamp() }));
    exigir(r1 === 'permission-denied' && r2 === 'permission-denied', `${r1}, ${r2}`);
    return { observacion: 'Firestore respondió permission-denied a las dos escrituras: el SOS exige pacienteId == request.auth.uid y la medición solo se escribe en la carpeta del propio usuario.' };
  });

  await prueba(matriz10, 'SEG-05', 'Lectura de datos ajenos', 'Lectura denegada.', async (ev) => {
    await ir(B, '/consultas');
    exigir((await B.page.evaluate(() => location.hash)) === '#/recepcion', 'recepción abrió Consultas');
    const r1 = await directo('Juan lee las mediciones de María', () => getDocs(collection(v.juan.db, 'usuarios', uid('maria'), 'mediciones')));
    const r2 = await directo('Juan lee el chat de María', () => getDocs(collection(v.juan.db, 'conversaciones', uid('maria'), 'mensajes')));
    const r3 = await directo('Juan lee el SOS de María', () => getDoc(doc(v.juan.db, 'emergencias', sosMaria.id)));
    const r4 = await directo('Recepción lee las mediciones de Juan', () => getDocs(collection(v.laura.db, 'usuarios', uid('juan'), 'mediciones')));
    const r5 = await directo('Recepción lee el chat de Juan', () => getDocs(collection(v.laura.db, 'conversaciones', uid('juan'), 'mensajes')));
    exigir([r1, r2, r3, r4, r5].every((r) => r === 'permission-denied'), [r1, r2, r3, r4, r5].join(', '));
    ev.push(await foto(B, OUT10, 'SEG-05-recepcion-sin-consultas'));
    return { observacion: 'Recepción no tiene la pantalla Consultas (la app la regresa a Recepción) y Firestore le niega las mediciones y el chat de los pacientes. Un paciente no puede leer las mediciones, el chat ni el SOS de otro: permission-denied en las 5 lecturas.' };
  });

  await prueba(matriz10, 'SEG-06', 'Actualización de datos ajenos', 'Actualización denegada.', async () => {
    const r1 = await directo('Juan cambia el SOS de María', () => updateDoc(doc(v.juan.db, 'emergencias', sosMaria.id), { estado: 'CANALIZADA', version: 1 }));
    const r2 = await directo('Recepción marca el SOS como ATENDIDO', () => updateDoc(doc(v.laura.db, 'emergencias', sosMaria.id), { estado: 'ATENDIDA', atendidaPor: 'Laura', atendidaPorUid: uid('laura'), fechaAtencion: serverTimestamp(), version: 1 }));
    const r3 = await directo('La doctora atiende un SOS que recepción no le canalizó', () => updateDoc(doc(v.ana.db, 'emergencias', sosMaria.id), { estado: 'ATENDIDA', atendidaPor: 'Ana', atendidaPorUid: uid('ana'), fechaAtencion: serverTimestamp(), version: 1 }));
    exigir([r1, r2, r3].every((r) => r === 'permission-denied'), [r1, r2, r3].join(', '));
    const s = (await v.maria.emergencias()).find((e) => e.id === sosMaria.id);
    exigir(s.estado === 'ABIERTA' && s.version === 0, `${s.estado} v${s.version}`);
    return { observacion: 'Firestore negó las 3 actualizaciones: otro paciente, recepción intentando cerrar el SOS y la doctora atendiéndolo antes de que recepción se lo canalizara. El SOS de María sigue ABIERTO, versión 0.' };
  });

  await prueba(matriz10, 'SEG-07', 'Eliminación de datos ajenos', 'Eliminación denegada.', async () => {
    const r1 = await directo('Juan elimina el SOS de María', () => deleteDoc(doc(v.juan.db, 'emergencias', sosMaria.id)));
    const [msg] = await v.maria.mensajes(uid('maria'));
    const r2 = await directo('Juan elimina un mensaje del chat de María', () => deleteDoc(doc(v.juan.db, 'conversaciones', uid('maria'), 'mensajes', msg.id)));
    exigir(r1 === 'permission-denied' && r2 === 'permission-denied', `${r1}, ${r2}`);
    exigir((await v.maria.emergencias()).some((e) => e.id === sosMaria.id), 'el SOS desapareció');
    return { observacion: 'permission-denied: un SOS no lo borra nadie (queda como historial clínico) y el chat de un paciente no lo puede borrar otro.' };
  });

  await prueba(matriz10, 'SEG-08', 'Actualización propia', 'Actualización permitida.', async (ev) => {
    await ir(A, '/doctor');
    await A.page.waitForSelector('#txt');
    await escribir(A, '#txt', 'Me siento mejor, gracias.');
    await pulsar(A, '#send');
    await A.page.waitForFunction(() => [...document.querySelectorAll('#msgs .msg.mio .txt')].some((t) => t.textContent === 'Me siento mejor, gracias.'), { timeout: 20000, polling: 100 });
    ev.push(await foto(A, OUT10, 'SEG-08-mensaje-propio', '#msgs'));
    return { observacion: 'María escribió en su propio chat y el mensaje quedó guardado con su UID como autor.' };
  });

  await prueba(matriz10, 'SEG-09', 'Cambio de propietario', 'Cambio de propietario rechazado.', async () => {
    const r1 = await directo('Juan se asigna el rol de doctor', () => updateDoc(doc(v.juan.db, 'usuarios', uid('juan')), { rol: 'doctor' }));
    const r2 = await directo('María pasa su SOS a nombre de Juan', () => updateDoc(doc(v.maria.db, 'emergencias', sosMaria.id), { pacienteId: uid('juan'), version: 1 }));
    exigir(r1 === 'permission-denied' && r2 === 'permission-denied', `${r1}, ${r2}`);
    exigir((await getDoc(doc(v.juan.db, 'usuarios', uid('juan')))).data().rol === 'usuario', 'cambió el rol');
    return { observacion: 'permission-denied: nadie cambia su propio rol (el rol lo asigna el administrador del proyecto) ni el paciente dueño de un SOS.' };
  });

  await prueba(matriz10, 'SEG-10', 'Acceso sin autenticación', 'Operación rechazada.', async (ev) => {
    await salir(A);
    await ir(A, '/doctor');
    exigir((await A.page.evaluate(() => location.hash)) === '#/login', 'abrió Doctor sin sesión');
    const anon = createFirebaseApi({ config: ent.config, emulador: ent.emulador, nombre: 'sin-sesion' });
    const r1 = await directo('Leer los SOS sin sesión', () => getDocs(collection(anon.db, 'emergencias')));
    const r2 = await directo('Crear un SOS sin sesión', () => setDoc(doc(collection(anon.db, 'emergencias')), { pacienteId: 'nadie', estado: 'ABIERTA', version: 0 }));
    const r3 = await directo('Leer el perfil de Juan sin sesión', () => getDoc(doc(anon.db, 'usuarios', uid('juan'))));
    exigir([r1, r2, r3].every((r) => r === 'permission-denied'), [r1, r2, r3].join(', '));
    await A.page.evaluate((lineas) => {
      document.querySelector('main').insertAdjacentHTML('beforeend', `<section class="card"><span class="k">Peticiones directas a Firestore (fuera de la app)</span><pre style="white-space:pre-wrap;font-size:.7rem;margin:0">${lineas.map((l) => l.replace(/</g, '&lt;')).join('\n')}</pre></section>`);
    }, registro);
    ev.push(await foto(A, OUT10, 'SEG-10-peticiones-directas', 'main section:last-child'));
    return { observacion: `Al cerrar sesión la app regresa a Login. Sin sesión, Firestore rechazó leer y escribir (${[r1, r2, r3].join(', ')}).` };
  });
} finally {
  await cerrarSos('juan').catch(() => {}); await cerrarSos('maria').catch(() => {});
  await browser.close();
  await server.close();
}

const orden10 = ['SEG-01', 'SEG-02', 'SEG-03', 'SEG-04', 'SEG-05', 'SEG-06', 'SEG-07', 'SEG-08', 'SEG-09', 'SEG-10'];
matriz10.sort((a, b) => orden10.indexOf(a.id) - orden10.indexOf(b.id));
const meta = { fuente: 'Firebase (Authentication + Cloud Firestore)', proyecto: ent.config.projectId, modo: ent.real ? 'proyecto real' : 'emulador local', fecha: inicio.toISOString(),
  dispositivos: { A: 'Pixel 5 · paciente', B: 'Galaxy S9+ · recepción', B2: 'Galaxy S8 · recepción', D: 'Pixel 4 · doctora' } };
await writeFile(new URL('resultados-p9.json', OUT9), JSON.stringify({ ...meta, tiempos, matriz: matriz9 }, null, 2));
await writeFile(new URL('resultados-p10.json', OUT10), JSON.stringify({ ...meta, registro, matriz: matriz10 }, null, 2));
const todas = [...matriz9, ...matriz10], ok = todas.filter((f) => f.resultado === 'Aprobado').length;
console.log(`\n${ok}/${todas.length} pruebas aprobadas (P9: ${matriz9.filter((f) => f.resultado === 'Aprobado').length}/${matriz9.length}, P10: ${matriz10.filter((f) => f.resultado === 'Aprobado').length}/${matriz10.length}) · ${meta.modo}`);
process.exit(ok === todas.length ? 0 : 1);
