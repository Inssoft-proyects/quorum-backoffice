#!/usr/bin/env bash
#
# MFA mobile login — smoke script (curl sequence)
# ===============================================
# Recorre el flujo de inicio de sesión de la App móvil de punta a punta:
#
#   1. Resolver identidad (S2S, HMAC del backoffice):
#        POST {BACKOFFICE}/api/v1/mfa/get-subject
#        { "marbete_code": <...>, "serial_number": <...> }
#        → { "canvas_user_id": 13, "matricula": "TOPGR4" }
#
#   2. Emitir el OTP de acceso (máquina, HMAC de quorum-otp):
#        POST {OTP}/v1/otps
#        { "subject": "<canvas_user_id>", "scope": "mfa.access" }
#        → { "token": "K7QM3X", ... }
#
#   3. Autenticar (canal JSON del móvil, sin cookie):
#        POST {BACKOFFICE}/api/v1/mfa/authenticate
#        { "marbete_code": <...>, "serial_number": <...>, "otp": "<token>" }
#        → 201 con { canvas_user_id, student_name, student_email, matricula,
#                    role:"student", session_id, expires_at }
#        El móvil usa `session_id` del body (no la cookie __Host-mfa_sid).
#
# Secretos: se leen automáticamente del Secret de Kubernetes
#   quorum-backoffice/quorum-backoffice-api-secret:
#     OTP_SERVICE_TOKEN        → HMAC para /v1/otps
#     BACKOFFICE_SERVICE_TOKENS→ "canvas:<secret>" para /mfa/get-subject
# El Secret de Kubernetes es la fuente primaria; la variable de entorno es solo fallback.
#
# Entorno (opcional; los secretos se resuelven solos):
#   BACKOFFICE_BASE_URL        (default http://127.0.0.1:4100 port-forward)
#   BACKOFFICE_SERVICE_NAME    override del nombre S2S (default el prefijo "canvas" del Secret)
#   BACKOFFICE_SERVICE_TOKEN   override del secreto S2S (default el valor del Secret)
#   OTP_SERVICE_URL            (default http://127.0.0.1:4200 port-forward)
#   OTP_SERVICE_NAME           (default quorum-backoffice)
#   OTP_SERVICE_TOKEN          override del secreto OTP
#   KUBECTL_NAMESPACE / KUBECTL_SECRET
#   MARBETE_CODE / SERIAL_NUMBER
#   SUBJECT                    subject del OTP (default 13 = TOPGR4)
#   USE_GET_SUBJECT=1          resuelve el subject vía get-subject (endpoint aún sin desplegar)
set -euo pipefail

for cmd in curl openssl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' no está instalado (requerido)." >&2; exit 1; }
done

KUBECTL_NAMESPACE="${KUBECTL_NAMESPACE:-quorum-backoffice}"
KUBECTL_SECRET="${KUBECTL_SECRET:-quorum-backoffice-api-secret}"

BACKOFFICE_BASE="${BACKOFFICE_BASE_URL:-http://127.0.0.1:4100}"
BACKOFFICE_BASE="${BACKOFFICE_BASE%/}"
OTP_BASE="${OTP_SERVICE_URL:-http://127.0.0.1:4200}"
OTP_BASE="${OTP_BASE%/}"
OTP_SERVICE="${OTP_SERVICE_NAME:-quorum-backoffice}"
MARBETE="${MARBETE_CODE:-VALIDO-2609982468}"
SERIAL="${SERIAL_NUMBER:-f401e1afcfd09b16}"
SUBJECT="${SUBJECT:-13}"

k8s_secret() {
  # $1 = clave → imprime el valor decodificado del Secret de Kubernetes.
  local key="$1" b64
  command -v kubectl >/dev/null 2>&1 || return 0
  b64="$(kubectl -n "$KUBECTL_NAMESPACE" get secret "$KUBECTL_SECRET" \
    -o "jsonpath={.data.${key}}" 2>/dev/null)" || b64=""
  if [ -n "$b64" ]; then printf '%s' "$b64" | base64 -d; fi
}

hmac_sign() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | awk '{print $NF}'; }
json_get() { printf '%s' "$1" | python3 -c 'import sys,json;print(json.load(sys.stdin)[sys.argv[1]])' "$2"; }

