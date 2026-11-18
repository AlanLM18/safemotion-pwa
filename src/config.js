// URL preasignada del backend. Se separa de la lógica (Práctica 3).
// Ejemplo: VITE_API_URL=http://localhost:8080  (las rutas ya incluyen /api)
const env = import.meta.env ?? {};
export const API_BASE_URL = (env.VITE_API_URL ?? '').replace(/\/$/, '');
// Firebase (Prácticas 9 y 10): con su configuración, la app guarda y lee todo de Cloud Firestore (base compartida
// por los teléfonos de pacientes, recepción y doctores) y la sesión es con correo y contraseña.
// Sin Firebase se usa Spring Boot (VITE_API_URL) o, sin URL, el modo simulado.
export const FIREBASE = env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID
  ? { apiKey: env.VITE_FIREBASE_API_KEY, projectId: env.VITE_FIREBASE_PROJECT_ID, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com` }
  : null;
// Solo para pruebas: conecta la app al emulador local de Firebase en vez del proyecto real.
export const FIREBASE_EMULADOR = env.VITE_FIREBASE_EMULADOR
  ? { auth: env.VITE_FIREBASE_EMULADOR_AUTH ?? '127.0.0.1:9099', firestore: env.VITE_FIREBASE_EMULADOR_FIRESTORE ?? '127.0.0.1:8085' } : null;
export const MOCK = !FIREBASE && API_BASE_URL === '';       // sin Firebase ni URL => modo simulado
export const API_TIMEOUT_MS = 8000;
export const SESSION_HOURS = 8;                // el backend no expira tokens; la app cierra la sesión local
export const MONITOR_INTERVAL_MS = 5000;       // igual que el wearable Flutter
export const MSG = {
  loading: 'Consultando...',
  error: 'No fue posible obtener la información.',
  auth: 'Datos de acceso no válidos.',        // mensaje genérico (Práctica 5)
  expired: 'Tu sesión expiró. Inicia sesión de nuevo.'
};
