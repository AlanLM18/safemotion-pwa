// Práctica 8: pruebas de caja negra sobre las interfaces públicas (entradas -> salidas / cambios de estado).
// Cada prueba lleva el ID del requisito que verifica (RF, RV, RP, RN, RE). Ejecutar: npm run test:blackbox
// Sin hardware ni backend: IndexedDB simulada (fake-indexeddb), almacenamiento del navegador en memoria
// y un servidor HTTP local que imita a Spring Boot para los casos de error.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Entorno de navegador mínimo (antes de importar los módulos de la app).
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const auth = await import('../src/services/auth.js');
const { api, createApi, ApiError } = await import('../src/services/api.js');
const { measurementsDao } = await import('../src/services/db.js');
const { enviarPendientes } = await import('../src/services/sync.js');
const { createMeasurement, toMedicionRequest, validateMedicionRequest } = await import('../src/models/measurement.js');
const { evaluarAlertas } = await import('../src/models/alerts.js');

const vitales = { heartRate: 80, spo2: 97, temperature: 36.6, steps: 120, calories: 5, battery: 90 };
const lectura = (userId, wearable = vitales) => createMeasurement({ userId, wearable, gyroscope: { x: 0.1, y: -0.2, z: 0.3 }, activity: 'caminando' });
const reqValido = { frecuenciaCardiaca: 80, temperatura: 36.6, spo2: 97, pasos: 10, calorias: 0, actividad: 'reposo', bateria: 90 };
const limpiarDb = async () => { for (const m of await measurementsDao.obtenerTodos()) await measurementsDao.eliminar(m.id); };
const salir = () => { auth.logout(); localStorage.clear(); };
const realNow = Date.now;
let desfase = 0;
const adelantar = (ms) => { desfase += ms; Date.now = () => realNow() + desfase; };

// Servidor HTTP local con respuestas controladas (imita códigos de Spring Boot).
function servidor(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

// ---------- Operaciones principales ----------

test('RF-01 / CP-01: login con PIN válido de usuario crea sesión de 8 h', async () => {
  const antes = Date.now();
  const u = await auth.login('0000');
  assert.deepEqual(u, { id: 2, nombre: 'Juan Pérez', rol: 'usuario' });
  assert.equal(auth.isAuthenticated(), true);
  const s = auth.getSession();
  assert.ok(s.token);
  const horas = (s.expiresAt - antes) / 3600_000;
  assert.ok(horas >= 7.99 && horas <= 8.01, `expira en ${horas} h`);
  salir();
});

test('RF-01 / CP-02: login con PIN de administrador devuelve rol admin', async () => {
  const u = await auth.login('1234');
  assert.equal(u.rol, 'admin');
  assert.equal(u.nombre, 'Administrador');
  salir();
});

test('RF-02 / CP-03: guardar lectura unificada (wearable + teléfono) y consultarla en historial', async () => {
  await limpiarDb();
  const m = lectura(2);
  await measurementsDao.insertar(m);
  const todas = await measurementsDao.obtenerTodos();
  assert.equal(todas.length, 1);
  assert.equal(todas[0].id, m.id);
  assert.equal(todas[0].source, 'merged');
  assert.equal(todas[0].synced, false);           // estado inicial: Pendiente
  assert.equal(todas[0].wearable.heartRate, 80);
});

test('RF-03 / CP-04: enviar pendientes marca la lectura como Enviada y el servidor la devuelve en su historial', async () => {
  await auth.login('0000');
  const r = await enviarPendientes();
  assert.deepEqual(r, { total: 1, enviadas: 1, rechazadas: 0 });
  const [m] = await measurementsDao.obtenerTodos();
  assert.equal(m.synced, true);
  assert.ok(m.serverId);
  const h = await api.historial(auth.getSession().token);
  assert.equal(h.length, 1);
  assert.equal(h[0].frecuenciaCardiaca, 80);
  assert.equal(h[0].actividad, 'caminando');
  salir();
});

test('RF-04 / CP-05: reglas de alerta en sus valores límite (FC 45-110, Temp <= 37.8, SpO2 >= 92)', () => {
  const tipos = (w) => evaluarAlertas(w).map((a) => a.tipo);
  assert.deepEqual(tipos({ heartRate: 110, temperature: 37.8, spo2: 92 }), []);                  // en el límite: sin alerta
  assert.deepEqual(tipos({ heartRate: 45, temperature: 36.5, spo2: 100 }), []);
  assert.deepEqual(tipos({ heartRate: 111 }), ['Frecuencia cardiaca alta']);
  assert.deepEqual(tipos({ heartRate: 44 }), ['Frecuencia cardiaca baja']);
  assert.deepEqual(tipos({ temperature: 37.9 }), ['Temperatura elevada']);
  assert.deepEqual(tipos({ spo2: 91 }), ['Saturación de oxígeno baja']);
  assert.deepEqual(tipos(null), []);
});

// ---------- Validaciones ----------

test('RV-01 / CP-06: PIN con formato inválido se rechaza sin consultar al servidor', async () => {
  let llamadas = 0;
  const original = api.login;
  api.login = async (...a) => { llamadas++; return original(...a); };
  try {
    for (const pin of ['', '123', '12345', 'abcd', '12a4', ' 123', '12.4', null, 1234]) {
      await assert.rejects(auth.login(pin), { message: 'Credenciales inválidas' }, `PIN ${JSON.stringify(pin)}`);
      if (auth.segundosDeBloqueo()) break;   // el bloqueo se prueba aparte
    }
    assert.equal(llamadas, 0);
    assert.equal(auth.isAuthenticated(), false);
  } finally { api.login = original; }
});

test('RV-02 / CP-07: bloqueo tras 5 intentos fallidos durante 30 s, incluso con el PIN correcto', async () => {
  // Reloj con desfase para simular el paso del tiempo sin esperar 30 s reales.
  if (auth.segundosDeBloqueo()) adelantar(31_000);   // espera cualquier bloqueo previo
  await auth.login('0000'); salir();           // un login correcto reinicia el contador
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login('9999'), { message: 'Credenciales inválidas' });
  assert.ok(auth.segundosDeBloqueo() >= 29 && auth.segundosDeBloqueo() <= 30);
  await assert.rejects(auth.login('0000'), { message: 'Bloqueado' });
  adelantar(30_500);                           // pasan 30 s
  assert.equal(auth.segundosDeBloqueo(), 0);
  assert.equal((await auth.login('0000')).nombre, 'Juan Pérez');
  salir();
});

