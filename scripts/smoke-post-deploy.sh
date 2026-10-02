#!/usr/bin/env bash
# smoke-post-deploy.sh — Unauthenticated smoke checks after a deploy.
#
# Asserts that the public backoffice bundle + API surface are alive and
# routing as expected after a k3s rollout (or any other release flow). All
# probes are unauthenticated: the goal is "does the surface respond?", not
# "does the business logic work?" — for that, run the Playwright e2e +
# parity harness instead.
#
# Probes (default base = https://backoffice.quorum.asistentepro.mx):
#   GET /login
#     → 302 to /backoffice/login       (basePath redirect at the edge)
#   GET /backoffice/login
#     → 200                           (login form served)
#   GET /backoffice/marbetes
#     → 307 or 302 to /backoffice/login (auth gate alive)
#   GET /backoffice/asociar
#     → 307 or 302 to /backoffice/login (auth gate alive)
#   GET /backoffice/assets/plantilla-carga-masiva-marbetes.xlsx
#     → 200                           (bulk-upload template served)
#   GET /api/v1/matriculas
#     → 401                           (unauth, but route reachable)
#
# Optional local API probe (when SMOKE_API_LOCAL is exported and the host
# answers on the loopback port — typically 4100 on the node):
#   GET ${SMOKE_API_LOCAL}/healthz  → 200 (liveness)
#   GET ${SMOKE_API_LOCAL}/readyz   → 200 (readiness — PG+Redis+OTP up)
#
# The local probes are skipped silently when the host is unreachable
# (e.g. running from CI without a node tunnel). The external probes
# are mandatory; any mismatch fails the script.
#
# Usage:
#   bash scripts/smoke-post-deploy.sh
#   SMOKE_BASE_URL=https://staging.example.test bash scripts/smoke-post-deploy.sh
#   SMOKE_API_LOCAL=http://127.0.0.1:4100 bash scripts/smoke-post-deploy.sh
#   bash scripts/smoke-post-deploy.sh --help
#
# Conventions: bash 5+, `set -euo pipefail`, ANSI colors when stdout is a TTY.

set -euo pipefail

# ---- Args ---------------------------------------------------------------

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

# ---- Config -------------------------------------------------------------

SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://backoffice.quorum.asistentepro.mx}"
SMOKE_API_LOCAL="${SMOKE_API_LOCAL:-}"  # empty → local probes skipped

if [[ -t 1 ]]; then
  C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_RESET=''
fi

log()  { printf '%s[smoke]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"; }
hdr()  { printf '\n%s== %s ==%s\n' "${C_OK}" "$*" "${C_RESET}"; }
ok()   { printf '%s[ok]%s %s\n' "${C_OK}" "${C_RESET}" "$*"; }
warn() { printf '%s[warn]%s %s\n' "${C_WARN}" "${C_RESET}" "$*"; }
err()  { printf '%s[fail]%s %s\n' "${C_ERR}" "${C_RESET}" "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; exit 1; }
}

require_cmd curl

# Strip a single trailing slash so URL joins are predictable.
base="${SMOKE_BASE_URL%/}"
fail_count=0
step_count=0

# ---- Probe helper ------------------------------------------------------

# Usage: probe "label" "expected_code[,expected_code...]" "url"
#   - expected_code may be a single status (e.g. "200") or a comma-list
#     of acceptable statuses (e.g. "302,307"). Match is exact.
#   - Records PASS/FAIL into the summary counters.
probe() {
  local label="$1" expected="$2" url="$3"
  step_count=$((step_count + 1))
  local code
  # -sk: silent, follow ssl. -o /dev/null: discard body. -w '%{http_code}': write code.
  # We intentionally do NOT follow redirects (-L off) so we can assert the
  # redirect status itself (302/307) plus the Location header.
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "${url}" || echo 000)"
  local expect_ok=0
  IFS=',' read -r -a wants <<< "${expected}"
  for want in "${wants[@]}"; do
    if [[ "${code}" == "${want}" ]]; then expect_ok=1; break; fi
  done
  if [[ "${expect_ok}" -eq 1 ]]; then
    ok "[${step_count}] ${label} → ${code}"
  else
    err "[${step_count}] ${label} → ${code} (expected ${expected})"
    fail_count=$((fail_count + 1))
  fi
}

# Like probe(), but also asserts the Location header contains a substring.
probe_redirect_to() {
  local label="$1" expected_status="$2" location_needle="$3" url="$4"
  step_count=$((step_count + 1))
  local out
  local loc
  out="$(curl -sk -i --max-time 15 "${url}" || true)"
  local code
  code="$(printf '%s' "${out}" | awk 'NR==1{print $2; exit}')"
  loc="$(printf '%s' "${out}" | awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/\r$/,""); print; exit}' | sed 's/^[Ll]ocation:[[:space:]]*//')"
  if [[ "${code}" == "${expected_status}" ]] && [[ "${loc}" == *"${location_needle}"* ]]; then
    ok "[${step_count}] ${label} → ${code} Location: ${loc}"
  else
    err "[${step_count}] ${label} → ${code} Location: ${loc} (expected ${expected_status} with Location containing '${location_needle}')"
    fail_count=$((fail_count + 1))
  fi
}

# Reachability probe for the optional local API host. Returns 0 if reachable.
host_reachable() {
  local url="$1"
  # /healthz is fast and unauthenticated — a 200 means the API is up.
  curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "${url}/healthz" 2>/dev/null | grep -qE '^(2|3)[0-9][0-9]$'
}

# ---- Probes -------------------------------------------------------------

log "SMOKE_BASE_URL  = ${base}"
log "SMOKE_API_LOCAL = ${SMOKE_API_LOCAL:-<unset — local probes skipped>}"

hdr "external web + api probes"

probe_redirect_to "login GET  302→/backoffice/login" "302" "/backoffice/login" \
  "${base}/login"

probe             "backoffice/login 200"          "200" \
  "${base}/backoffice/login"

probe             "backoffice/marbetes auth gate" "302,307" \
  "${base}/backoffice/marbetes"

probe             "backoffice/asociar auth gate"  "302,307" \
  "${base}/backoffice/asociar"

probe             "bulk-upload template 200"      "200" \
  "${base}/backoffice/assets/plantilla-carga-masiva-marbetes.xlsx"

probe             "api /api/v1/matriculas unauth 401" "401" \
  "${base}/api/v1/matriculas"

# ---- Optional local probes ---------------------------------------------

if [[ -n "${SMOKE_API_LOCAL}" ]]; then
  hdr "local API probes (${SMOKE_API_LOCAL})"
  if host_reachable "${SMOKE_API_LOCAL}"; then
    probe             "local /healthz 200"   "200" \
      "${SMOKE_API_LOCAL%/}/healthz"
    probe             "local /readyz 200"    "200" \
      "${SMOKE_API_LOCAL%/}/readyz"
  else
    warn "SMOKE_API_LOCAL=${SMOKE_API_LOCAL} not reachable on loopback; skipping local probes (this is not a failure when running outside the k3s node)."
  fi
fi

# ---- Summary -----------------------------------------------------------

hdr "summary"
log "probes : ${step_count}"
if [[ "${fail_count}" -eq 0 ]]; then
  printf '%sPASS%s — smoke-post-deploy.sh: %d probe(s) against %s\n' "${C_OK}" "${C_RESET}" "${step_count}" "${base}"
  exit 0
else
  printf '%sFAIL%s — smoke-post-deploy.sh: %d probe(s) failed against %s\n' "${C_ERR}" "${C_RESET}" "${fail_count}" "${base}"
  exit 1
fi