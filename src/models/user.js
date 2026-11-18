// Usuario de sesión, tal como lo devuelve POST /api/auth/login de Spring Boot (o el login con Firebase).
export const createUser = ({ id, nombre, rol }) => ({ id, nombre, rol });

export const ACTIVITIES = ['reposo', 'caminando', 'corriendo'];
export const ALERT_LEVELS = ['info', 'aviso', 'critica'];

// Con Firebase, el PIN de 4 dígitos sigue siendo lo único que escribe el usuario: se traduce a su cuenta de
// Firebase Authentication. El mismo esquema lo usan la PWA, el dashboard (web-dashboard) y el reloj
// (wearable_widget), así los tres entran con el mismo PIN a la misma cuenta y comparten los datos.
export const DOMINIO_PIN = 'pin.safemotion.app';
export const credencialesDePin = (pin) => ({ correo: `${pin}@${DOMINIO_PIN}`, password: `SafeMotion-${pin}` });
