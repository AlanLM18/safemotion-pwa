// Análisis estático de SafeMotion PWA (Prácticas 13 y 14: lo ejecuta GitHub Actions en cada push y pull request).
// Las reglas en "error" detienen el pipeline; las de "warn" se reportan sin detenerlo (deuda técnica medida en P11).
const g = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));
const NAVEGADOR = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'indexedDB', 'fetch',
  'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'crypto', 'performance',
  'globalThis', 'URL', 'URLSearchParams', 'DataView', 'Uint8Array', 'Event', 'CustomEvent', 'HTMLElement', 'DeviceMotionEvent',
  'DeviceOrientationEvent', 'Notification', 'Audio', 'alert', 'confirm', 'requestAnimationFrame', 'addEventListener',
  'Gyroscope', 'Accelerometer', 'TextDecoder', 'TextEncoder', 'structuredClone', 'queueMicrotask', 'getComputedStyle', 'history', 'screen',
  'Response', 'Request', 'Headers', 'Blob', 'FormData', 'atob', 'btoa'];
const REGLAS = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-async-promise-executor': 'error',
  'no-self-compare': 'error',
  'no-unsafe-finally': 'error',
  'no-fallthrough': 'error',
  'no-implied-eval': 'error',
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-unused-vars': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  eqeqeq: ['warn', 'smart'],
  'require-await': 'warn',
  complexity: ['warn', 8],
  'max-depth': ['warn', 3]
};
export default [
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'docs/**', 'public/**'] },
  { files: ['src/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: g(NAVEGADOR) }, rules: REGLAS },
  { files: ['tests/aut/**/*.js', 'eslint.config.mjs', 'vite.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: g([...NAVEGADOR, 'process']) }, rules: REGLAS }
];
