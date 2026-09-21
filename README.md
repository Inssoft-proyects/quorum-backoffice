# Quorum Backoffice

Administrative backoffice for the Quorum suite. Owns the physical security
surface (security badges / "marbetes", authorized devices) and the audit
trail of every privileged action.

> Status: WU0 bootstrap in progress (this commit). See
> `odd/tasks/quorum-backoffice-mvp.md` for the full implementation plan and
> work-unit breakdown.

## Repository layout

```
quorum-backoffice/
├── apps/
│   ├── api/           # Fastify 5 + TS admin API (port 3001)
│   └── web/           # Next.js 15 + shadcn/ui admin UI (port 3002)
├── packages/
│   └── shared/        # Zod DTOs shared between API and web
├── scripts/
│   └── dev-bootstrap.sh   # Idempotent local env setup (Redis + PG)
├── odd/
│   └── tasks/
│       └── quorum-backoffice-mvp.md   # ODD plan
└── diseno/            # Brand tokens + icon library (InecConecta)
```

## Prerequisites

- Node.js ≥ 22.22.1
- PostgreSQL ≥ 18 (local)
- Redis (installed by `scripts/dev-bootstrap.sh` if missing)

## Quickstart (local)

```bash
# 1. Bootstrap local services and databases (idempotent)
bash scripts/dev-bootstrap.sh

# 2. Configure env (root + apps/api + apps/web)
cp .env.example .env
cp apps/api/env.example apps/api/.env
cp apps/web/env.example apps/web/.env.local
# Edit and replace SESSION_SECRET, OTP_SERVICE_TOKEN, etc.

# 3. Install
npm install

# 4. Run tests
npm test                  # unit
npm run test:integration  # integration (real PG + Redis)

# 5. Develop
npm run -w @quorum-backoffice/api dev    # API on :3001
npm run -w @quorum-backoffice/web dev    # Web on :3002
```

## Quality gates

- `npm run typecheck` — strict TypeScript across all workspaces
- `npm run lint` — ESLint
- `npm run format:check` — Prettier
- `npm test` — Jest unit (mocked dependencies)
- `npm run test:integration` — Jest integration (real PG + Redis)

Coverage targets mirror `quorum-otp`: lines/functions/statements ≥ 80%,
branches ≥ 70%.

## Work-unit roadmap

See `odd/tasks/quorum-backoffice-mvp.md`. Work units (WU0…WU9) each
fit within a single PR for review workload. WU0 is the bootstrap you are
looking at. WU1 wires the InecConecta design system; WU2 lands the
schema; WU3–WU6 ship the API surface; WU7–WU9 land the screens.

## License

Internal project; license TBD by Quorum suite maintainers.
