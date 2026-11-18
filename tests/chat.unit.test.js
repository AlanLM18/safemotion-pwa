// Pruebas unitarias del chat médico y el SOS (base de la pirámide: rápidas, sin servidor ni navegador).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarMensaje, contarPorAutor, mensajeDeAlerta, datosEmergencia, MAX_MENSAJE } from '../src/models/chat.js';
import { respuestaAsistente } from '../src/services/doctorBot.js';
import { evaluarAlertas } from '../src/models/alerts.js';
import { createApi } from '../src/services/api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Chat: mensaje vacío o solo con espacios se rechaza', () => {
  assert.equal(validarMensaje('').ok, false);
  assert.equal(validarMensaje('   \n ').ok, false);
  assert.equal(validarMensaje(null).ok, false);
});

test('Chat: se recortan espacios y se respeta el límite de 500 caracteres', () => {
  assert.deepEqual(validarMensaje('  hola  '), { ok: true, texto: 'hola' });
  assert.equal(validarMensaje('a'.repeat(MAX_MENSAJE)).ok, true);
  assert.equal(validarMensaje('a'.repeat(MAX_MENSAJE + 1)).ok, false);
});

test('Chat: contador de mensajes por emisor', () => {
  const ms = [{ autor: 'Juan' }, { autor: 'Dra. Ana' }, { autor: 'Juan' }];
  assert.deepEqual(contarPorAutor(ms), [{ autor: 'Juan', total: 2 }, { autor: 'Dra. Ana', total: 1 }]);
});

test('Chat: el mensaje desde una alerta incluye qué está fuera de rango y los signos', () => {
  const w = { heartRate: 124, spo2: 90, temperature: 38.2 };
  const texto = mensajeDeAlerta(evaluarAlertas(w), w);
  assert.match(texto, /frecuencia cardiaca alta/);
  assert.match(texto, /FC 124 bpm, SpO2 90 %, temperatura 38.2 °C/);
});

test('SOS: los datos van vacíos si no hay wearable ni ubicación', () => {
  assert.deepEqual(datosEmergencia(null, null), { latitud: null, longitud: null, frecuenciaCardiaca: null, spo2: null, temperatura: null });
  assert.deepEqual(datosEmergencia({ heartRate: 120 }, { latitude: 20.59, longitude: -100.39 }).latitud, 20.59);
});

test('Asistente: nunca indica medicamentos', () => {
  for (const t of ['¿qué medicamento me tomo?', 'puedo tomar paracetamol', '¿cuántas pastillas?']) {
    const r = respuestaAsistente(t);
    assert.match(r, /No puedo indicarte medicamentos/);
    assert.doesNotMatch(r, /\d+\s*mg/);
  }
});

test('Asistente: ante señales de urgencia deriva a SOS o 911', () => {
  assert.match(respuestaAsistente('tengo dolor en el pecho'), /SOS o llama al 911 ahora/);
  assert.match(respuestaAsistente('SOS: solicito ayuda de emergencia.'), /modo simulado/);
});

test('Asistente: da una medida general según la alerta', () => {
  assert.match(respuestaAsistente('Tengo una alerta: temperatura elevada.'), /toma agua/);
});

test('API simulada: permisos del chat por rol', async () => {
  const api = createApi({ baseUrl: '' });
  const juan = await api.login('0000'), maria = await api.login('1111'), dra = await api.login('2222');
  await assert.rejects(api.conversaciones(juan.token), { status: 403 });             // el paciente no ve la bandeja
  await assert.rejects(api.mensajes(maria.usuario.id, juan.token), { status: 403 }); // ni el chat de otro paciente
  await assert.rejects(api.mensajes(999, dra.token), { status: 404 });               // conversación inexistente
  await assert.rejects(api.enviarMensaje(juan.usuario.id, '   ', juan.token), { status: 400 });
  assert.ok((await api.conversaciones(dra.token)).length >= 2);
});

