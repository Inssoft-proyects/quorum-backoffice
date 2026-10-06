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
#        POST https://backoffice.quorum.asistentepro.mx/api/v1/mfa/authenticate
#        { "marbete_code": <VALIDO-XXXXXXXXXX>, "serial_number": <hex16>, "otp": <token> }
#      Success => 201 with a `kind=student` session (student_name/email are NULL
#      for the synthetic privacy-only students).
#
# Environment (no secrets are hardcoded):
#   OTP_SERVICE_URL       quorum-otp base URL (default https://otp.quorum.asistentepro.mx)
#   OTP_SERVICE_NAME      HMAC service name   (default quorum-backoffice)
#   OTP_SERVICE_TOKEN     HMAC shared secret  (REQUIRED)
#   SUBJECT               student canvas_user_id (default 13 = fixture TOPGR4)
#   SCOPE                 default mfa.access
#   MARBETE_CODE          default VALIDO-2609982468
#   SERIAL_NUMBER         default f401e1afcfd09b16
#   MFA_BASE_URL          backoffice base URL (default https://backoffice.quorum.asistentepro.mx)
set -euo pipefail

OTP_URL="${OTP_SERVICE_URL:-https://otp.quorum.asistentepro.mx}"
OTP_URL="${OTP_URL%/}"
SERVICE="${OTP_SERVICE_NAME:-quorum-backoffice}"
SECRET="${OTP_SERVICE_TOKEN:?set OTP_SERVICE_TOKEN (backoffice<->otp HMAC secret)}"
SUBJECT="${SUBJECT:-13}"
SCOPE="${SCOPE:-mfa.access}"
MARBETE="${MARBETE_CODE:-VALIDO-2609982468}"
SERIAL="${SERIAL_NUMBER:-f401e1afcfd09b16}"
MFA_BASE="${MFA_BASE_URL:-https://backoffice.quorum.asistentepro.mx}"

# --- 1) Issue the OTP ---------------------------------------------------------
ISSUE_BODY="{\"subject\":\"${SUBJECT}\",\"scope\":\"${SCOPE}\"}"
TS="$(date +%s)"
# Signature = HMAC-SHA256(secret, "<ts>.<exact-json-body>") in lowercase hex.
SIG="$(printf '%s' "${TS}.${ISSUE_BODY}" | openssl dgst -sha256 -hmac "${SECRET}" -hex | sed 's/^.*= //')"

echo "==> issuing OTP (subject=${SUBJECT} scope=${SCOPE})"
ISSUE_RESP="$(curl -sS -X POST "${OTP_URL}/v1/otps" \
  -H 'Content-Type: application/json' \
  -H "Authorization: HMAC ${SERVICE} ${TS} ${SIG}" \
  -d "${ISSUE_BODY}")"

OTP="$(printf '%s' "${ISSUE_RESP}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
echo "    OTP received: ${OTP}"

# --- 2) Authenticate via the backoffice MFA endpoint --------------------------
echo "==> authenticating (marbete=${MARBETE} serial=${SERIAL})"
AUTH_BODY="{\"marbete_code\":\"${MARBETE}\",\"serial_number\":\"${SERIAL}\",\"otp\":\"${OTP}\"}"
curl -sS -i -X POST "${MFA_BASE}/api/v1/mfa/authenticate" \
  -H 'Content-Type: application/json' \
  -d "${AUTH_BODY}"
