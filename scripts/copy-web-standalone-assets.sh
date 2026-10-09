#!/usr/bin/env bash
# copy-web-standalone-assets.sh
#
# Next.js `output: 'standalone'` writes the client chunks to the TOP-LEVEL
# `.next/static/` and the public files to `public/`, but the standalone server
# directory `.next/standalone/apps/web/` only carries the manifests +
# `server/` + `server.js` + `package.json`. Without this step the SSR HTML
# references chunks that 404 (MIME `text/plain` + `X-Content-Type-Options:
# nosniff`), so the backoffice SPA never hydrates and login breaks.
#
# Wired as the `postbuild` hook of `apps/web/package.json` so every
# `next build` (workspace or `--workspaces`) copies the assets automatically.
#
# Rollback: remove the `postbuild` entry from apps/web/package.json (the
# copied dirs are additive inside the standalone output and harmless).

set -euo pipefail

# Run from the repo root regardless of the caller's cwd. Tests can point the
# script at a synthetic repo root via COPY_WEB_STANDALONE_ROOT without
# changing the default behaviour.
if [ -n "${COPY_WEB_STANDALONE_ROOT:-}" ]; then
  REPO_ROOT="${COPY_WEB_STANDALONE_ROOT}"
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "${REPO_ROOT}/apps/web"

if [ ! -d .next/static ]; then
  echo "ERROR: apps/web/.next/static is missing — run 'next build' first." >&2
  exit 1
fi
if [ -z "$(ls -A .next/static 2>/dev/null || true)" ]; then
  echo "ERROR: apps/web/.next/static is empty — run 'next build' first." >&2
  exit 1
fi

mkdir -p .next/standalone/apps/web/.next
# `cp -rT SRC DST` (GNU coreutils; ships with Ubuntu) treats DST as the
# target directory itself, so a second run does NOT nest into
# .../static/static/. Plain `cp -r SRC DST` would copy SRC inside DST
# when DST already exists.
cp -rT .next/static .next/standalone/apps/web/.next/static

if [ -d public ]; then
  cp -rT public .next/standalone/apps/web/public
fi

echo "copy-web-standalone-assets: .next/static + public -> .next/standalone/apps/web/"
