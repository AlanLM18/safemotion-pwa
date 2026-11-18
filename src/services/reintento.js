// Reintento controlado con espera progresiva (exponential backoff con jitter) para la sincronización automática.
// Práctica 12: antes el monitoreo reintentaba cada 5 s sin importar cuántas veces hubiera fallado, así que durante una
// caída larga el teléfono golpeaba al servidor sin parar. Ahora, tras cada fallo de red o de servidor, la espera se
// duplica (5 s, 10 s, 20 s, 30 s como tope) con una variación aleatoria de ±20 % para que muchos teléfonos no
// reintenten al mismo tiempo. Un éxito, o el evento "online" del navegador, reinicia la espera.
// La idempotencia la garantiza el idLocal de cada lectura (el servidor lo usa como ID del documento).
export const BASE_MS = 5000;
export const MAX_MS = 30000;
export const JITTER = 0.2;

/** Espera para el fallo número n (1, 2, 3…), sin jitter. */
export const esperaBase = (n, base = BASE_MS, max = MAX_MS) => (n <= 0 ? 0 : Math.min(max, base * 2 ** (n - 1)));

/** ¿Vale la pena reintentar? Sin red (0), servidor caído o sobrecargado (5xx) o demasiadas solicitudes (429). */
export const esReintentable = (e) => !e || e.status == null || e.status === 0 || e.status === 429 || e.status >= 500;

export function crearReintento({ base = BASE_MS, max = MAX_MS, jitter = JITTER, ahora = () => Date.now(), aleatorio = Math.random } = {}) {
  let fallos = 0, proximo = 0;
  return {
    puedeIntentar: () => ahora() >= proximo,
    registrarFallo() {
      fallos++;
      const espera = esperaBase(fallos, base, max) * (1 + (aleatorio() * 2 - 1) * jitter);
      proximo = ahora() + Math.round(espera);
      return Math.round(espera);
    },
    registrarExito() { fallos = 0; proximo = 0; },
    reiniciar() { fallos = 0; proximo = 0; },
    get fallos() { return fallos; },
    get esperaRestanteMs() { return Math.max(0, proximo - ahora()); }
  };
}
