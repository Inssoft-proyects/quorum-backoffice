#!/usr/bin/env bash
#
# smoke.sh — probe the Quorum ecosystem health (TLS + HTTP + nginx + ports).
# Bundle of the `quorum-smoke` skill. Read-only.
#
# Usage: bash smoke.sh
# Exit: 0 all green/check, 1 any red (no response or 5xx).

set -uo pipefail

PROBES=(
  "monitor.inecuni.com|/api/v1/auth/me"
  "monitor.inecuni.com|/login"
  "backoffice.inecuni.com|/backoffice/login"
  "otp.inecuni.com|/ui/"
  "otp.inecuni.com|/readyz"
  "lms.inecuni.com|/login/canvas"
  "quorum.inecuni.com|/"
  "secret.inecuni.com|/"
)

red=0
printf "%-26s %-22s %-6s %s\n" "HOST" "PATH" "CODE" "VERDICT"
for p in "${PROBES[@]}"; do
  host="${p%%|*}"
  path="${p##*|}"
  code=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' -H "Host: $host" "https://127.0.0.1$path" 2>/dev/null || echo 000)
  case "$code" in
    2*|3*|401) verdict="green" ;;
    000)       verdict="red (no response)"; red=1 ;;
    5*)        verdict="red ($code)"; red=1 ;;
    *)         verdict="check" ;;
  esac
  printf "%-26s %-22s %-6s %s\n" "$host" "$path" "$code" "$verdict"
done

echo "--- nginx -t ---"
sudo -n nginx -t 2>&1 | tail -2

echo "--- public listeners ---"
ss -ltn 2>/dev/null | awk 'NR==1 || /:(80|443|3000|4100|4200|6443|9100)[[:space:]]/'

exit "$red"
