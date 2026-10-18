#!/usr/bin/env bash
# Cosmetic browser smoke: build the standalone web against the local stub API
# and run the Playwright suite in e2e/cosmetic. Nothing real is contacted.
set -euo pipefail

cd "$(dirname "$0")/../apps/web"

export NEXT_PUBLIC_API_URL="http://127.0.0.1:3211"

npm run build
npx playwright test --config e2e/cosmetic/playwright.config.ts "$@"
