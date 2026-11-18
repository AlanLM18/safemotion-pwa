export function createStepCounter({ threshold = 1.2, minInterval = 300 } = {}) {
  let g = 9.81, s = 0, armed = true, last = 0, steps = 0, prevT = null;
  return {
    push(x, y, z, t = performance.now()) {
      const mag = Math.hypot(x, y, z);
      const dt = prevT == null ? 0.02 : Math.min((t - prevT) / 1000, 0.2);
      prevT = t;
      g += (dt / (1 + dt)) * (mag - g);              // gravedad
      s += (dt / (0.08 + dt)) * ((mag - g) - s);     // movimiento suavizado
      if (armed && s > threshold && t - last > minInterval) { steps++; last = t; armed = false; return true; }
      if (!armed && s < threshold * 0.4) armed = true;
      return false;
    },
    get count() { return steps; },
    reset() { steps = 0; }
  };
}