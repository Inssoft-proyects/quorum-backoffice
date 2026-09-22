# Quorum Backoffice — Handoff prompt (continuación de sesión)

Pega este bloque en una sesión nueva de Pi para retomar el trabajo.

---

# Estado del proyecto al cierre de la sesión anterior

**Quorum Backoffice MVP COMPLETO + infraestructura de producción montada en `/backoffice/` bajo `quorum.asistentepro.mx`.**

## Lo que ya está hecho (NO volver a hacer)

- ✅ **13 Work Units** entregados: WU0–WU13
- ✅ **36 commits** en `feature/wu0-bootstrap`, todos pusheados a `origin`
- ✅ **PR #1 abierto**: https://github.com/Inssoft-proyects/quorum-backoffice/pull/1
- ✅ **148/148 tests verde** (85 API integration + 63 web RTL unit)
- ✅ **10 recepciones RDD** ejecutadas, todas auto-aprobadas tier `low` / non-executable
- ✅ **Build production limpio** (Next.js 16.3.5 + Turbopack, 7 rutas en `/backoffice/`)
- ✅ **nginx vhost** (`infra/nginx/quorum.asistentepro.mx.conf`) con Let's Encrypt + security headers
- ✅ **RUNBOOK.md** operativo completo

## URL de acceso desde tu PC

```
https://quorum.asistentepro.mx/backoffice/login
```

- `quorum.asistentepro.mx/` → sigue mostrando Jitsi
- `quorum.asistentepro.mx/backoffice/` → el backoffice (Next.js basePath='/backoffice')
- `quorum.asistentepro.mx/backoffice/api/v1/...` → la API (nginx rewrite strip-prefix)

## Ramas

- `feature/wu0-bootstrap` (HEAD): todo el trabajo, 36 commits
- `master` (default remoto): base vacía del repo

## Archivos clave del proyecto

```
/planQuorum/dev/quorum-backoffice/
├── apps/
│   ├── api/                    # Fastify 5 + Node 22 + PG 18 + Redis 8
│   │   ├── migrations/          # 6 migrations (0001-0006)
│   │   ├── src/                 # routes, services, repositories, plugins
│   │   └── package.json         # "main": "dist/server.js"  ← BUG: tsc outputs to dist/src/server.js
│   └── web/                     # Next.js 15 App Router + React 19 + shadcn/ui
│       ├── app/
│       │   ├── login/           # login form real
│       │   └── (authed)/        # route group con layout que valida sesión
│       │       ├── dashboard/
│       │       ├── marbetes/    # CRUD completo (WU8)
│       │       ├── dispositivos/ # CRUD completo (WU9)
│       │       └── audit/       # viewer read-only (WU10)
│       ├── components/          # layout + shadcn/ui wrappers
│       ├── lib/                 # api-client, server-session, auth-context
│       ├── e2e/                 # Playwright (7 tests, autor + config-valid)
│       └── next.config.ts       # basePath: '/backoffice'
├── packages/shared/             # Zod DTOs + RBAC helpers
├── infra/
│   └── nginx/
│       ├── quorum.asistentepro.mx.conf   # vhost (104 LOC)
│       └── README.md                     # operational guide (224 LOC)
├── RUNBOOK.md                    # operator-facing docs
├── HANDOFF.md                    # este archivo
├── odd/
│   ├── tasks/quorum-backoffice-mvp.md  # plan + bitácora (13 WUs documentados)
│   └── status-snapshot-2025-11-21.md  # snapshot del estado al cierre de WU11
└── package.json                   # workspaces root (api, web, shared)
```

## Verificación al iniciar nueva sesión

```bash
cd /planQuorum/dev/quorum-backoffice
git status                    # debe estar clean en feature/wu0-bootstrap
git log --oneline | head 5    # debe terminar en 94cbac8 (WU13) o más reciente
npm install                   # 757+ paquetes
npm test                      # 148/148 verde (corre ambos workspaces)

# Detalle por workspace:
cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs --runInBand --forceExit
cd apps/web && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs

# typecheck + lint:
cd apps/api && npm run typecheck && npm run lint
cd apps/web && npm run typecheck && npm run lint
cd apps/web && npm run build    # verifica 7 rutas

# Si Redis o PG no están vivos:
bash scripts/dev-bootstrap.sh
```

## Polish items pendientes (no bloquean MVP)

Estos son opcionales y pueden hacerse en WUs de polish posteriores:

1. **apps/api `package.json` `main`**: cambiar de `dist/server.js` a `dist/src/server.js`. El systemd unit del nginx README ya usa el path correcto (`/usr/bin/node dist/src/server.js`), pero `npm start` directo fallaría. Fix trivial de 1 línea.
2. **infra/systemd/ como archivos**: los unit templates para api+web están inline en `infra/nginx/README.md` §5. Extraerlos a `infra/systemd/quorum-backoffice-{api,web}.service` como archivos committed.
3. **ESLint flat config para apps/web**: `next lint` fue removido en Next.js 16. El lint script actual es un placeholder `tsc --noEmit`. Para restaurar ESLint real: `npm install -D eslint eslint-config-next` + crear `apps/web/eslint.config.js` flat config.
4. **Playwright e2e seed script**: los 7 tests de Playwright están authored + config-valid, pero requieren usuarios seed (admin/operator/auditor con bcrypt hashes) para ejecutarse de verdad. Automatizar el seed en un script.
5. **Migración bcrypt → argon2id**: bcrypt cost-12 está bien para 2025, pero argon2id es OWASP-recomendado. Migration script + auth-service update.
6. **Política de archivado para audit_log**: >1 año → cold storage. La tabla crece sin límite; necesita partition strategy o archival job.

