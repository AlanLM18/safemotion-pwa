// Vigila los signos del wearable en cualquier pantalla: cuando aparece una alerta nueva,
// muestra un aviso con acceso directo al chat del médico y hace vibrar el teléfono.
import { subscribe } from './store.js';
import { evaluarAlertas } from '../models/alerts.js';
import { toast } from './toast.js';

const REAVISO_MS = 60_000;   // un mismo tipo de alerta se avisa como máximo una vez por minuto
let off = null, previas = new Set(), avisadas = new Map();

export function start() {
  if (off) return;
  off = subscribe((k, w) => {
    if (k !== 'wearable') return;
    const tipos = evaluarAlertas(w.connected ? w : null).map((a) => a.tipo);
    const ahora = Date.now();
    // Solo lo que no estaba antes y no se avisó hace poco (los valores cerca del límite entran y salen).
    const nuevas = tipos.filter((t) => !previas.has(t) && !(ahora - (avisadas.get(t) ?? 0) < REAVISO_MS));
    previas = new Set(tipos);
    if (!nuevas.length || location.hash.startsWith('#/doctor')) return;   // ya está en el chat con el médico
    nuevas.forEach((t) => avisadas.set(t, ahora));
    toast(nuevas.join(' · '), { tipo: 'alerta', ms: 8000, accion: { texto: 'Hablar con un doctor', href: '#/doctor?alerta=1' } });
    navigator.vibrate?.([200, 100, 200]);
  });
}

export function stop() {
  off?.(); off = null; previas = new Set(); avisadas = new Map();
}
