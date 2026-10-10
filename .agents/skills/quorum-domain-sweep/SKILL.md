---
name: quorum-domain-sweep
description: "Trigger: domain drift, legacy host, quorum.asistentepro.mx, 301 loop, rename domain. Reconcile legacy domains to the inecuni.com canon across the Quorum workspaces."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use when a Quorum service, script, test, or runbook still points at a retired hostname
(`*.quorum.asistentepro.mx`) or when a 301/redirect chain appears.

## Hard Rules

- Read-only until the user authorizes committing the sweep.
- Never rewrite historical references that are explicitly marked as historical.
- Verify against the live host before declaring the sweep complete.

## Decision Gates

| Match | Class | Action |
| --- | --- | --- |
| active config/script/test/runbook | live | update to the `inecuni.com` canon |
| changelog / incident report | historical | leave, keep the date context |
| secrets / creds file | sensitive | do not edit; report for manual action |

## Execution Steps

1. Sweep every workspace:
   `grep -rn "quorum.asistentepro.mx" /planQuorum/dev --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist`.
2. Classify each hit (active vs historical vs sensitive) using the gates above.
3. Fix active hits: vhosts, `*.sh`, `*.mjs`, `*.ts`, runbooks, `playwright.config.*`, defaults.
4. Verify on the host: `curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: <fqdn>.inecuni.com' https://127.0.0.1/<path>`
   must not 301 to a legacy host.
5. Report the count per workspace and the remaining historical/sensitive hits.

## Output Contract

- Table: workspace, active hits fixed, historical left, sensitive flagged.
- Live verification result (no 301 to the legacy canon).

## References

- `/planQuorum/dev/odd/tasks/quorum-ecosystem-remediation-plan.md` (H5, P2.x)
