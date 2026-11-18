#!/usr/bin/env bash
# Prácticas 13 y 14 · Lo ejecuta "firebase emulators:exec" (que ya exportó FIRESTORE_EMULATOR_HOST y FIREBASE_AUTH_EMULATOR_HOST):
# arranca el backend Spring (BACKEND_JAR) conectado al emulador, espera a que responda y corre las pruebas de integración.
set -euo pipefail
: "${BACKEND_JAR:?Falta BACKEND_JAR (ruta de safemotion-backend.jar)}"
export API_URL="${API_URL:-http://localhost:8080}"
FIREBASE_PROJECT_ID="${GCLOUD_PROJECT:-demo-safemotion}" java -jar "$BACKEND_JAR" > backend-ci.log 2>&1 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if curl -fs "$API_URL/api/sistema/estado" > /dev/null; then echo "Backend listo en ${i}s"; break; fi
  if ! kill -0 $BACKEND_PID 2>/dev/null; then echo "El backend terminó al arrancar"; cat backend-ci.log; exit 1; fi
  sleep 1
done
curl -fs "$API_URL/api/sistema/estado" > /dev/null || { echo "El backend no respondió en 90 s"; tail -50 backend-ci.log; exit 1; }
node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=resultados-integracion.xml --test-reporter=./tests/aut/reporte-github.mjs --test-reporter-destination=stdout tests/aut/integracion.test.js
