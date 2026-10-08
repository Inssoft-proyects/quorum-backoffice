#!/usr/bin/env bash
# test-copy-web-standalone-assets.sh
#
# Smoke test for scripts/copy-web-standalone-assets.sh
#
# Asserts:
#   1. .next/static + public are copied into .next/standalone/apps/web/.
#   2. Running the script a second time is idempotent: NO `static/static/`
#      nesting appears in the destination tree.
#   3. An empty .next/static directory fails with a clear stderr message.
#
# The script under test honours the COPY_WEB_STANDALONE_ROOT env var to
# relocate the repo root, so this test points it at a synthetic fixture
# without touching the real apps/web directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="${SCRIPT_DIR}/copy-web-standalone-assets.sh"

if [ ! -x "${SCRIPT_UNDER_TEST}" ]; then
  echo "ERROR: ${SCRIPT_UNDER_TEST} not found or not executable." >&2
  exit 1
fi

# --- Fixture: a synthetic repo root with apps/web/{.next/static,public} ----
FIXTURE_ROOT="$(mktemp -d -t copy-web-standalone-assets.XXXXXX)"
EMPTY_ROOT="$(mktemp -d -t copy-web-standalone-assets-empty.XXXXXX)"
trap 'rm -rf "${FIXTURE_ROOT}" "${EMPTY_ROOT}"' EXIT

mkdir -p "${FIXTURE_ROOT}/apps/web/.next/static"
mkdir -p "${FIXTURE_ROOT}/apps/web/public"
printf '/* static asset */\n' > "${FIXTURE_ROOT}/apps/web/.next/static/chunk.css"
printf 'static-only-file'      > "${FIXTURE_ROOT}/apps/web/.next/static/only-here.txt"
printf 'png-bytes'             > "${FIXTURE_ROOT}/apps/web/public/favicon.png"

DEST_STATIC="${FIXTURE_ROOT}/apps/web/.next/standalone/apps/web/.next/static"
DEST_PUBLIC="${FIXTURE_ROOT}/apps/web/.next/standalone/apps/web/public"

# --- Run 1: cold copy ------------------------------------------------------
COPY_WEB_STANDALONE_ROOT="${FIXTURE_ROOT}" bash "${SCRIPT_UNDER_TEST}" >/dev/null

if [ ! -f "${DEST_STATIC}/chunk.css" ]; then
  echo "FAIL: ${DEST_STATIC}/chunk.css missing after first run" >&2
  exit 1
fi
if [ ! -f "${DEST_STATIC}/only-here.txt" ]; then
  echo "FAIL: ${DEST_STATIC}/only-here.txt missing after first run" >&2
  exit 1
fi
if [ ! -f "${DEST_PUBLIC}/favicon.png" ]; then
  echo "FAIL: ${DEST_PUBLIC}/favicon.png missing after first run" >&2
  exit 1
fi

# --- Run 2: idempotency (must NOT nest static/static) ---------------------
COPY_WEB_STANDALONE_ROOT="${FIXTURE_ROOT}" bash "${SCRIPT_UNDER_TEST}" >/dev/null

if [ -d "${DEST_STATIC}/static" ]; then
  echo "FAIL: idempotency broken — ${DEST_STATIC}/static exists (nested copy)" >&2
  exit 1
fi
if [ ! -f "${DEST_STATIC}/chunk.css" ]; then
  echo "FAIL: ${DEST_STATIC}/chunk.css missing after second run" >&2
  exit 1
fi
if [ ! -f "${DEST_PUBLIC}/favicon.png" ]; then
  echo "FAIL: ${DEST_PUBLIC}/favicon.png missing after second run" >&2
  exit 1
fi

# --- Empty .next/static must fail loudly ----------------------------------
mkdir -p "${EMPTY_ROOT}/apps/web/.next/static"
mkdir -p "${EMPTY_ROOT}/apps/web/public"
printf 'png-bytes' > "${EMPTY_ROOT}/apps/web/public/favicon.png"

set +e
COPY_WEB_STANDALONE_ROOT="${EMPTY_ROOT}" bash "${SCRIPT_UNDER_TEST}" \
  >"${EMPTY_ROOT}/stdout" 2>"${EMPTY_ROOT}/stderr"
empty_status=$?
set -e

if [ "${empty_status}" -eq 0 ]; then
  echo "FAIL: empty .next/static did not cause a non-zero exit" >&2
  exit 1
fi
if ! grep -qi "empty" "${EMPTY_ROOT}/stderr"; then
  echo "FAIL: empty .next/static did not mention 'empty' in stderr" >&2
  echo "--- stderr ---" >&2
  cat "${EMPTY_ROOT}/stderr" >&2
  exit 1
fi

echo "OK: copy-web-standalone-assets.sh is idempotent and validates inputs"
