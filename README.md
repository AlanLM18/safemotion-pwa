# SafeMotion AI – PWA

[![CI SafeMotion PWA](https://github.com/AlanLM18/safemotion-pwa/actions/workflows/ci.yml/badge.svg)](https://github.com/AlanLM18/safemotion-pwa/actions/workflows/ci.yml)

PWA (Node + Vite) que reemplaza la app Flutter de la propuesta: se instala desde el navegador, sin APK.
Publicada en https://safemotion-pwa.vercel.app

## Ejecutar
```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:https    # para probar BLE y sensores desde el teléfono (misma red Wi-Fi)
npm run build && npm run preview
```

## Dónde se guardan los datos
- **Firebase (por defecto, y en Vercel):** con `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID` y `VITE_FIREBASE_AUTH_DOMAIN` en `.env` (y en las variables de Vercel) la app guarda y lee todo de **Cloud Firestore** del proyecto `mesaayuda-a631d`: usuarios y roles, mediciones, chat y SOS. Se entra con el **PIN de 4 dígitos**, que la app traduce a la cuenta de Firebase Authentication (el mismo esquema que el reloj y el dashboard, así los tres comparten usuarios y datos). Cualquier teléfono con la app publicada usa la misma base.
- **API Spring Boot (sobre los mismos datos de Firebase):** sin las variables de Firebase y con `VITE_API_URL` la app usa la API REST de `safemotion-ai/backend`, que guarda en el mismo Firestore con el Firebase Admin SDK. Publicada, la API vive en `https://safemotion-pwa.vercel.app/api/**` (`vercel.json` la reenvía al backend en Render). Ver `safemotion-ai/README.md`.
- **Modo simulado:** sin Firebase ni URL. Responde igual que la base, pero solo en ese navegador; es para desarrollar y para las pruebas automáticas. PIN: `0000` o `1111` (pacientes), `3333` (recepción), `2222` (doctor), `1234` (admin).

## Roles
| Rol | Pantallas | Qué hace |
|---|---|---|
| Paciente (`usuario`) | Inicio, Wearable, Historial, Doctor, Cuenta | Conecta el wearable, guarda y envía lecturas, habla con su doctor y pide SOS |
| Recepción (`recepcionista`) | Recepción, Cuenta | Recibe primero los SOS y los canaliza con un doctor. No ve mediciones ni chat |
| Doctor (`doctor`) | Consultas, Cuenta | Ve pacientes, su última medición y su chat; atiende los SOS que recepción le canalizó |
| Administrador (`admin`) | Todas | Supervisa |

Las cuentas y su rol las crea el administrador del proyecto (la app no tiene registro): `node tests/support/sembrarFirebase.mjs` crea las cuentas de prueba. PIN: `0000` y `1111` pacientes · `3333` recepción · `2222` y `4444` doctores · `1234` admin. Desde el dashboard, el admin puede deshabilitar una cuenta; una cuenta deshabilitada no puede entrar ni operar.

## Wearable y pasos
En **Wearable**, “Usar wearable simulado” enciende el simulador (frecuencia cardiaca, SpO₂, temperatura, batería) **y los sensores del teléfono**: los pasos y las calorías salen del acelerómetro, y se muestran la actividad detectada y el giroscopio. Ahí mismo se guarda la lectura; en **Historial** se envía a la base (sin red queda pendiente y se reintenta).

## SOS
Paciente pide SOS (Doctor o Inicio) → **Recepción** lo recibe y lo canaliza con un doctor → el **doctor** lo marca como atendido. Cada paso llega a los demás dispositivos y deja un aviso en el chat del paciente. Si hace falta, el doctor pide una **ambulancia** desde el chat (botón 🚑): al paciente le llega el aviso "AMBULANCIA EN CAMINO" con el destino y el tiempo estimado (simulación: no se avisa a ningún servicio real). Si dos recepcionistas canalizan el mismo SOS al mismo tiempo, gana una y la otra ve con quién quedó. Sin red, el SOS no se confirma y la app ofrece llamar al 911.

## Reglas de Firestore
`firestore.rules`: el bloque `reportes` (app Android MesaAyuda) va sin cambios; el resto aplica los permisos de la tabla de roles (cada paciente solo lo suyo, nadie se cambia el rol ni el dueño de un dato, nadie borra un SOS). Publicar: `npx firebase-tools@14 deploy --only firestore:rules --project mesaayuda-a631d`.

## Pruebas
```bash
npm test                                         # 37 pruebas unitarias (sin hardware ni servidor)
npm run test:blackbox                            # Práctica 8: 21 casos de caja negra sobre los módulos
npm run test:e2e                                 # Práctica 8: 20 casos en Edge con capturas en docs/practica8/evidencias
npm run test:sync && npm run test:sync:int       # evaluación de pruebas: sincronización de mediciones
npm run test:firebase                            # Prácticas 9 y 10: reglas y flujo por rol en el emulador de Firebase
npm run test:e2e:firebase                        # Prácticas 9 y 10: 4 dispositivos Android emulados (emulador de Firebase)
FIREBASE_REAL=1 npm run test:firebase:real       # lo mismo contra el proyecto real (cuentas de .env.pruebas)
FIREBASE_REAL=1 npm run test:e2e:firebase:real
# Práctica 11 (White Box): backend Spring sobre el emulador de Firebase (ver safemotion-ai/README.md para levantarlo)
npm run test:wb:cov                              # 48 pruebas White Box de la app con cobertura
API_URL=http://localhost:8080 npm run test:wb:api   # 37 casos de endpoints · test:wb:db (Firestore) · wb.interop.mjs (app ↔ backend)
# npm run test:api corresponde al backend anterior con MySQL (IDs numéricos); quedó reemplazado por test:wb:api
```
El emulador de Firebase necesita Java 11 o superior antes que Java 8 en el `PATH`.
`.env.pruebas` (contraseñas de las cuentas de prueba) no se sube a git ni a Vercel.

## Pruebas automatizadas e integración continua (Prácticas 13 y 14)
GitHub Actions (`.github/workflows/ci.yml`) corre en cada `push` y en cada `pull_request`:

1. **Lint + pruebas unitarias + build**: `npm run lint` (ESLint, los errores detienen el pipeline), 126 pruebas unitarias
   (incluye `tests/aut/unitarias.test.js`: login con PIN, bloqueo, excepciones y regresiones WB-D10/WB-D11) y `npm run build`.
2. **Integración** (solo si el paso 1 pasa): compila el backend Spring desde
   [Backend-Spring-sobre-Firebase](https://github.com/AlanLM18/Backend-Spring-sobre-Firebase), levanta el emulador de Firebase
   y corre `tests/aut/integracion.test.js` (app ↔ API ↔ Firestore, servidor que no responde y persistencia).

Cada prueba fallida aparece como anotación del run (archivo, línea y mensaje) y los resultados JUnit quedan como artefactos.
```bash
npm run lint && npm run test:ci                  # lo mismo que el primer job
BACKEND_JAR=../safemotion-ai/backend/target/safemotion-backend.jar npm run test:aut:int:emulador   # el segundo job
```
## Estructura
- `src/models` medición unificada (+ conversión a `MedicionRequest`), usuario, alertas, chat, emergencia (estados del SOS)
- `src/services` api (Spring Boot / simulado) y apiFirebase, auth, sync, monitor, db (IndexedDB), ble + gattParser, gyro + steps + activity, wearableSim, store
- `src/screens` login, inicio, dispositivo (wearable + sensores), historial, doctor, recepcion, consultas, chat, sos, cuenta · `src/router.js` navegación por rol + guardia de sesión
- `tests/` pruebas unitarias, de integración y E2E (`node --test`, Puppeteer + Edge)
