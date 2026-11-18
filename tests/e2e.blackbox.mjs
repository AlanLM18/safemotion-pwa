// Práctica 8: pruebas de caja negra end-to-end sobre la interfaz real (modo simulado, sin backend).
// Levanta Vite, abre la app en Microsoft Edge sin ventana (Puppeteer) y guarda una captura por caso.
// Ejecutar: npm run test:e2e   (EDGE_PATH=... si Edge no está en la ruta por defecto)
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// E2E_OUT permite guardar las capturas en otra carpeta (p. ej. una corrida de regresión sin tocar la evidencia entregada).
const OUT = process.env.E2E_OUT ? pathToFileURL(process.env.E2E_OUT.replace(/\/?$/, '/')) : new URL('../docs/practica8/evidencias/', import.meta.url);
await mkdir(OUT, { recursive: true });

Object.assign(process.env, { VITE_FIREBASE_API_KEY: '', VITE_FIREBASE_PROJECT_ID: '' });   // esta E2E no usa Firebase aunque .env lo configure
const server = await createServer({ server: { port: 5199, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const BASE = 'http://localhost:5199/';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

const resultados = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const hash = () => page.evaluate(() => location.hash);
const ir = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await sleep(300); };
const esperarTexto = (sel, t, timeout = 4000) => page.waitForFunction((s, x) => document.querySelector(s)?.textContent.includes(x), { timeout }, sel, t);

async function caso(id, req, descripcion, fn) {
  let estado = 'Aprobado', detalle = '';
  try { detalle = (await fn()) ?? ''; } catch (e) { estado = 'Fallido'; detalle = e.message.split('\n')[0]; }
  const captura = `${id}.png`;
  await page.screenshot({ path: fileURLToPath(new URL(captura, OUT)) });
  resultados.push({ id, req, descripcion, estado, detalle, captura });
  console.log(`${estado === 'Aprobado' ? '✔' : '✖'} ${id} [${req}] ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
}
const esperar = (cond, msg) => { if (!cond) throw new Error(msg); };

async function login(pin) {
  await ir('/login');
  await page.waitForSelector('input[name=pin]');
  await page.$eval('input[name=pin]', (e) => { e.value = ''; });
  await page.type('input[name=pin]', pin);
  await page.click('#go');
  // Espera la respuesta: el botón se reactiva (error) o la pantalla de Login desaparece (éxito).
  await page.waitForFunction(() => !document.querySelector('#go')?.disabled, { timeout: 5000 });
  await sleep(200);
}
async function logout() {
  await ir('/cuenta');
  await page.click('#out');
  await page.waitForSelector('input[name=pin]');
}

try {
  await page.goto(BASE, { waitUntil: 'load' });

  await caso('E2E-01', 'RN-01', 'Sin sesión, cualquier pantalla protegida redirige a Login', async () => {
    await ir('/historial');
    esperar((await hash()) === '#/login', `hash = ${await hash()}`);
    esperar(!(await page.$('nav.tabs')), 'la barra de navegación no debe mostrarse');
    return 'De #/historial a #/login';
  });

  await caso('E2E-02', 'RV-01', 'El campo PIN descarta letras y limita a 4 dígitos', async () => {
    await page.type('input[name=pin]', 'ab12cd345');
    const v = await page.$eval('input[name=pin]', (e) => e.value);
    esperar(v === '1234', `valor = "${v}"`);
    await page.$eval('input[name=pin]', (e) => { e.value = ''; });
    return 'Escrito "ab12cd345", queda "1234"';
  });

  await caso('E2E-03', 'RV-01', 'PIN incompleto muestra mensaje genérico y no inicia sesión', async () => {
    await page.type('input[name=pin]', '12');
    await page.click('#go');
    await esperarTexto('#err', 'Datos de acceso no válidos.');
    esperar((await hash()) === '#/login', 'no debe salir de Login');
    return await texto('#err');
  });

  await caso('E2E-04', 'RV-01', 'PIN con formato válido pero incorrecto muestra el mismo mensaje genérico', async () => {
    await login('9999');
    await esperarTexto('#err', 'Datos de acceso no válidos.');
    const v = await page.$eval('input[name=pin]', (e) => e.value);
    esperar(v === '', 'el campo debe limpiarse');
    return 'Mensaje genérico, campo limpio';
  });

  await caso('E2E-05', 'RF-01', 'Login correcto (0000) abre Inicio con el nombre del usuario', async () => {
    await login('0000');
    await page.waitForFunction(() => location.hash === '#/inicio' && document.querySelector('.hello'), { timeout: 5000 });
    const hola = await texto('.hello');
    esperar(hola === 'Hola, Juan Pérez', hola);
    const tabs = await page.$$eval('nav.tabs a span', (s) => s.map((x) => x.textContent));
    esperar(tabs.join() === 'Inicio,Wearable,Historial,Doctor,Cuenta', tabs.join());
    return `${hola}; pestañas: ${tabs.join(', ')}`;
  });

  await caso('E2E-06', 'RN-01', 'Con sesión, Login y rutas desconocidas redirigen a Inicio', async () => {
    await ir('/login');
    esperar((await hash()) === '#/inicio', `#/login -> ${await hash()}`);
    await ir('/no-existe');
    esperar((await hash()) === '#/inicio', `#/no-existe -> ${await hash()}`);
    return '#/login y #/no-existe -> #/inicio';
  });

  await caso('E2E-07', 'RP-01', 'La sesión se conserva al recargar la página', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.hello');
    const hola = await texto('.hello');
    // El backend simulado vive en memoria y pierde sus sesiones al recargar: se renueva el token.
    await logout(); await login('0000'); await page.waitForSelector('.hello');
    return `${hola} (sigue en Inicio tras recargar)`;
  });

  await caso('E2E-08', 'RV-03', 'Guardar lectura sin sensores ni wearable muestra un aviso y no guarda', async () => {
    await ir('/dispositivo');
    await page.$eval('#sv', (b) => b.click());   // queda bajo la barra de pestañas en pantallas chicas
    await esperarTexto('#msg', 'Conecta el wearable o usa el simulado primero.');
    return await texto('#msg');
  });

  await caso('E2E-09', 'RF-04', 'Wearable simulado en escenario "alerta" resalta los valores fuera de rango', async () => {
    await ir('/dispositivo');
    await page.select('#esc', 'alerta');
    await page.click('#sim');
    await sleep(12500);                          // ~6 lecturas del simulador (cada 2 s) hacia el escenario
    const hr = Number(await texto('#hr')), warn = await page.$$eval('.tile.warn', (t) => t.length);
    esperar(hr > 110, `FC = ${hr}`);
    esperar(warn >= 1, 'debe haber mosaicos resaltados');
    return `FC ${hr} bpm, ${warn} mosaico(s) en alerta`;
  });

  await caso('E2E-10', 'RF-04', 'Inicio muestra el banner de alertas del wearable', async () => {
    await ir('/inicio');
    await page.waitForSelector('#alert:not([hidden])');
    return await texto('#alert');
  });

  await caso('E2E-11', 'RF-02', 'Guardar lectura con wearable simulado confirma el guardado', async () => {
    await ir('/dispositivo');
    await page.select('#esc', 'reposo');
    await sleep(8500);                           // vuelve a valores normales
    await page.$eval('#sv', (b) => b.click());   // queda bajo la barra de pestañas en pantallas chicas
    await esperarTexto('#msg', 'Lectura guardada');
    return await texto('#msg');
  });

  await caso('E2E-12', 'RF-03, RF-05', 'Historial muestra la lectura Pendiente y "Enviar pendientes" la marca Enviada', async () => {
    await ir('/historial');
    await page.waitForSelector('#ls li .tag');
    const antes = await page.$$eval('#ls .tag', (t) => t.map((x) => x.textContent));
    esperar(antes.includes('Pendiente'), `estados: ${antes}`);
    await page.click('#sync');
    await esperarTexto('#msg', 'enviada(s)');
    await sleep(300);
    const despues = await page.$$eval('#ls .tag', (t) => t.map((x) => x.textContent));
    esperar(despues.every((x) => x === 'Enviada'), `estados: ${despues}`);
    return `${await texto('#msg')} Estados: ${despues.join(', ')}`;
  });

  await caso('E2E-13', 'RP-02', 'Enviar de nuevo no reenvía lo ya enviado', async () => {
    await page.click('#sync');
    await esperarTexto('#msg', 'No hay lecturas pendientes.');
    return await texto('#msg');
  });

  await caso('E2E-14', 'RE-01', 'Sin red, el monitoreo automático guarda la lectura en el teléfono', async () => {
    await ir('/inicio');
    await page.setOfflineMode(true);
    await page.click('#mon');
    await esperarTexto('#mres', 'Sin red: lectura guardada en el teléfono');
    const r = await texto('#mres');
    await page.click('#mon');                    // detener
    await page.setOfflineMode(false);
    return r;
  });

  await caso('E2E-15', 'RP-01', 'Eliminar una lectura la quita de la lista y del contador de Inicio', async () => {
    await ir('/historial');
    await page.waitForSelector('#ls .del');
    const n0 = (await page.$$('#ls .del')).length;
    let dialogo = false;
    page.once('dialog', async (d) => { dialogo = true; await d.accept(); });
    await page.click('#ls .del');
    await sleep(400);
    const n1 = (await page.$$('#ls .del')).length;
    esperar(n1 === n0 - 1, `${n0} -> ${n1}`);
    await ir('/inicio');
    await sleep(300);
    const contador = Number(await texto('#n'));
    esperar(contador === n1, `contador ${contador} vs lista ${n1}`);
    return `${n0} -> ${n1} lecturas; contador de Inicio = ${contador}; confirmación previa: ${dialogo ? 'sí' : 'no'}`;
  });

  await caso('E2E-16', 'RN-02', 'Cuenta muestra el rol y "Cerrar sesión" vuelve a Login', async () => {
    await ir('/cuenta');
    const rol = await texto('.card .muted');
    esperar(rol === 'Rol: usuario', rol);
    await page.click('#out');
    await page.waitForSelector('input[name=pin]');
    await ir('/inicio');
    esperar((await hash()) === '#/login', 'tras cerrar sesión no debe entrar a Inicio');
    return `${rol}; tras cerrar sesión #/inicio -> #/login`;
  });

  await caso('E2E-17', 'RN-02', 'Al cambiar de usuario en el mismo teléfono, el historial no muestra lecturas del anterior', async () => {
    await login('0000');
    await page.waitForSelector('.hello');
    await ir('/dispositivo');
    await page.click('#sim');                    // cerrar sesión apagó el simulador
    await sleep(2500);
    await page.$eval('#sv', (b) => b.click());   // queda bajo la barra de pestañas en pantallas chicas
    await esperarTexto('#msg', 'Lectura guardada');
    await logout();
    await login('1234');
    await page.waitForSelector('.hello');
    await ir('/historial');
    await page.waitForSelector('#ls li');
    const ajenas = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('safemotion');
      r.onsuccess = () => {
        const q = r.result.transaction('measurements').objectStore('measurements').getAll();
        q.onsuccess = () => res(q.result.filter((m) => m.userId !== 1).length);
      };
    }));
    const visibles = (await page.$$('#ls .del')).length;
    // Las lecturas de Juan se quedan en el teléfono para cuando él vuelva a entrar, pero el historial no las muestra (D-01).
    esperar(visibles === 0, `el Administrador ve ${visibles} lectura(s) de Juan Pérez`);
    return `Historial del Administrador: ${visibles} lecturas · ${ajenas} lectura(s) de Juan siguen guardadas para él`;
  });

  await caso('E2E-18', 'RV-02', 'Tras 5 PIN incorrectos, el sexto intento se bloquea', async () => {
    await logout();
    for (let i = 0; i < 5; i++) { await login('9999'); await esperarTexto('#err', 'Datos de acceso no válidos.'); }
    await login('0000');
    await esperarTexto('#err', 'Demasiados intentos');
    esperar((await hash()) === '#/login', 'no debe entrar');
    return await texto('#err');
  });

  await caso('E2E-19', 'RV-02', 'El bloqueo se mantiene al recargar la página', async () => {
    await page.reload({ waitUntil: 'load' });
    await login('0000');
    await sleep(1200);
    esperar((await hash()) === '#/login', 'al recargar se reinicia el bloqueo y el PIN correcto entra de inmediato');
    return await texto('#err');
  });

  await caso('E2E-20', 'RN-01, RE-02', 'Una sesión vencida (más de 8 h) obliga a iniciar sesión otra vez', async () => {
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('sm_session'));
      localStorage.setItem('sm_session', JSON.stringify({ ...s, expiresAt: Date.now() - 1000 }));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('input[name=pin]');
    esperar((await hash()) === '#/login', `hash = ${await hash()}`);
    return 'Redirige a #/login';
  });
} finally {
  await writeFile(new URL('resultados-e2e.json', OUT), JSON.stringify(resultados, null, 2));
  await browser.close();
  await server.close();
  const fallidos = resultados.filter((r) => r.estado !== 'Aprobado').length;
  console.log(`\n${resultados.length} casos · ${resultados.length - fallidos} aprobados · ${fallidos} fallidos`);
  process.exitCode = fallidos ? 1 : 0;
}
