#!/usr/bin/env bash
# ci-checks.sh — Local/CI pre-merge verification gate for quorum-backoffice.
#
# Runs the deterministic, non-deploy checks that gate a feature branch:
#   1. packages/shared — build + typecheck (consumers compile against dist/)
#   2. apps/api        — typecheck + unit tests (integration phase is gated
#                        on a disposable DATABASE_URL_TEST — see below)
#   3. apps/web        — typecheck + unit tests
#   4. web standalone-assets smoke + postbuild wiring assertion
#                        (guarantees scripts/copy-web-standalone-assets.sh
#                        is covered by its self-test AND that
#                        apps/web/package.json wires it as the postbuild
#                        hook — see scripts/test-copy-web-standalone-assets.sh)
#   6. Optional lookfeel parity harness pin: export MAQUETTE_DIR before any
#                        lookfeel work so CI uses the design canon explicitly.
#
# Optional phases (off by default — gate them explicitly):
#   * DATABASE_URL_TEST exported   → adds apps/api/test:integration
#     (the suite drops/creates tables; never run against a non-disposable DB)
#   * RUN_PARITY=1                 → adds apps/web/e2e/lookfeel parity run
#     (requires Playwright + a canonical maquette directory)
#
# Pinning MAQUETTE_DIR up-front (F5/WU13 follow-up) so any lookfeel work
# downstream — including the parity harness, but also future lookfeel
# suites — uses the same design canon. The override wins over all other
# candidates in apps/web/e2e/lookfeel/helpers/maquette-server.ts:resolveMaquetteDir.
#
# Usage:
#   bash scripts/ci-checks.sh              # shared + api (unit) + web (unit)
#   DATABASE_URL_TEST=... bash scripts/ci-checks.sh
#                                          # also run apps/api integration
#   RUN_PARITY=1 MAQUETTE_DIR=/path bash scripts/ci-checks.sh
#                                          # also run lookfeel parity harness
#   bash scripts/ci-checks.sh --help
#
# Conventions: bash 5+, `set -euo pipefail`, ANSI colors when stdout is a TTY.

set -euo pipefail

# ---- Args ---------------------------------------------------------------

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

# ---- Helpers ------------------------------------------------------------

# Repo root (script lives in <repo>/scripts/). Robust against being sourced.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# Pin the maquette canon for any downstream lookfeel work (F5/WU13 follow-up).
# Picked up by apps/web/e2e/lookfeel/helpers/maquette-server.ts:resolveMaquetteDir
# as the first candidate and therefore wins over every other path.
export MAQUETTE_DIR="${MAQUETTE_DIR:-/planQuorum/dev/quorum-design/design/Inec/Inec}"

if [[ -t 1 ]]; then
  C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_RESET=''
fi

