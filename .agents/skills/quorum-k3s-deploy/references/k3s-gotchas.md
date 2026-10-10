# k3s / nginx gotchas (host `quorum`, 216.225.193.226)

Use with the `quorum-k3s-deploy` skill.

- **kubectl is k3s**: `sudo k3s kubectl -n <ns> ...`. A plain `kubectl` may lack the context.
- **nginx reload**: `sudo nginx -s reload`. Do NOT `systemctl reload nginx` (the Debian unit
  does not reload the way you expect here).
- **hostPath deployments**: the container mounts a host directory (e.g.
  `/opt/quorum-otp` -> `/opt/qb-otp`) and runs `node dist/server.js`. The tree is NOT a git
  repo: snapshot `src`/`dist` before editing; the running process keeps the old code in memory
  until a restart/rollout.
- **Env wiring**: check whether the deployment uses `envFrom` or per-key
  `configMapKeyRef`/`secretKeyRef`. Adding a new env key usually requires BOTH the ConfigMap
  key AND a matching `env` entry on the container (the latter triggers the rollout).
- **Recreate vs RollingUpdate**: `hostNetwork` + `hostPort` with RollingUpdate deadlocks
  (the new pod cannot bind the port while the old holds it) -> use `strategy: Recreate`.
- **Next.js**: `NEXT_PUBLIC_*` is build-time; `output: 'standalone'` needs `.next/static` +
  `public` copied into the standalone tree.
- **Rollback**: restore the snapshot, revert the env key, `rollout restart`. There is no git
  history for a hostPath tree, so the snapshot IS the rollback.
