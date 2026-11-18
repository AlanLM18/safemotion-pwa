// Práctica 12 · Prueba de estrés reproducible de la API de SafeMotion (lectura y escritura).
// Modelo de carga cerrado por duración (como k6): en cada nivel, U usuarios virtuales envían solicitudes en ciclo
// durante DURACION segundos. Se registran RPS, promedio, P50/P90/P95/P99, máximo, % de errores, códigos HTTP,
// CPU y RAM del proceso Java (si se indica JAVA_PID) y las operaciones de Firestore por solicitud (contadores del
// backend en /api/sistema/estado).
//
// Variables:
//   BASE=http://localhost:8080          URL del backend (o https://safemotion-pwa.vercel.app para producción)
//   ESCENARIOS=lectura,escritura        lectura = GET /api/mediciones/historial?limite=20 · escritura = POST /api/mediciones
//   NIVELES=1,5,10,25,50,100            usuarios concurrentes por nivel
//   DURACION=15                         segundos por nivel
//   JAVA_PID=1234                       (opcional) proceso del backend local para medir CPU y RAM
//   ETIQUETA=antes                      nombre de la corrida (antes / despues)
// Ejecutar: BASE=http://localhost:8080 JAVA_PID=... node tests/estres/estres.mjs salida.json
// ADVERTENCIA: el escenario de escritura crea mediciones; úsese solo contra el emulador o una base de pruebas.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const BASE = (process.env.BASE ?? 'http://localhost:8080').replace(/\/$/, '');
const ESCENARIOS = (process.env.ESCENARIOS ?? 'lectura,escritura').split(',');
const NIVELES = (process.env.NIVELES ?? '1,5,10,25,50,100').split(',').map(Number);
const DURACION = Number(process.env.DURACION ?? 15) * 1000;
const PID = process.env.JAVA_PID;
const ETIQUETA = process.env.ETIQUETA ?? 'corrida';
const OUT = process.argv[2];