test('RV-03 / CP-08: rangos de MedicionRequest en sus valores límite', () => {
  const v = (p) => validateMedicionRequest({ ...reqValido, ...p });
  // Válidos (límites inclusivos)
  for (const p of [{ frecuenciaCardiaca: 30 }, { frecuenciaCardiaca: 220 }, { temperatura: 30 }, { temperatura: 43 }, { spo2: 0 }, { spo2: 100 }, { bateria: 0 }, { bateria: 100 }, { pasos: 0 }]) {
    assert.deepEqual(v(p), [], JSON.stringify(p));
  }
  // Inválidos (justo fuera del límite, tipo incorrecto o vacío)
  assert.deepEqual(v({ frecuenciaCardiaca: 29 }), ['frecuenciaCardiaca fuera de rango (30-220)']);
  assert.deepEqual(v({ frecuenciaCardiaca: 221 }), ['frecuenciaCardiaca fuera de rango (30-220)']);
  assert.deepEqual(v({ temperatura: 29.9 }), ['temperatura fuera de rango (30-43)']);
  assert.deepEqual(v({ temperatura: 43.1 }), ['temperatura fuera de rango (30-43)']);
  assert.deepEqual(v({ spo2: 101 }), ['spo2 fuera de rango (0-100)']);
  assert.deepEqual(v({ bateria: -1 }), ['bateria fuera de rango (0-100)']);
  assert.deepEqual(v({ frecuenciaCardiaca: 80.5 }), ['frecuenciaCardiaca debe ser entero']);
  assert.deepEqual(v({ frecuenciaCardiaca: '80' }), ['frecuenciaCardiaca requerido']);
  assert.deepEqual(v({ pasos: -1 }), ['pasos inválido']);
  assert.deepEqual(v({ actividad: '   ' }), ['actividad requerida']);
});

test('RV-03 / CP-09: el servidor (contrato) rechaza con 400 una medición fuera de rango', async () => {
  const { token } = await api.login('0000');
  await assert.rejects(api.enviarMedicion({ ...reqValido, temperatura: 44 }, token), { status: 400 });
  await api.logout(token);
});

// ---------- Persistencia y consistencia ----------

