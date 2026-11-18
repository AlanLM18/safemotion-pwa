// Práctica 11 · Fase 5: latencia HTTP, tasa de transferencia y carga controlada contra el backend propio.
// Solo ambiente de pruebas propio (Spring Boot local + MySQL safemotion_wb). Datos de prueba no sensibles.
// Ejecutar: API_URL=http://localhost:8080 JAVA_PID=<pid del backend> node tests/whitebox/wb.rendimiento.mjs [salida.json]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { writeFile } from 'node:fs/promises';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const PID = process.env.JAVA_PID;
const salida = { fecha: new Date().toISOString(), api: API };

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const prom = s.reduce((a, b) => a + b, 0) / s.length;
  const de = Math.sqrt(s.reduce((a, b) => a + (b - prom) ** 2, 0) / s.length);
  const p = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { n: s.length, min: +s[0].toFixed(2), prom: +prom.toFixed(2), max: +s.at(-1).toFixed(2), de: +de.toFixed(2), p95: +p(0.95).toFixed(2) };
};
const mbps = (bytes, ms) => +((bytes * 8) / (ms / 1000) / 1e6).toFixed(2);

async function http(method, path, { token, body } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes: buf.length, ms: performance.now() - t0, json: () => JSON.parse(buf.toString()) };
  } catch (e) {
    return { status: 0, bytes: 0, ms: performance.now() - t0, error: e.message };
  }
}
// CPU (segundos acumulados) y memoria (working set) del proceso Java del backend.
// Asíncrono: un muestreo síncrono bloquearía el event loop del cliente e inflaría las latencias medidas.
async function proceso() {
  if (!PID) return null;
  const out = (await execFileP('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${PID}; "$($p.TotalProcessorTime.TotalSeconds);$($p.WorkingSet64)"`], { encoding: 'utf8' })).stdout.trim();
  const [cpu, ws] = out.split(';').map(Number);
  return { cpu, ws };
}

const login = async (pin) => (await http('POST', '/api/auth/login', { body: JSON.stringify({ pin }) })).json();
const juan = await login('0000');
const T = juan.token;
const medicion = JSON.stringify({ frecuenciaCardiaca: 75, temperatura: 36.5, spo2: 97, pasos: 10, calorias: 1, actividad: 'reposo', bateria: 80 });
await http('GET', '/api/mediciones/historial?limite=20', { token: T });   // calentamiento (JIT / pool de conexiones)

// ── B y D: diez solicitudes consecutivas al mismo endpoint, mismos datos y condiciones
const diez = [];
for (let i = 1; i <= 10; i++) {
  const r = await http('GET', '/api/mediciones/historial?limite=20', { token: T });
  diez.push({ solicitud: i, codigo: r.status, ms: +r.ms.toFixed(2), bytes: r.bytes });
}
salida.diezSolicitudes = { endpoint: 'GET /api/mediciones/historial?limite=20', filas: diez, tiempo: stats(diez.map((d) => d.ms)), bytes: stats(diez.map((d) => d.bytes)) };
console.log('Diez solicitudes:', JSON.stringify(salida.diezSolicitudes.tiempo), 'bytes', diez[0].bytes);

// ── C: tasa de transferencia (descarga = respuesta grande; subida = cuerpo grande)
const descargas = [];
for (let i = 0; i < 3; i++) {
  const r = await http('GET', '/api/mediciones/historial?limite=500', { token: T });
  descargas.push({ codigo: r.status, bytes: r.bytes, ms: +r.ms.toFixed(2), mbps: mbps(r.bytes, r.ms) });
}
const relleno = 'x'.repeat(1024 * 1024);   // 1 MiB en un campo que Jackson ignora (FAIL_ON_UNKNOWN_PROPERTIES = false)
const cuerpoGrande = JSON.stringify({ ...JSON.parse(medicion), relleno });
const subidas = [];
for (let i = 0; i < 3; i++) {
  const r = await http('POST', '/api/mediciones', { token: T, body: cuerpoGrande });
  subidas.push({ codigo: r.status, bytes: Buffer.byteLength(cuerpoGrande), ms: +r.ms.toFixed(2), mbps: mbps(Buffer.byteLength(cuerpoGrande), r.ms) });
}
salida.transferencia = { descargas, subidas };
console.log('Descarga:', descargas.map((d) => `${d.bytes} B ${d.ms} ms ${d.mbps} Mbps`).join(' | '));
console.log('Subida  :', subidas.map((d) => `${d.bytes} B ${d.ms} ms ${d.mbps} Mbps (HTTP ${d.codigo})`).join(' | '));

// ── Tamaño de respuesta según el límite pedido (impacto del tamaño del JSON)
salida.tamanos = [];
for (const limite of [1, 20, 100, 250, 500]) {
  const r = await http('GET', `/api/mediciones/historial?limite=${limite}`, { token: T });
  salida.tamanos.push({ limite, bytes: r.bytes, ms: +r.ms.toFixed(2) });
}
console.log('Tamaños:', salida.tamanos.map((t) => `${t.limite}->${t.bytes}B/${t.ms}ms`).join(' '));

// ── NET-07: carga controlada. 1, 5 y 10 usuarios concurrentes, 40 solicitudes por escenario.
async function escenario(nombre, usuarios, total, fn) {
  const tiempos = [], codigos = {}; let bytes = 0, fallidas = 0, i = 0;
  const p0 = await proceso(); let wsMax = p0?.ws ?? 0;
  const muestreo = PID ? setInterval(() => { proceso().then((p) => { wsMax = Math.max(wsMax, p.ws); }, () => {}); }, 700) : null;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: usuarios }, async () => {
    while (i < total) {
      i++;
      const r = await fn();
      tiempos.push(r.ms); bytes += r.bytes;
      codigos[r.status] = (codigos[r.status] ?? 0) + 1;
      if (r.status < 200 || r.status >= 300) fallidas++;
    }
  }));
  const dur = performance.now() - t0;
  clearInterval(muestreo);
  const p1 = await proceso();
  const fila = {
    escenario: nombre, usuarios, solicitudes: tiempos.length, exitosas: tiempos.length - fallidas, fallidas, codigos,
    ...stats(tiempos), duracionMs: +dur.toFixed(0), rps: +(tiempos.length / (dur / 1000)).toFixed(1), mbps: mbps(bytes, dur),
    cpuPct: p0 ? +(((p1.cpu - p0.cpu) / (dur / 1000)) * 100).toFixed(1) : null, memMB: p0 ? +(Math.max(wsMax, p1.ws) / 1048576).toFixed(0) : null
  };
  console.log(`${nombre} x${usuarios}: prom ${fila.prom} ms, p95 ${fila.p95} ms, ok ${fila.exitosas}/${fila.solicitudes}, ${fila.rps} req/s, CPU ${fila.cpuPct}%, mem ${fila.memMB} MB`);
  return fila;
}
salida.carga = [];
const N = Number(process.env.WB_N ?? 40);
for (const u of [1, 5, 10]) salida.carga.push(await escenario('Lectura GET /api/mediciones/historial?limite=20', u, N, () => http('GET', '/api/mediciones/historial?limite=20', { token: T })));
for (const u of [1, 5, 10]) salida.carga.push(await escenario('Escritura POST /api/mediciones', u, N, () => http('POST', '/api/mediciones', { token: T, body: medicion })));
for (const u of [1, 5, 10]) salida.carga.push(await escenario('Lectura GET /api/sistema/estado', u, N, () => http('GET', '/api/sistema/estado')));

if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(salida, null, 2));