post_json() {
  # $1 = url · $2 = header Authorization (puede ir vacío) · $3 = body JSON
  # Traza cada intervención a stderr (endpoint + payload + response) y
  # devuelve el body por stdout para que json_get lo parse.
  local url="$1" auth="${2:-}" body="$3" code tmp resp
  tmp="$(mktemp)"

  echo "===============================================================================" >&2
  echo "### POST ${url}" >&2
  echo "-------------------------------------------------------------------------------" >&2
  echo "    payload: ${body}" >&2
  [ -n "$auth" ] && echo "    authorization: ${auth}" >&2

  if [ -n "$auth" ]; then
    code="$(curl -sS -o "$tmp" -w '%{http_code}' -X POST "$url" \
      -H 'Content-Type: application/json' \
      -H "Authorization: ${auth}" \
      -d "$body")"
  else
    code="$(curl -sS -o "$tmp" -w '%{http_code}' -X POST "$url" \
      -H 'Content-Type: application/json' \
      -d "$body")"
  fi

  resp="$(cat "$tmp")"
  echo "-------------------------------------------------------------------------------" >&2
  echo "    -> HTTP ${code}" >&2
  echo "    response: ${resp}" >&2
  echo "" >&2

  if [[ "$code" != 2* ]]; then
    echo "ERROR: POST ${url} -> HTTP ${code}" >&2
    echo "${resp}" >&2
    rm -f "$tmp"
    exit 1
  fi
  printf '%s' "${resp}"
  rm -f "$tmp"
}

# --- Resolver secretos (Kubernetes es la fuente de verdad; entorno es fallback) ---
OTP_SECRET="$(k8s_secret OTP_SERVICE_TOKEN)"
[ -z "$OTP_SECRET" ] && OTP_SECRET="${OTP_SERVICE_TOKEN:-}"

BT="$(k8s_secret BACKOFFICE_SERVICE_TOKENS)"
[ -z "$BT" ] && BT="${BACKOFFICE_SERVICE_TOKENS:-}"
# BACKOFFICE_SERVICE_TOKENS = "nombre:secret" (split en el PRIMER ':')
BACKOFFICE_SERVICE="${BACKOFFICE_SERVICE_NAME:-${BT%%:*}}"
BACKOFFICE_SECRET="${BACKOFFICE_SERVICE_TOKEN:-${BT#*:}}"

if [ -z "$OTP_SECRET" ]; then
  echo "ERROR: no se pudo obtener OTP_SERVICE_TOKEN (entorno ni ${KUBECTL_NAMESPACE}/${KUBECTL_SECRET})." >&2
  exit 2
fi
if [ -z "$BACKOFFICE_SECRET" ] || [ -z "$BACKOFFICE_SERVICE" ]; then
  echo "ERROR: no se pudo obtener BACKOFFICE_SERVICE_TOKENS (entorno ni ${KUBECTL_NAMESPACE}/${KUBECTL_SECRET})." >&2
  exit 2
fi

# --- 1) Resolver identidad (subject del OTP) ----------------------------------
# Por defecto usa SUBJECT (fixture 13 = TOPGR4). Con USE_GET_SUBJECT=1 se
# resuelve vía get-subject (requiere que el endpoint esté desplegado).
if [ "${USE_GET_SUBJECT:-0}" = "1" ]; then
  GS_BODY="{\"marbete_code\":\"${MARBETE}\",\"serial_number\":\"${SERIAL}\"}"
  GS_TS="$(date +%s)"
  GS_SIG="$(hmac_sign "${BACKOFFICE_SECRET}" "${GS_TS}.${GS_BODY}")"

  echo "==> get-subject (marbete=${MARBETE} serial=${SERIAL})"
  GS_RESP="$(post_json "${BACKOFFICE_BASE}/api/v1/mfa/get-subject" \
    "HMAC ${BACKOFFICE_SERVICE} ${GS_TS} ${GS_SIG}" \
    "${GS_BODY}")"

  SUBJECT="$(json_get "${GS_RESP}" canvas_user_id)"
  MATRICULA="$(json_get "${GS_RESP}" matricula)"
  echo "    canvas_user_id=${SUBJECT}  matricula=${MATRICULA}"
else
  echo "==> subject conocido (get-subject omitido; USE_GET_SUBJECT=1 para resolverlo)"
  echo "    canvas_user_id=${SUBJECT}  matricula=${MATRICULA:-<no resuelta>}"
fi

# --- 2) Emitir el OTP de acceso (scope mfa.access) ----------------------------
ISSUE_BODY="{\"subject\":\"${SUBJECT}\",\"scope\":\"mfa.access\"}"
OTP_TS="$(date +%s)"
OTP_SIG="$(hmac_sign "${OTP_SECRET}" "${OTP_TS}.${ISSUE_BODY}")"

echo "==> emitiendo OTP (subject=${SUBJECT} scope=mfa.access)"
OTP_RESP="$(post_json "${OTP_BASE}/v1/otps" \
  "HMAC ${OTP_SERVICE} ${OTP_TS} ${OTP_SIG}" \
  "${ISSUE_BODY}")"

OTP="$(json_get "${OTP_RESP}" token)"
echo "    OTP recibido: ${OTP}"

# --- 3) Autenticar (canal JSON del móvil) -------------------------------------
AUTH_BODY="{\"marbete_code\":\"${MARBETE}\",\"serial_number\":\"${SERIAL}\",\"otp\":\"${OTP}\"}"
echo "==> autenticando (POST /api/v1/mfa/authenticate)"
post_json "${BACKOFFICE_BASE}/api/v1/mfa/authenticate" "" "${AUTH_BODY}" >/dev/null
echo "==> El móvil usa session_id del body JSON (no la cookie)."
