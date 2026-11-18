// Clasifica la actividad con la variación de la magnitud del acelerómetro en una ventana de tiempo.
// Quieto: la magnitud casi no cambia (solo gravedad). Caminar y correr la hacen oscilar cada vez más.
export const UMBRAL_CAMINANDO = 0.6;   // desviación estándar en m/s²
export const UMBRAL_CORRIENDO = 3.5;

export function classify(std) {
  if (std < UMBRAL_CAMINANDO) return 'reposo';
  if (std < UMBRAL_CORRIENDO) return 'caminando';
  return 'corriendo';
}

export function createActivityClassifier({ windowMs = 2000, minSamples = 10 } = {}) {
  const samples = [];   // { t, mag }
  let current = 'reposo';
  return {
    push(x, y, z, t = performance.now()) {
      samples.push({ t, mag: Math.hypot(x, y, z) });
      while (samples.length && t - samples[0].t > windowMs) samples.shift();
      if (samples.length >= minSamples) {
        const mean = samples.reduce((a, s) => a + s.mag, 0) / samples.length;
        const std = Math.sqrt(samples.reduce((a, s) => a + (s.mag - mean) ** 2, 0) / samples.length);
        current = classify(std);
      }
      return current;
    },
    get current() { return current; },
    reset() { samples.length = 0; current = 'reposo'; }
  };
}