log()  { printf '%s[ci]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"; }
hdr()  { printf '\n%s== %s ==%s\n' "${C_OK}" "$*" "${C_RESET}"; }
ok()   { printf '%s[ok]%s %s\n' "${C_OK}" "${C_RESET}" "$*"; }
warn() { printf '%s[warn]%s %s\n' "${C_WARN}" "${C_RESET}" "$*"; }
err()  { printf '%s[fail]%s %s\n' "${C_ERR}" "${C_RESET}" "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; exit 1; }
}

require_cmd node
require_cmd npm

step_count=0
fail_count=0
record_pass() { ok "$*"; }
record_skip() { warn "SKIP: $*"; }
record_fail() { err "$*"; fail_count=$((fail_count + 1)); }

# Run a step inside its package directory; record pass/fail.
run_step() {
  local dir="$1" label="$2" cmd="$3"
  step_count=$((step_count + 1))
  hdr "[${step_count}] ${label} (cd ${dir})"
  if ( cd "${REPO_ROOT}/${dir}" && eval "${cmd}" ); then
    record_pass "${label}"
  else
    record_fail "${label}"
    return 1
  fi
}

# ---- Pre-flight: report the gates that will run -------------------------

log "repo      : ${REPO_ROOT}"
log "node      : $(node --version)"
log "npm       : $(npm --version)"
log "MAQUETTE_DIR: ${MAQUETTE_DIR} (pinned for lookfeel)"

if [[ -n "${DATABASE_URL_TEST:-}" ]]; then
  log "integration: ENABLED (DATABASE_URL_TEST set; disposable DB required)"
else
  log "integration: skipped (set DATABASE_URL_TEST to enable)"
fi

if [[ "${RUN_PARITY:-0}" == "1" ]]; then
  log "parity    : ENABLED (RUN_PARITY=1)"
else
  log "parity    : skipped (set RUN_PARITY=1 to enable)"
fi

# ---- Phase 1: packages/shared ------------------------------------------

run_step "packages/shared" "shared build"      "npm run build"      || exit 1
run_step "packages/shared" "shared typecheck"  "npm run typecheck"  || exit 1

# ---- Phase 2: apps/api --------------------------------------------------

run_step "apps/api" "api typecheck" "npm run typecheck" || exit 1
run_step "apps/api" "api unit tests" "npm test"         || exit 1

# ---- Phase 3: apps/web -------------------------------------------------

run_step "apps/web" "web typecheck" "npm run typecheck" || exit 1
run_step "apps/web" "web unit tests" "npm test"         || exit 1

# ---- Phase 4: web standalone-assets smoke + postbuild wiring ---------

step_count=$((step_count + 1))
hdr "[${step_count}] standalone-assets smoke (scripts/test-copy-web-standalone-assets.sh)"
if bash "${REPO_ROOT}/scripts/test-copy-web-standalone-assets.sh" >/dev/null 2>&1; then
  record_pass "standalone-assets smoke"
else
  record_fail "standalone-assets smoke (scripts/test-copy-web-standalone-assets.sh exited non-zero)"
  exit 1
fi

step_count=$((step_count + 1))
hdr "[${step_count}] postbuild wiring (apps/web/package.json)"
# Apps/web/package.json must wire its `postbuild` script to
# scripts/copy-web-standalone-assets.sh so every `next build` ships the
# static + public assets into the standalone output. A regression here
# breaks the deployed login (SSR HTML 404s its chunks).
if grep -Eq '"postbuild"[[:space:]]*:[[:space:]]*"[^"]*copy-web-standalone-assets\.sh' \
    "${REPO_ROOT}/apps/web/package.json"; then
  record_pass "postbuild wiring in apps/web/package.json"
else
  record_fail "postbuild wiring missing in apps/web/package.json (expected postbuild to invoke copy-web-standalone-assets.sh)"
  exit 1
fi

# ---- Phase 5 (optional): apps/api integration -------------------------

if [[ -n "${DATABASE_URL_TEST:-}" ]]; then
  hdr "[+] api integration tests (DATABASE_URL_TEST set)"
  step_count=$((step_count + 1))
  if ( cd "${REPO_ROOT}/apps/api" && DATABASE_URL_TEST="${DATABASE_URL_TEST}" npm run test:integration ); then
    record_pass "api integration tests"
  else
    record_fail "api integration tests"
    fail_count=$((fail_count + 1))
  fi
fi

# ---- Phase 6 (optional): lookfeel parity harness -----------------------

if [[ "${RUN_PARITY:-0}" == "1" ]]; then
  hdr "[+] lookfeel parity harness (RUN_PARITY=1)"
  if [[ ! -d "${MAQUETTE_DIR}" ]]; then
    warn "MAQUETTE_DIR=${MAQUETTE_DIR} does not exist; parity harness will fall back to in-repo copy."
  fi
  step_count=$((step_count + 1))
  if ( cd "${REPO_ROOT}/apps/web" && \
       MAQUETTE_DIR="${MAQUETTE_DIR}" \
       npx playwright test --config=e2e/lookfeel/playwright.config.ts \
         e2e/lookfeel/12-maquette-parity.spec.ts --reporter=line ); then
    record_pass "lookfeel parity harness"
  else
    record_fail "lookfeel parity harness"
    fail_count=$((fail_count + 1))
  fi
fi

# ---- Summary -----------------------------------------------------------

hdr "summary"
log "steps run : ${step_count}"
if [[ "${fail_count}" -eq 0 ]]; then
  printf '%sPASS%s — ci-checks.sh: %d step(s) green\n' "${C_OK}" "${C_RESET}" "${step_count}"
  exit 0
else
  printf '%sFAIL%s — ci-checks.sh: %d step(s) failed\n' "${C_ERR}" "${C_RESET}" "${fail_count}"
  exit 1
fi