test('RP-01 / CP-10: alta, modificación y baja en IndexedDB conservan la consistencia', async () => {
  await limpiarDb();
  const a = lectura(2), b = lectura(2);
  await measurementsDao.insertar(a);
  await measurementsDao.insertar(b);
  assert.notEqual(a.id, b.id);
  await assert.rejects(measurementsDao.insertar(a));                   // id duplicado: no se crea otro registro
  assert.equal((await measurementsDao.obtenerTodos()).length, 2);
  await measurementsDao.actualizar({ ...a, synced: true });
  const tras = await measurementsDao.obtenerTodos();
  assert.equal(tras.length, 2);                                        // modificar no duplica
  assert.equal(tras.find((m) => m.id === a.id).synced, true);
  assert.equal(tras.find((m) => m.id === b.id).synced, false);         // el otro no cambia
  await measurementsDao.eliminar(a.id);
  await measurementsDao.eliminar('no-existe');                         // eliminar algo inexistente no falla
  const fin = await measurementsDao.obtenerTodos();
  assert.deepEqual(fin.map((m) => m.id), [b.id]);
  assert.deepEqual((await measurementsDao.obtenerPendientes()).map((m) => m.id), [b.id]);
  await limpiarDb();
});

test('RF-05 / CP-11: el historial se ordena de la lectura más reciente a la más antigua', async () => {
  await limpiarDb();
  const vieja = { ...lectura(2), timestamp: '2026-10-01T10:00:00.000Z' };
  const nueva = { ...lectura(2), timestamp: '2026-10-02T10:00:00.000Z' };
  await measurementsDao.insertar(vieja);
  await measurementsDao.insertar(nueva);
  assert.deepEqual((await measurementsDao.obtenerTodos()).map((m) => m.id), [nueva.id, vieja.id]);
  await limpiarDb();
});

test('RP-02 / CP-12: dos envíos simultáneos no duplican mediciones en el servidor', async () => {
  await limpiarDb();
  await auth.login('0000');
  const previas = (await api.historial(auth.getSession().token, 100)).length;
  await measurementsDao.insertar(lectura(2));
  await measurementsDao.insertar(lectura(2));
  const [r1, r2] = await Promise.all([enviarPendientes(), enviarPendientes()]);
  assert.equal(r1, r2);                                                // comparten la misma sincronización
  const r3 = await enviarPendientes();
  assert.equal(r3.total, 0);                                           // ya no queda nada pendiente
  const h = await api.historial(auth.getSession().token, 100);
  assert.equal(h.length - previas, 2);                                 // exactamente 2 nuevas, sin duplicados
  salir(); await limpiarDb();
});

test('RP-02 / CP-13: una lectura rechazada queda marcada y no se reintenta', async () => {
  await limpiarDb();
  await auth.login('0000');
  const soloTelefono = createMeasurement({ userId: 2, gyroscope: { x: 0, y: 0, z: 0 } });
  await measurementsDao.insertar(soloTelefono);
  assert.deepEqual(await enviarPendientes(), { total: 1, enviadas: 0, rechazadas: 1 });
  const [m] = await measurementsDao.obtenerTodos();
  assert.equal(m.synced, false);
  assert.equal(m.error, 'frecuenciaCardiaca requerido');
  assert.equal((await enviarPendientes()).total, 0);
  salir(); await limpiarDb();
});

// ---------- Navegación, roles y permisos ----------

test('RN-02 / CP-14: el servidor exige token y aísla el historial por usuario', async () => {
  await assert.rejects(api.enviarMedicion(reqValido, 'token-falso'), { status: 401 });
  await assert.rejects(api.historial('token-falso'), { status: 401 });
  const juan = await api.login('0000'), admin = await api.login('1234');
  await api.enviarMedicion(reqValido, admin.token);
  const hJuan = await api.historial(juan.token);
  assert.ok(hJuan.every((m) => m.usuario.id === 2), 'Juan no debe ver mediciones del admin');
  await api.logout(juan.token);
  await assert.rejects(api.historial(juan.token), { status: 401 });   // logout invalida el token
  await api.logout(admin.token);
});

test('RN-02 / CP-15: en el mismo teléfono, un usuario no debe ver ni enviar lecturas de otro', async () => {
  await limpiarDb();
  await auth.login('0000');
  await measurementsDao.insertar(lectura(2));                         // lectura de Juan
  salir();
  await auth.login('1234');                                           // entra el administrador
  const visibles = await measurementsDao.obtenerPendientes(auth.getSession().user.id);   // lo que la app consulta para el usuario en sesión
  const ajenas = visibles.filter((m) => m.userId !== auth.getSession().user.id);
  try {
    assert.equal(ajenas.length, 0, `el administrador ve ${ajenas.length} lectura(s) de Juan Pérez como propias`);
  } finally { salir(); await limpiarDb(); }
});

