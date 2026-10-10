---
name: quorum-k3s-deploy
description: "Trigger: deploy, rollout, apply to production, release a Quorum service on k3s. Build, deploy, set configmap or secret env, roll out, verify and roll back a Quorum service."
license: Apache-2.0
metadata:
  author: inssoft-quorum
  version: "1.0"
---

## Activation Contract

Use when deploying or rolling out a Quorum service on the live k3s cluster
(host `quorum`, 216.225.193.226; user `websop` with passwordless sudo).

## Hard Rules

- Production mutation: require explicit user authorization before any `kubectl apply/patch/rollout`.
- Always snapshot before replacing code: `cp -a src src.rollback-<ts>` (same for `dist`).
- Never deploy `origin/main` over a hostPath tree that carries uncommitted/foreign work: diff first.
- `kubectl` here is k3s: `sudo k3s kubectl -n <ns> ...`.

## Decision Gates

| Deploy shape | Detect | Action |
| --- | --- | --- |
| hostPath workspace | `volumes[].hostPath` + `node dist/server.js` | patch sources on the host, `npm run build`, restart |
| custom image | `image` not `node:*` | build/push the image, bump the tag |
| static UI / vhost | `/etc/nginx/sites-available/*` | edit the vhost, `sudo nginx -s reload` |

## Execution Steps

1. `sudo k3s kubectl get deploy -A` -> identify namespace, deployment, image, and env source
   (`envFrom`, or per-key `configMapKeyRef`/`secretKeyRef`).
2. Snapshot code and data (`cp -a`; `pg_dumpall`/`kubectl get secret -A -o yaml` when data changes).
3. Apply the change (source delta + `npm run build`, or a manifest edit).
4. Env: `kubectl -n <ns> patch cm <name> --type merge -p '{"data":{...}}'`; when adding a new key,
   add the matching `env` entry (`configMapKeyRef`) which triggers the rollout.
5. `sudo k3s kubectl -n <ns> rollout status deploy/<name> --timeout=150s`.
6. Verify with `readyz` plus the relevant sibling skill (K3 smoke / K1 OTP triage).
7. Rollback: restore the snapshot, revert env, `rollout restart`.

## Gotchas

- `hostNetwork`+`hostPort` with RollingUpdate deadlocks -> use `Recreate`.
- nginx reload is `sudo nginx -s reload`, NOT `systemctl reload nginx` (Debian unit).
- `NEXT_PUBLIC_*` is build-time; Next standalone needs `.next/static` + `public` copied.
- A hostPath tree is not a git repo: changes are untracked, so snapshots are the only rollback.

## Output Contract

- Deployment name, image, env source, rollback path, and the verification result.

## References

- `/planQuorum/dev/quorum-otp/docs/f5-deploy-runbook.md`
- `/planQuorum/dev/odd/tasks/otp-skip-scope-match-prod-enable.md`
