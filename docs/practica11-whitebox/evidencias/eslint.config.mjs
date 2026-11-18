// Configuración de análisis estático para la Práctica 11 (no forma parte del proyecto).
const g = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: g(['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'indexedDB', 'fetch',
        'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'crypto', 'performance',
        'globalThis', 'URL', 'DataView', 'Uint8Array', 'Event', 'CustomEvent', 'HTMLElement', 'DeviceMotionEvent',
        'DeviceOrientationEvent', 'Notification', 'Audio', 'alert', 'confirm', 'requestAnimationFrame', 'addEventListener',
        'Gyroscope', 'Accelerometer', 'TextDecoder', 'structuredClone', 'queueMicrotask', 'getComputedStyle', 'history', 'screen'])
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-async-promise-executor': 'error',
      'no-constant-condition': 'warn',
      'no-self-compare': 'error',
      'no-unsafe-finally': 'error',
      'no-fallthrough': 'error',
      'no-implied-eval': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      eqeqeq: ['warn', 'smart'],
      'require-await': 'warn',
      'no-promise-executor-return': 'warn',
      'no-await-in-loop': 'warn',
      complexity: ['warn', 8],
      'max-depth': ['warn', 3],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }]
    }
  }
];
