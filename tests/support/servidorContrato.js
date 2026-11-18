// Servidor HTTP de pruebas con el contrato de Spring Boot (AuthController, MedicionController y CorsConfig
// de safemotion-ai/backend). Sustituye al backend cuando no se puede levantar (requiere Java 17 + Maven).
// Igual que Jackson con los campos primitivos de MedicionRequest.java, un null se recibe como 0.
import http from 'node:http';

const USUARIOS = {
  '1234': { id: 1, nombre: 'Administrador', rol: 'admin' },
  '0000': { id: 2, nombre: 'Juan Pérez', rol: 'usuario' },
  '2222': { id: 3, nombre: 'Dra. Ana Torres', rol: 'doctor' },
  '1111': { id: 4, nombre: 'María López', rol: 'usuario' }
};
// @Min/@Max/@DecimalMin/@DecimalMax de MedicionRequest.java
const LIMITES = { frecuenciaCardiaca: [30, 220], temperatura: [30, 43], spo2: [0, 100], bateria: [0, 100], pasos: [0, Infinity], calorias: [0, Infinity] };
const valido = (b) => Object.entries(LIMITES).every(([c, [min, max]]) => (b[c] ?? 0) >= min && (b[c] ?? 0) <= max)
  && typeof b.actividad === 'string' && b.actividad.trim() !== '';

export async function iniciarServidorContrato({ port = 0 } = {}) {
  const sesiones = new Map();     // token -> usuario
  const mediciones = [];          // lo que el servidor "persistió"
  const peticiones = [];          // registro de cada llamada (método, ruta, Authorization, cuerpo)
  const fallas = [];              // fallas programadas para POST /api/mediciones, una por petición

  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const token = req.headers.authorization;
      peticiones.push({ method: req.method, path: url.pathname, auth: token ?? null, body });
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      const usuario = sesiones.get(token);
      const ruta = `${req.method} ${url.pathname}`;

      if (ruta === 'POST /api/auth/login') {
        const u = USUARIOS[body?.pin];
        if (!u) return json(401, { mensaje: 'PIN incorrecto' });
        const t = `tok-${u.id}-${Math.random().toString(36).slice(2)}`;
        sesiones.set(t, u);
        return json(200, { token: t, usuario: u });
      }
      if (ruta === 'POST /api/auth/logout') { sesiones.delete(token); res.writeHead(204); return res.end(); }
      if (ruta === 'GET /api/sistema/estado') {
        return json(200, { usuariosConectados: sesiones.size, usuariosRegistrados: 4, wearablesActivos: mediciones.length ? 1 : 0, alertasTotales: 0, tareas: [] });
      }
      if (ruta === 'POST /api/mediciones') {
        const falla = fallas.shift();
        if (falla?.colgar) return;                                         // nunca responde
        if (falla?.status) return json(falla.status);
        if (!usuario) return json(401, { mensaje: 'Sesión inválida o expirada.' });
        if (!valido(body)) return json(400);
        const m = { id: mediciones.length + 1, ...body, fecha: new Date().toISOString(), usuario };
        mediciones.push(m);
        if (falla?.perderRespuesta) return;                                // guarda, pero la respuesta no llega
        return json(200, m);
      }
      if (ruta === 'GET /api/mediciones/historial') {
        if (!usuario) return json(401);
        const limite = Number(url.searchParams.get('limite') ?? 20);
        return json(200, mediciones.filter((m) => m.usuario.id === usuario.id).reverse().slice(0, limite));
      }
      return json(404);
    });
  });

  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    mediciones,
    peticiones,
    fallar: (...f) => fallas.push(...f),
    reiniciarSesiones: () => sesiones.clear(),                          // como un reinicio de Spring Boot
    limpiar: () => { mediciones.length = 0; peticiones.length = 0; fallas.length = 0; },
    cerrar: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); })
  };
}
