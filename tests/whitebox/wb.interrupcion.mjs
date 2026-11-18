// Práctica 11 · Fase 5E: prueba de interrupción de conectividad (NET-05 / NET-06).
// Usa el código real de la app: cola de IndexedDB (src/services/db.js con fake-indexeddb), sincronización
// (src/services/sync.js) y cliente REST (createApi de src/services/api.js) contra Spring Boot, pasando por un
// proxy local que simula: red caída, corte de la conexión DESPUÉS de que el servidor recibió la petición, y red normal.
// Ejecutar: API_URL=http://localhost:8080 node tests/whitebox/wb.interrupcion.mjs [salida.json]
import 'fake-indexeddb/auto';
import http from 'node:http';
import { mock } from 'node:test';
import { writeFile } from 'node:fs/promises';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = memStorage(); globalThis.sessionStorage = memStorage(); globalThis.location = { hash: '' };

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const { api, createApi } = await import('../../src/services/api.js');
const { enviarPendientes } = await import('../../src/services/sync.js');
const { measurementsDao } = await import('../../src/services/db.js');
const { createMeasurement } = await import('../../src/models/measurement.js');

// ── Proxy con tres modos
let modo = 'normal';
const proxy = http.createServer((req, res) => {
  if (modo === 'caida') { req.socket.destroy(); return; }               // la conexión se pierde antes de llegar al servidor
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const up = http.request(API + req.url, { method: req.method, headers: { ...req.headers, host: new URL(API).host } }, (r) => {
      const body = [];
      r.on('data', (c) => body.push(c));
      r.on('end', () => {
        if (modo === 'cortar-respuesta') { req.socket.destroy(); return; }   // el servidor YA procesó; el cliente no recibe respuesta
        res.writeHead(r.statusCode, r.headers); res.end(Buffer.concat(body));
      });
    });
    up.end(Buffer.concat(chunks));
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${proxy.address().port}`;
const cliente = createApi({ baseUrl: PROXY, timeoutMs: 3000 });
mock.method(api, 'enviarMedicion', cliente.enviarMedicion);

// ── Sesión real en el backend
const sesion = await cliente.login('1111');
localStorage.setItem('sm_session', JSON.stringify({ token: sesion.token, user: sesion.usuario, expiresAt: Date.now() + 3600_000 }));
const enServidor = async () => (await (await fetch(`${API}/api/mediciones/historial?limite=500`, { headers: { Authorization: sesion.token } })).json()).length;
const local = async () => {
  const todas = await measurementsDao.obtenerTodos(sesion.usuario.id);
  return { pendientes: todas.filter((m) => !m.synced && !m.error).length, enviadas: todas.filter((m) => m.synced).length };
};

const pasos = [];
const registrar = async (paso, accion) => {
  let resultado;
  const t0 = performance.now();
  try { resultado = { ok: true, valor: await accion() }; } catch (e) { resultado = { ok: false, error: e.message, status: e.status ?? null }; }
  const fila = { paso, modo, ms: +(performance.now() - t0).toFixed(1), resultado, local: await local(), servidor: await enServidor() };
  pasos.push(fila);
  console.log(`${paso} [${modo}] ${fila.ms} ms ->`, JSON.stringify(fila.resultado), '| local', JSON.stringify(fila.local), '| filas en servidor', fila.servidor);
};

const inicial = await enServidor();
console.log('Mediciones de la paciente en el servidor al inicio:', inicial);
for (const hr of [70, 71, 72]) {
  await measurementsDao.insertar(createMeasurement({ userId: sesion.usuario.id, wearable: { heartRate: hr, spo2: 97, temperature: 36.5, steps: 5, calories: 1, battery: 90 }, activity: 'reposo' }));
}

modo = 'caida';
await registrar('1. Sin red: sincronizar 3 lecturas', () => enviarPendientes());
modo = 'cortar-respuesta';
await registrar('2. Se pierde la respuesta (el servidor ya guardó)', () => enviarPendientes());
modo = 'normal';
await registrar('3. Se recupera la red: reintento', () => enviarPendientes());
await registrar('4. Segundo reintento (no debe enviar nada)', () => enviarPendientes());

const final = await enServidor();
const resumen = { inicial, final, esperadas: 3, insertadas: final - inicial, duplicadas: final - inicial - 3 };
console.log('Resumen:', JSON.stringify(resumen));
proxy.close(); mock.restoreAll();
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ fecha: new Date().toISOString(), pasos, resumen }, null, 2));
process.exit(0);
