#!/usr/bin/env bash
#
# sweep.sh — list legacy-domain references across every Quorum workspace.
# Bundle of the `quorum-domain-sweep` skill. Read-only.
#
# Usage: bash sweep.sh [legacy-token]
# Default token: quorum.asistentepro.mx

set -uo pipefail

LEGACY="${1:-quorum.asistentepro.mx}"
ROOT="/planQuorum/dev"

EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next
  --exclude-dir=dist --exclude-dir=coverage --exclude-dir=test-results
  --exclude-dir=.codegraph --exclude-dir=playwright-report
)

echo "legacy token: $LEGACY"
echo "--- hits per workspace ---"
grep -rn "$LEGACY" "$ROOT" "${EXCLUDES[@]}" 2>/dev/null \
  | sed "s#$ROOT/##" \
  | awk -F: '{print $1}' \
  | awk -F/ '{print $1}' \
  | sort | uniq -c | sort -rn

total=$(grep -rn "$LEGACY" "$ROOT" "${EXCLUDES[@]}" 2>/dev/null | wc -l)
echo "--- total hits: $total ---"
echo "Classify each hit as active / historical / sensitive before editing (see SKILL.md)."
