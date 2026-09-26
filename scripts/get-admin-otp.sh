#!/usr/bin/env bash
#
# get-admin-otp.sh — issue a fresh login OTP for the BackOffice admin user.
#
# Reproduces the HMAC contract that the quorum-otp operator console uses to
# mint OTPs out of band, without ever printing the shared secret. The script
# only emits the OTP token (which is what the Playwright runner needs as
# `E2E_ADMIN_OTP`) and a couple of metadata fields.
#
# Mirrors scripts/e2e-login-probe-username.mjs.
#
# Usage:
#   scripts/get-admin-otp.sh                       # default: admin / login
#   E2E_OTP_SUBJECT=auditor E2E_OTP_SCOPE=audit scripts/get-admin-otp.sh
#
# Exits non-zero if kubectl cannot read the secret, if the OTP service
# refuses the request, or if the response does not contain a token.

set -euo pipefail

KUBECTL_NAMESPACE="${KUBECTL_NAMESPACE:-quorum-backoffice}"
KUBECTL_SECRET="${KUBECTL_SECRET:-quorum-backoffice-api-secret}"
KUBECTL_KEY="${KUBECTL_KEY:-OTP_SERVICE_TOKEN}"
OTP_BASE_URL="${OTP_BASE_URL:-http://127.0.0.1:4200}"
OTP_AUDIENCE="${OTP_AUDIENCE:-quorum-backoffice}"
SUBJECT="${E2E_OTP_SUBJECT:-admin}"
SCOPE="${E2E_OTP_SCOPE:-login}"

emit_jq_or_raw() {
  local payload="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -c .
  else
    printf '%s' "$payload"
  fi
}

# 1) Read the HMAC secret from Kubernetes.
SECRET_B64="$(kubectl -n "${KUBECTL_NAMESPACE}" \
  get secret "${KUBECTL_SECRET}" \
  -o jsonpath="{.data.${KUBECTL_KEY}}")"
if [[ -z "${SECRET_B64}" ]]; then
  echo "ERROR: empty secret ${KUBECTL_KEY} in ${KUBECTL_NAMESPACE}/${KUBECTL_SECRET}" >&2
  exit 2
fi
SECRET="$(printf '%s' "${SECRET_B64}" | base64 -d)"

# 2) Build the HMAC signature: HMAC_SHA256(secret, "<ts>.<rawBody>")
TS="$(date +%s)"
BODY="$(printf '{"subject":"%s","scope":"%s"}' "${SUBJECT}" "${SCOPE}")"
SIG="$(printf '%s.%s' "${TS}" "${BODY}" | openssl dgst -sha256 -hmac "${SECRET}" -hex \
  | awk '{print $NF}')"
AUTH_HEADER="HMAC ${OTP_AUDIENCE} ${TS} ${SIG}"

# 3) Issue the OTP. Capture body + status code separately so we can show a
# useful error when the service refuses the request.
TMP_HEADERS="$(mktemp)"
HTTP_STATUS="$(curl -sS -o /tmp/otp.body -D "${TMP_HEADERS}" -w '%{http_code}' \
  -X POST "${OTP_BASE_URL}/v1/otps" \
  -H "authorization: ${AUTH_HEADER}" \
  -H "content-type: application/json" \
  --data "${BODY}")"
rm -f "${TMP_HEADERS}"

if [[ "${HTTP_STATUS}" -lt 200 || "${HTTP_STATUS}" -ge 300 ]]; then
  echo "ERROR: OTP service returned HTTP ${HTTP_STATUS}:" >&2
  cat /tmp/otp.body >&2
  echo >&2
  rm -f /tmp/otp.body
  exit 3
fi

# 4) Emit the OTP response. If jq is available, project only the fields the
# Playwright harness actually needs (token + expires_at + ttl_seconds).
PAYLOAD="$(cat /tmp/otp.body)"
rm -f /tmp/otp.body

if command -v jq >/dev/null 2>&1; then
  TOKEN="$(printf '%s' "${PAYLOAD}" | jq -er '.token // empty')"
  if [[ -z "${TOKEN}" ]]; then
    echo "ERROR: OTP response has no .token field:" >&2
    emit_jq_or_raw "${PAYLOAD}" >&2
    echo >&2
    exit 4
  fi
  printf '%s\n' "${TOKEN}"
else
  emit_jq_or_raw "${PAYLOAD}"
fi