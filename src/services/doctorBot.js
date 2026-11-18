// Asistente del modo simulado (sin backend): responde mientras no hay un médico real conectado.
// Solo da medidas generales y deriva a SOS/911 ante señales de urgencia. NUNCA indica medicamentos:
// eso solo puede hacerlo el médico real, que en modo backend contesta desde su propio dispositivo.
export const ASISTENTE = 'Asistente médico (simulado)';

const URGENTE = /dolor (en el|de) pecho|no puedo respirar|falta de aire|me desmay|desmayo|convuls|labios morados|confusi[oó]n/i;
const MEDICAMENTO = /medicamento|medicina|pastilla|tomar|tomo|paracetamol|ibuprofeno|aspirina|dosis/i;

const GUIAS = [
  [/frecuencia cardiaca alta/i, 'Para la frecuencia cardiaca alta: siéntate en un lugar tranquilo, respira lento (inhala 4 s, exhala 6 s), evita cafeína y esfuerzo, y vuelve a revisar en 5 minutos.'],
  [/frecuencia cardiaca baja/i, 'Para la frecuencia cardiaca baja: recuéstate con las piernas un poco elevadas y no te levantes de golpe.'],
  [/temperatura elevada/i, 'Para la temperatura elevada: toma agua, usa ropa ligera y ponte paños húmedos en la frente.'],
  [/saturaci[oó]n de ox[ií]geno baja/i, 'Para la saturación baja: siéntate derecho, respira profundo y lento, y revisa que el sensor esté bien colocado.']
];

const AVISO_URGENCIA = 'Si tienes dolor en el pecho, falta de aire, desmayo o confusión, presiona SOS o llama al 911.';

export function respuestaAsistente(texto) {
  if (/^SOS:/.test(texto)) {
    return 'Recibí tu solicitud de ayuda (modo simulado: no se avisa a ningún servicio real). Si es una emergencia real, llama al 911 ahora. No te quedes solo y no conduzcas.';
  }
  if (URGENTE.test(texto)) {
    return `Eso puede ser una emergencia. Presiona SOS o llama al 911 ahora. ${AVISO_URGENCIA}`;
  }
  if (MEDICAMENTO.test(texto)) {
    return 'No puedo indicarte medicamentos: eso solo lo hace un médico que revise tu caso. Si tu médico ya te dio un tratamiento para esto, síguelo; no te automediques. ' + AVISO_URGENCIA;
  }
  const guias = GUIAS.filter(([re]) => re.test(texto)).map(([, g]) => g);
  if (guias.length) return `${guias.join(' ')} ${AVISO_URGENCIA}`;
  return `Gracias, recibí tu mensaje. ¿Desde cuándo te sientes así? ${AVISO_URGENCIA}`;
}
