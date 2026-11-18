// Integración con Spring Boot: chat médico y SOS con 4 sesiones a la vez (admin, doctor y 2 pacientes).
// Matriz TC01-TC08 de la Práctica 7 adaptada a los casos de atención. Ejecutar con el backend encendido:
//   API_URL=http://localhost:8080 npm run test:api
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/services/api.js';

const API_URL = process.env.API_URL;
const opts = { skip: !API_URL && 'Define API_URL para probar contra Spring Boot' };
const api = createApi({ baseUrl: API_URL ?? '' });
let admin, dra, juan, maria;

before(async () => {
  if (!API_URL) return;
  [admin, dra, juan, maria] = await Promise.all(['1234', '2222', '0000', '1111'].map((pin) => api.login(pin)));
  // Estado inicial conocido: sin emergencias abiertas y chats vacíos.
  for (const e of await api.emergencias(dra.token)) if (e.estado === 'ABIERTA') await api.atenderEmergencia(e.id, dra.token);
  for (const p of [juan, maria]) await api.limpiarChat(p.usuario.id, dra.token);
});

test('R-01: cuatro dispositivos con sesión propia y su rol', opts, () => {
  assert.deepEqual([admin, dra, juan, maria].map((s) => s.usuario.rol), ['admin', 'doctor', 'usuario', 'usuario']);
  assert.equal(new Set([admin, dra, juan, maria].map((s) => s.token)).size, 4);
});

test('R-02: mensajes entre el paciente y el doctor (dos dispositivos)', opts, async () => {
  await api.enviarMensaje(juan.usuario.id, 'Tengo la frecuencia alta, ¿qué hago?', juan.token);
  const vistoPorDoctor = await api.mensajes(juan.usuario.id, dra.token);
  assert.equal(vistoPorDoctor.at(-1).autor, 'Juan Pérez');
  await api.enviarMensaje(juan.usuario.id, 'Siéntate y respira lento. Voy a revisar tus signos.', dra.token);
  const vistoPorPaciente = await api.mensajes(juan.usuario.id, juan.token);
  assert.deepEqual(vistoPorPaciente.map((m) => m.rol), ['usuario', 'doctor']);
  assert.ok(vistoPorPaciente.every((m) => m.fecha));                    // cada mensaje tiene hora de envío
  assert.equal(vistoPorPaciente[0].pin, undefined);                     // no se expone el PIN del autor
});

test('R-03: el paciente no ve la bandeja ni el chat de otro paciente', opts, async () => {
  await assert.rejects(api.conversaciones(juan.token), { status: 403 });
  await assert.rejects(api.mensajes(maria.usuario.id, juan.token), { status: 403 });
  await assert.rejects(api.enviarMensaje(maria.usuario.id, 'hola', juan.token), { status: 403 });
});

test('R-04: el administrador supervisa todas las conversaciones', opts, async () => {
  const bandeja = await api.conversaciones(admin.token);
  assert.ok(bandeja.some((c) => c.paciente === 'Juan Pérez' && c.mensajes === 2));
  assert.ok(bandeja.some((c) => c.paciente === 'María López'));
});

test('TC01 alta válida: el paciente pide SOS y el doctor lo puede consultar', opts, async () => {
  const e = await api.crearEmergencia({ latitud: 20.5888, longitud: -100.3899, frecuenciaCardiaca: 124, spo2: 90, temperatura: 38.2 }, maria.token);
  assert.equal(e.duplicada, false);
  assert.equal(e.estado, 'ABIERTA');
  const bandeja = await api.conversaciones(dra.token);
  assert.equal(bandeja[0].paciente, 'María López');                     // con SOS abierto va primero
  assert.equal(bandeja[0].emergenciaAbierta.frecuenciaCardiaca, 124);
  assert.match((await api.mensajes(maria.usuario.id, maria.token)).at(-1).texto, /^SOS: .*FC 124 bpm.*Ubicación: 20.5888/);
});

test('TC02 campos inválidos: mensaje vacío y coordenadas fuera de rango se rechazan', opts, async () => {
  await assert.rejects(api.enviarMensaje(juan.usuario.id, '   ', juan.token), { status: 400 });
  await assert.rejects(api.enviarMensaje(juan.usuario.id, 'x'.repeat(501), juan.token), { status: 400 });
  await assert.rejects(api.crearEmergencia({ latitud: 200 }, juan.token), { status: 400 });
});

test('TC03 identificador repetido: un segundo SOS no crea otra emergencia', opts, async () => {
  const antes = (await api.emergencias(dra.token)).length;
  const e = await api.crearEmergencia({}, maria.token);
  assert.equal(e.duplicada, true);
  assert.equal((await api.emergencias(dra.token)).length, antes);
});

test('TC04 actualización: el doctor atiende el SOS y el cambio se conserva', opts, async () => {
  const [abierta] = (await api.emergencias(dra.token)).filter((e) => e.estado === 'ABIERTA');
  await assert.rejects(api.atenderEmergencia(abierta.id, maria.token), { status: 403 });   // el paciente no puede
  await api.atenderEmergencia(abierta.id, dra.token);
  const [ultima] = await api.emergencias(maria.token);                                     // consultado por el paciente
  assert.equal(ultima.estado, 'ATENDIDA');
  assert.equal(ultima.atendidaPor, 'Dra. Ana Torres');
  assert.match((await api.mensajes(maria.usuario.id, maria.token)).at(-1).texto, /atendida por Dra. Ana Torres/);
});

test('TC05 eliminación: limpiar el historial deja la conversación vacía', opts, async () => {
  await api.limpiarChat(maria.usuario.id, maria.token);
  assert.deepEqual(await api.mensajes(maria.usuario.id, dra.token), []);
});

test('TC06 inexistente: conversación y emergencia que no existen responden 404', opts, async () => {
  await assert.rejects(api.mensajes(999, dra.token), { status: 404 });
  await assert.rejects(api.atenderEmergencia(999999, dra.token), { status: 404 });
  await assert.rejects(api.mensajes(dra.usuario.id, dra.token), { status: 404 });          // el doctor no es paciente
});

test('TC07 pérdida de conexión: enviar sin servidor da un error controlado', opts, async () => {
  const caida = createApi({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
  await assert.rejects(caida.enviarMensaje(juan.usuario.id, 'hola', juan.token), { status: 0, message: 'Sin conexión con el servidor' });
});

test('TC08 persistencia: los mensajes siguen ahí con una sesión nueva', opts, async () => {
  await api.logout(juan.token);
  await assert.rejects(api.mensajes(juan.usuario.id, juan.token), { status: 401 });
  const nueva = await api.login('0000');
  const ms = await api.mensajes(nueva.usuario.id, nueva.token);
  assert.deepEqual(ms.map((m) => m.autor), ['Juan Pérez', 'Dra. Ana Torres']);
});

test('R-06: ninguna respuesta expone el PIN del usuario', opts, async () => {
  const s = await api.login('1111');
  const m = await api.enviarMedicion({ frecuenciaCardiaca: 80, temperatura: 36.6, spo2: 97, pasos: 1, calorias: 0, actividad: 'reposo', bateria: 90 }, s.token);
  const [h] = await api.historial(s.token, 1);
  assert.equal(m.usuario.pin, undefined);
  assert.equal(h.usuario.pin, undefined);
});

test('R-05: el doctor y el admin no pueden pedir SOS (solo pacientes)', opts, async () => {
  await assert.rejects(api.crearEmergencia({}, dra.token), { status: 403 });
  await assert.rejects(api.crearEmergencia({}, admin.token), { status: 403 });
});