test('API simulada: el asistente contesta al paciente y el doctor ve la conversación', async () => {
  const api = createApi({ baseUrl: '' });
  const juan = await api.login('0000'), dra = await api.login('2222');
  await api.enviarMensaje(juan.usuario.id, 'Tengo una alerta: frecuencia cardiaca alta.', juan.token);
  await sleep(1300);
  const ms = await api.mensajes(juan.usuario.id, dra.token);
  assert.equal(ms.at(-1).rol, 'asistente');
  await api.limpiarChat(juan.usuario.id, juan.token);
  assert.equal((await api.mensajes(juan.usuario.id, juan.token)).length, 0);
});

test('API simulada: SOS no se duplica, recepción lo canaliza y el doctor lo atiende', async () => {
  const api = createApi({ baseUrl: '' });
  const maria = await api.login('1111'), dra = await api.login('2222'), admin = await api.login('1234'), recepcion = await api.login('3333');
  await assert.rejects(api.crearEmergencia({}, admin.token), { status: 403 });        // solo pacientes piden SOS
  const e1 = await api.crearEmergencia({ frecuenciaCardiaca: 124 }, maria.token);
  const e2 = await api.crearEmergencia({}, maria.token);
  assert.equal(e1.duplicada, false);
  assert.equal(e2.duplicada, true);
  assert.equal(e2.id, e1.id);
  assert.equal(e1.estado, 'ABIERTA');
  await assert.rejects(api.atenderEmergencia(e1.id, dra.token), { status: 409 });      // primero lo recibe recepción
  await assert.rejects(api.canalizarEmergencia(e1.id, dra.usuario.id, maria.token), { status: 403 });
  await assert.rejects(api.mensajes(maria.usuario.id, recepcion.token), { status: 403 });   // recepción no lee el chat
  const [doctor] = await api.doctores(recepcion.token);
  const canalizada = await api.canalizarEmergencia(e1.id, doctor.id, recepcion.token);
  assert.deepEqual([canalizada.estado, canalizada.canalizadaANombre, canalizada.canalizadaPor], ['CANALIZADA', 'Dra. Ana Torres', 'Laura Gómez']);
  await assert.rejects(api.canalizarEmergencia(e1.id, doctor.id, recepcion.token), (e) => e.status === 409 && e.datos.actual.estado === 'CANALIZADA');
  await assert.rejects(api.atenderEmergencia(e1.id, recepcion.token), { status: 403 });
  const atendida = await api.atenderEmergencia(e1.id, dra.token);
  assert.equal(atendida.estado, 'ATENDIDA');
  assert.equal(atendida.atendidaPor, 'Dra. Ana Torres');
  assert.ok((await api.mensajes(maria.usuario.id, maria.token)).some((m) => m.texto.includes('canalizó tu solicitud')));
  assert.equal((await api.crearEmergencia({}, maria.token)).duplicada, false);       // después de atendida, se puede pedir otra
});

test('API simulada: la sesión sobrevive a recargar la página, pero no al logout', async () => {
  const api1 = createApi({ baseUrl: '' }), api2 = createApi({ baseUrl: '' });
  const { token, usuario } = await api1.login('0000');
  assert.ok(await api2.mensajes(usuario.id, token));                                   // otra instancia = recarga
  await api2.logout(token);
  await assert.rejects(api2.mensajes(usuario.id, token), { status: 401 });
});

test('Ambulancia: el doctor la pide desde el chat y el paciente recibe el aviso (simulación)', async () => {
  const { mensajeAmbulancia, esMensajeAmbulancia } = await import('../src/models/emergencia.js');
  const texto = mensajeAmbulancia('Dra. Ana Torres', { latitud: 20.5888, longitud: -100.3899 });
  assert.ok(esMensajeAmbulancia(texto));
  assert.match(texto, /20\.5888, -100\.3899/);
  assert.match(texto, /Simulación/);
  assert.ok(texto.length <= MAX_MENSAJE);
  assert.match(mensajeAmbulancia('Dr. Luis'), /domicilio registrado/);
  const api = createApi({ baseUrl: '' });
  const juan = await api.login('0000'), dra = await api.login('2222');
  await api.enviarMensaje(juan.usuario.id, texto, dra.token);
  assert.ok(esMensajeAmbulancia((await api.mensajes(juan.usuario.id, juan.token)).at(-1).texto));
});