async function http(method, path, { token, body } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method, signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes: buf.length, ms: performance.now() - t0, json: () => JSON.parse(buf.toString()) };
  } catch (e) {
    return { status: e.name === 'TimeoutError' ? 'timeout' : 'error-red', bytes: 0, ms: performance.now() - t0 };
  }
}
const pct = (s, q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
async function proceso() {
  if (!PID) return null;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${PID}; "$($p.TotalProcessorTime.TotalSeconds);$($p.WorkingSet64)"`]);
    const [cpu, ws] = stdout.trim().split(';').map(Number);
    return { cpu, ws, t: performance.now() };   // t: momento de la muestra, para dividir entre el tiempo real transcurrido
  } catch { return null; }
}
const operaciones = async () => (await http('GET', '/api/sistema/estado')).json?.()?.operaciones ?? null;

const login = async (pin) => (await http('POST', '/api/auth/login', { body: { pin } })).json();
const pacientes = [await login('0000'), await login('1111')];
if (!pacientes.every((p) => p?.token)) throw new Error('No se pudo iniciar sesión');
let seq = 0;
const ESC = {
  lectura: { nombre: 'Lectura · GET /api/mediciones/historial?limite=20', fn: (u) => http('GET', '/api/mediciones/historial?limite=20', { token: pacientes[u % 2].token }) },
  escritura: {
    nombre: 'Escritura · POST /api/mediciones', fn: (u) => http('POST', '/api/mediciones', {
      token: pacientes[u % 2].token,
      body: { frecuenciaCardiaca: 60 + (seq % 40), temperatura: 36.5, spo2: 97, pasos: 10, calorias: 1, actividad: 'reposo', bateria: 80, idLocal: `estres${ETIQUETA}${Date.now()}${seq++}` }
    })
  }
};

async function nivel(esc, usuarios) {
  const tiempos = [], codigos = {}; let bytes = 0, errores = 0;
  const op0 = await operaciones();
  const p0 = await proceso(); let wsMax = p0?.ws ?? 0, wsMin = p0?.ws ?? Infinity;
  const cpuMuestras = []; let ultimo = p0;
  const muestreo = PID ? setInterval(async () => {
    const p = await proceso(); if (!p) return;
    wsMax = Math.max(wsMax, p.ws); wsMin = Math.min(wsMin, p.ws);
    if (ultimo && p.t - ultimo.t > 500) cpuMuestras.push(((p.cpu - ultimo.cpu) / ((p.t - ultimo.t) / 1000)) * 100);   // % de un núcleo (100 % = 1 núcleo)
    ultimo = p;
  }, 1000) : null;
  const t0 = performance.now(), fin = t0 + DURACION;
  await Promise.all(Array.from({ length: usuarios }, async (_, u) => {
    while (performance.now() < fin) {
      const r = await esc.fn(u);
      tiempos.push(r.ms); bytes += r.bytes;
      codigos[r.status] = (codigos[r.status] ?? 0) + 1;
      if (!(typeof r.status === 'number' && r.status >= 200 && r.status < 300)) errores++;
    }
  }));
  const dur = (performance.now() - t0) / 1000;
  clearInterval(muestreo);
  const p1 = await proceso();
  const op1 = await operaciones();
  const s = [...tiempos].sort((a, b) => a - b);
  const n = s.length;
  const fila = {
    escenario: esc.nombre, usuarios, solicitudes: n, exitosas: n - errores, errores, errorPct: +(100 * errores / n).toFixed(2), codigos,
    rps: +(n / dur).toFixed(1), prom: +(s.reduce((a, b) => a + b, 0) / n).toFixed(1), min: +s[0].toFixed(1),
    p50: +pct(s, 0.5).toFixed(1), p90: +pct(s, 0.9).toFixed(1), p95: +pct(s, 0.95).toFixed(1), p99: +pct(s, 0.99).toFixed(1), max: +s[n - 1].toFixed(1),
    mbps: +((bytes * 8) / dur / 1e6).toFixed(2),
    cpuProm: p0 && p1 ? +(((p1.cpu - p0.cpu) / dur) * 100).toFixed(1) : null,
    cpuMax: cpuMuestras.length ? +Math.max(...cpuMuestras).toFixed(1) : null,
    ramMinMB: p0 ? +(Math.min(wsMin, p1?.ws ?? wsMin) / 1048576).toFixed(0) : null,
    ramMaxMB: p0 ? +(Math.max(wsMax, p1?.ws ?? 0) / 1048576).toFixed(0) : null,
    // por solicitud (se descuenta la lectura del propio /api/sistema/estado)
    lecturasFirestorePorSolicitud: op0 && op1 ? +((op1.lecturasFirestore - op0.lecturasFirestore - 1) / n).toFixed(2) : null,
    verificacionesTokenPorSolicitud: op0 && op1 ? +((op1.verificacionesToken - op0.verificacionesToken) / n).toFixed(2) : null
  };
  console.log(`${esc.nombre} · ${usuarios} usuarios: ${fila.solicitudes} solic · ${fila.rps} RPS · prom ${fila.prom} · P90 ${fila.p90} · P95 ${fila.p95} · máx ${fila.max} ms · errores ${fila.errorPct}% ${JSON.stringify(codigos)}` +
    (PID ? ` · CPU ${fila.cpuProm}% (máx ${fila.cpuMax}%) · RAM ${fila.ramMaxMB} MB` : '') + (op0 ? ` · lecturas/solic ${fila.lecturasFirestorePorSolicitud} · verif/solic ${fila.verificacionesTokenPorSolicitud}` : ''));
  return fila;
}

const salida = { etiqueta: ETIQUETA, base: BASE, fecha: new Date().toISOString(), duracionNivelS: DURACION / 1000, niveles: NIVELES, resultados: [] };
for (const e of ESCENARIOS) {
  await ESC[e].fn(0);   // calentamiento
  for (const u of NIVELES) {
    salida.resultados.push(await nivel(ESC[e], u));
    await new Promise((r) => setTimeout(r, 2000));   // pausa entre niveles
  }
}
if (OUT) await writeFile(OUT, JSON.stringify(salida, null, 2));
process.exit(0);
