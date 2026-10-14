#!/usr/bin/env bash
#
# MFA authenticate — smoke script (curl sequence)
# ================================================
# Exercises the backoffice MFA access flow end-to-end:
#
#   1. Issue a single-use OTP via quorum-otp (machine HMAC plane):
#        POST /v1/otps   { "subject": <canvas_user_id>, "scope": "mfa.access" }
#      The OTP's subject MUST equal the student's `canvas_user_id` because the
#      backoffice verifies it with `subject = String(student.canvas_user_id)`
#      and `scope = 'mfa.access'`.
#   2. Authenticate:
#        POST {MFA_BASE_URL}/api/v1/mfa/authenticate
#        { "marbete_code": <VALIDO-XXXXXXXXXX>, "serial_number": <hex16>, "otp": <token> }
#      Success => 201 with a `kind=student` session.
#
# Secretos: el HMAC secret se lee automáticamente del Secret de Kubernetes
#   kubectl -n quorum-backoffice get secret quorum-backoffice-api-secret \
#     -o jsonpath='{.data.OTP_SERVICE_TOKEN}'
# (base64). El Secret de Kubernetes es la fuente primaria; la variable
# de entorno es solo un fallback si kubectl no está disponible.
#
# Entorno (todo opcional; los secretos se resuelven solos):
#   OTP_SERVICE_URL       quorum-otp base URL (default http://127.0.0.1:4200 port-forward)
#   OTP_SERVICE_NAME      HMAC service name   (default quorum-backoffice)
#   OTP_SERVICE_TOKEN     override del secreto (si no, se lee de Kubernetes)
#   MFA_BASE_URL          backoffice API base (default http://127.0.0.1:4100 port-forward)
#   KUBECTL_NAMESPACE     (default quorum-backoffice)
#   KUBECTL_SECRET        (default quorum-backoffice-api-secret)
#   SUBJECT               (default 13 = fixture TOPGR4)
#   SCOPE                 (default mfa.access)
#   MARBETE_CODE          (default VALIDO-2609982468)
#   SERIAL_NUMBER         (default f401e1afcfd09b16)
set -euo pipefail

for cmd in curl openssl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' no está instalado (requerido)." >&2; exit 1; }
done

KUBECTL_NAMESPACE="${KUBECTL_NAMESPACE:-quorum-backoffice}"
KUBECTL_SECRET="${KUBECTL_SECRET:-quorum-backoffice-api-secret}"

OTP_URL="${OTP_SERVICE_URL:-http://127.0.0.1:4200}"
OTP_URL="${OTP_URL%/}"
SERVICE="${OTP_SERVICE_NAME:-quorum-backoffice}"
MFA_BASE="${MFA_BASE_URL:-http://127.0.0.1:4100}"
MFA_BASE="${MFA_BASE%/}"
SUBJECT="${SUBJECT:-13}"
SCOPE="${SCOPE:-mfa.access}"
MARBETE="${MARBETE_CODE:-VALIDO-2609982468}"
SERIAL="${SERIAL_NUMBER:-f401e1afcfd09b16}"

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

# --- Resolver el HMAC secret (Kubernetes es la fuente de verdad; entorno es fallback) ---
SECRET="$(k8s_secret OTP_SERVICE_TOKEN)"
if [ -z "$SECRET" ]; then
  SECRET="${OTP_SERVICE_TOKEN:-}"
fi
if [ -z "$SECRET" ]; then
  echo "ERROR: no se pudo obtener OTP_SERVICE_TOKEN (ni de ${KUBECTL_NAMESPACE}/${KUBECTL_SECRET} ni del entorno)." >&2
  exit 2
fi

# --- 1) Emitir el OTP --------------------------------------------------------
ISSUE_BODY="{\"subject\":\"${SUBJECT}\",\"scope\":\"${SCOPE}\"}"
TS="$(date +%s)"
SIG="$(hmac_sign "${SECRET}" "${TS}.${ISSUE_BODY}")"

echo "==> issuing OTP (subject=${SUBJECT} scope=${SCOPE})"
OTP_RESP="$(post_json "${OTP_URL}/v1/otps" "HMAC ${SERVICE} ${TS} ${SIG}" "${ISSUE_BODY}")"
OTP="$(json_get "${OTP_RESP}" token)"
echo "    OTP received: ${OTP}"

# --- 2) Autenticar -----------------------------------------------------------
AUTH_BODY="{\"marbete_code\":\"${MARBETE}\",\"serial_number\":\"${SERIAL}\",\"otp\":\"${OTP}\"}"
echo "==> authenticating (POST ${MFA_BASE}/api/v1/mfa/authenticate)"
post_json "${MFA_BASE}/api/v1/mfa/authenticate" "" "${AUTH_BODY}" >/dev/null
