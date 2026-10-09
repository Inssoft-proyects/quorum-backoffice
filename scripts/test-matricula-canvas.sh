#!/usr/bin/env bash
# Ejemplo documentado del flujo de matrículas (BackOffice).
# NO ejecutar el sync contra producción sin leer el aviso del paso 3.
set -euo pipefail

PORTAL_BASE="${PORTAL_BASE:-$(kubectl -n quorum-backoffice get cm quorum-backoffice-api-config -o jsonpath='{.data.CANVAS_PORTAL_API_URL}' 2>/dev/null || true)}"
PORTAL_BASE="${PORTAL_BASE:-http://127.0.0.1:8090}"   # portal-api (fuente del roster)

# Bearer estático = CANVAS_PORTAL_API_TOKEN. Se extrae del Secret del clúster
# si no se define manualmente; nunca se imprime.
if [ -z "${PORTAL_TOKEN:-}" ]; then
  PORTAL_TOKEN="$(kubectl -n quorum-backoffice get secret quorum-backoffice-api-secret \
    -o jsonpath='{.data.CANVAS_PORTAL_API_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
fi
PORTAL_TOKEN="${PORTAL_TOKEN:?No se pudo extraer CANVAS_PORTAL_API_TOKEN del Secret; define PORTAL_TOKEN manualmente}"

BO="${BO:-https://backoffice.inecuni.com}"            # backoffice
ADMIN="${ADMIN:-admin}"
OTP_SERVICE="${OTP_SERVICE:-https://otp.inecuni.com}"  # servicio OTP (emisión de códigos)
# Contraseña del operador `admin` (rotada 2026-10-08). Se lee del host; nunca se imprime.
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(sudo -n grep '^admin=' /opt/secrets/quorum/otp/privileged-operators.txt 2>/dev/null | cut -d= -f2)}"

# 1. Fuente: roster que el portal sirve al backoffice (hoy NO trae SIS).
echo "== 1. portal GET /v1/students =="
curl -sS -H "authorization: Bearer ${PORTAL_TOKEN}" "${PORTAL_BASE}/v1/students" | jq .

# 2. Emitir un OTP de login para el operador y entrar al backoffice.
#    El OTP se emite automáticamente con la contraseña del operador `admin`
#    (scope "login"); si no se puede leer, se pide manualmente.
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  OTP="$(curl -sS -X POST "${OTP_SERVICE}/v1/users/${ADMIN}/otps" \
    -H 'Content-Type: application/json' \
    -d "{\"password\":\"${ADMIN_PASSWORD}\",\"scope\":\"login\"}" 2>/dev/null \
    | jq -r '.token // empty' 2>/dev/null || true)"
  if [ -n "$OTP" ]; then
    echo "== 2. OTP emitido automáticamente (scope login) =="
  else
    echo "== 2. no se pudo emitir el OTP automáticamente; se pedirá manual =="
  fi
fi
if [ -z "${OTP:-}" ]; then
  read -rsp "OTP (6 dígitos): " OTP; echo
fi
echo "== 2. backoffice login =="
curl -sS -c /tmp/bo.cookies -X POST "${BO}/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"${ADMIN}\",\"otp\":\"${OTP}\"}"

# 3. Sincronizar cache desde el portal.
#    ⚠️ DESTRUCTIVO: la pasada `deactivateMissing` apaga las filas que ya no
#    aparecen en el total del portal. Con el portal devolviendo 3 usuarios,
#    esto desactivaría ~996 matrículas. No correr sin ventana y decisión.
if [ "${APPLY_SYNC:-0}" = "1" ]; then
  echo "== 3. POST /api/v1/matriculas/sync =="
  curl -sS -b /tmp/bo.cookies -X POST "${BO}/api/v1/matriculas/sync" | jq .
else
  echo "== 3. sync SALTADO (APPLY_SYNC=1 para ejecutarlo) =="
fi

# 4. Leer el cache ya sincronizado (incluye sisId si la fila lo tiene).
echo "== 4. GET /api/v1/matriculas?status=assigned =="
curl -sS -b /tmp/bo.cookies "${BO}/api/v1/matriculas?status=assigned&limit=3" | jq .

# 5. Detalle de un estudiante por canvasUserId (admin).
echo "== 5. GET /api/v1/students?canvasUserId=<id> =="
curl -sS -b /tmp/bo.cookies "${BO}/api/v1/students?canvasUserId=90001" | jq .
