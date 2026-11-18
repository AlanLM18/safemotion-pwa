// Avisos visuales breves (Práctica 6: notificación visual al enviar). Se anuncian a lectores de pantalla.
let caja = null;
const MAX_VISIBLES = 2;

export function toast(texto, { tipo = 'info', accion = null, ms = 3500 } = {}) {
  if (typeof document === 'undefined') return;
  if (!caja) {
    caja = document.body.appendChild(document.createElement('div'));
    caja.className = 'toasts';
    caja.setAttribute('role', 'status');
    caja.setAttribute('aria-live', 'polite');
  }
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.append(document.createTextNode(texto));
  if (accion) {
    const a = document.createElement('a');
    a.href = accion.href; a.textContent = accion.texto; a.className = 'toast-accion';
    t.append(a);
  }
  caja.append(t);
  while (caja.children.length > MAX_VISIBLES) caja.firstElementChild.remove();   // no se apilan
  setTimeout(() => t.remove(), ms);
}