## Decisiones técnicas heredadas (no cambiar sin discutir)

- **Port convention**: DEV 3xx (api 3100, web 3002), PROD 4xx (api 4100, web 4002)
- **Stack backend**: Node 22 + Fastify 5 + PG 18 + Redis 8 + Zod + Pino + prom-client + bcrypt cost-12
- **Stack frontend**: Next.js 15 App Router + React 19 + Tailwind 4 + shadcn/ui + lucide-react
- **Shared**: Zod DTOs en `packages/shared/src/dto/<entity>.ts`; api consume desde `dist/`
- **Audit log**: append-only enforced via `REVOKE UPDATE,DELETE,TRUNCATE FROM PUBLIC` en la migration 0004
- **OTP**: header `X-OTP-Code` (6 dígitos) en operaciones destructivas; service llama `OtpClient.verify({subject,scope,code})`
- **Roles**: admin (3) > auditor (2) > operator (1). Jerarquía numérica via `ROLE_HIERARCHY` + `hasAtLeastRole`
- **canvasUserId**: marbetes se asignan por matrícula Canvas (no por PK interno). Lookup en `students_cache` con 422 si no existe o inactivo.
- **Cookies**: `AUTH_COOKIE_NAME=__Host-sid` en prod (Secure + Path=/); tokens son 32B base64url aleatorios
- **Review budget**: ≤400 líneas por WU; exceder legítimamente (ej. WU3a/b, WU6a, WU8b2)
- **RDD aplicado**: 10 recepciones exitosas, todas tier `low` / non-executable doc-only. Si el usuario pide más review explícito de código de features, abrir PR con lenses R1-R4.

## Próximos pasos sugeridos (elegir uno)

### A) Mergear PR + desplegar en VPS
```bash
# Una vez mergeado a master, en el VPS:
cd /opt/quorum-backoffice && git pull
npm install && npm run --workspaces --if-present build
cd apps/api && npm run migrate
# Configurar env files en /etc/quorum-backoffice/ (ver infra/nginx/README.md §3)
# Habilitar vhost + certbot (ver infra/nginx/README.md §6-§7)
# Habilitar systemd units (ver infra/nginx/README.md §5)
sudo systemctl enable --now quorum-backoffice-api quorum-backoffice-web
```

### B) Polish WU (ESLint + systemd files + dist path fix)
Cualquier combinación de los 6 polish items arriba.

### C) Continuar features
El MVP cubre todos los features del plan §2. Si el usuario quiere features nuevas (ej. notificaciones por email de eventos de auditoría, multi-tenant, integración con quorum-otp en lugar de mock), son WUs nuevos.

## Convenciones para nuevas sesiones

- **RDD**: si commiteas trabajo, el harness recordará el candidate unreviewed. Ejecutar `gentle_review inspect` + `start` (los doc-only commits se auto-aprueban; los feat commits necesitan lentes reales).
- **Multi-file edits**: el harness bloquea edits inline cuando ya tocaste un archivo. Delegar a `gentle-ai-worker` con `## Allowed edit surfaces` heading explícito + paths canónicos uno por línea.
- **Worker timeout**: los workers pueden colgarse en bash por 30+ min. Si pasa, verificar `git status` y terminar manualmente.
- **Tests verification**: siempre re-correr tests/typecheck/lint localmente después de una delegación (los workers reportan success pero vale confirmar).
- **PR**: `gh pr create --base master --head feature/wu0-bootstrap` (master es el default branch de este repo, no main).

## Bitácora viva

`odd/tasks/quorum-backoffice-mvp.md` §12 tiene el estado actual de los 13 WUs con commit hashes. Actualizar después de cada WU cerrado (es ODD rule).

## Memoria de decisiones clave

Las decisiones arquitectónicas están guardadas en `mem_save` con `topic_key` por WU (`quorum-backoffice-wu{N}-{concern}`). Recuperar contexto con `mem_search` + `topic_key` específico.

---

# Si necesitás pedirle al modelo nuevo que ejecute algo concreto

Pegá una línea como estas y el contexto está completo:

> "Continuá con el polish WU: ESLint flat config en apps/web + extraer infra/systemd/ como archivos. La rama es `feature/wu0-bootstrap`, los tests están verdes (148/148), el PR #1 sigue abierto."

> "Mergéá el PR #1 con `gh pr merge --squash` y abrí la siguiente sesión desde master."

> "Hacé el polish item 1: cambiar `apps/api/package.json` `main` de `dist/server.js` a `dist/src/server.js` y commiteá."