test('RN-01 / CP-16: la sesión vencida deja de considerarse autenticada', () => {
  localStorage.setItem('sm_session', JSON.stringify({ token: 't', user: { id: 2 }, expiresAt: Date.now() - 1 }));
  assert.equal(auth.isAuthenticated(), false);
  localStorage.setItem('sm_session', '{no es json');
  assert.equal(auth.isAuthenticated(), false);                         // almacenamiento dañado: no truena
  localStorage.clear();
});

// ---------- Manejo de errores ----------

test('RE-01 / CP-17: servidor caído o sin respuesta produce un error controlado', async () => {
  const caido = createApi({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500 });
  await assert.rejects(caido.estado(), { status: 0, message: 'Sin conexión con el servidor' });
  const lento = await servidor(() => { /* nunca responde */ });
  try {
    const t0 = Date.now();
    await assert.rejects(createApi({ baseUrl: lento.url, timeoutMs: 500 }).estado(), { status: 0, message: 'Sin conexión con el servidor' });
    assert.ok(Date.now() - t0 < 1500, 'el tiempo de espera debe cortar la petición');
  } finally { lento.close(); }
});

test('RE-01 / CP-18: respuestas 401 y 500 del servidor se distinguen al iniciar sesión', async () => {
  const srv = await servidor((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const { pin } = JSON.parse(b || '{}');
      if (pin === '0000') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: 'abc', usuario: { id: 2, nombre: 'Juan Pérez', rol: 'usuario' } })); }
      else if (pin === '5000') { res.writeHead(500); res.end(); }
      else { res.writeHead(401); res.end(); }
    });
  });
  try {
    const remota = createApi({ baseUrl: srv.url });
    await assert.rejects(remota.login('9999'), { status: 401, message: 'Credenciales inválidas' });
    await assert.rejects(remota.login('5000'), { status: 500, message: 'HTTP 500' });
    assert.equal((await remota.login('0000')).usuario.nombre, 'Juan Pérez');
  } finally { srv.close(); }
});

test('RE-01 / CP-19: sin red durante el envío, las lecturas siguen pendientes para el siguiente intento', async () => {
  await limpiarDb();
  await auth.login('0000');
  await measurementsDao.insertar(lectura(2));
  const original = api.enviarMedicion;
  api.enviarMedicion = async () => { throw new ApiError('Sin conexión con el servidor', 0); };
  try {
    await assert.rejects(enviarPendientes(), { message: 'Sin conexión con el servidor' });
    const [m] = await measurementsDao.obtenerTodos();
    assert.equal(m.synced, false);
    assert.equal(m.error, null);                                       // no se pierde ni se marca rechazada
  } finally { api.enviarMedicion = original; }
  assert.equal((await enviarPendientes()).enviadas, 1);               // al volver la red se envía
  salir(); await limpiarDb();
});

test('RE-02 / CP-20: 401 durante el envío cierra la sesión y avisa en el login', async () => {
  await limpiarDb();
  await auth.login('0000');
  await measurementsDao.insertar(lectura(2));
  const original = api.enviarMedicion;
  api.enviarMedicion = async () => { throw new ApiError('HTTP 401', 401); };
  try {
    await assert.rejects(enviarPendientes(), { status: 401 });
    assert.equal(auth.isAuthenticated(), false);
    assert.equal(location.hash, '/login');
    assert.equal(auth.consumeExpiredFlag(), true);                     // el login mostrará "Tu sesión expiró"
    assert.equal(auth.consumeExpiredFlag(), false);                    // y solo una vez
    assert.equal((await measurementsDao.obtenerTodos())[0].synced, false);
  } finally { api.enviarMedicion = original; salir(); await limpiarDb(); }
});

// ---------- Requisito del wearable real ----------

test('RF-03 / CP-21: una lectura con los datos que entrega un wearable BLE estándar debe poder enviarse', () => {
  // El wearable BLE publica FC (0x180D), batería (0x180F) y temperatura (0x1809); no existe servicio de SpO2.
  const ble = createMeasurement({ userId: 2, wearable: { heartRate: 80, battery: 90, temperature: 36.6 } });
  assert.deepEqual(validateMedicionRequest(toMedicionRequest(ble)), []);
});
