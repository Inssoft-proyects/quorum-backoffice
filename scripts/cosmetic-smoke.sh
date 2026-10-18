#!/usr/bin/env bash
# Cosmetic browser smoke: build the standalone web against the local stub API
# and run the Playwright suite in e2e/cosmetic. Nothing real is contacted.
set -euo pipefail

cd "$(dirname "$0")/../apps/web"

# Deliberately NOT setting NEXT_PUBLIC_API_URL: this is the production
# topology that broke (bundle built without it). The browser must call the
# same origin and the Next rewrite must proxy /api to the stub.
unset NEXT_PUBLIC_API_URL
export API_INTERNAL_URL="http://127.0.0.1:3211"

npm run build
npx playwright test --config e2e/cosmetic/playwright.config.ts "$@"
