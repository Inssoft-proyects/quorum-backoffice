# Quorum Backoffice — Handoff prompt (continuación de sesión)

Pega este bloque en una sesión nueva de Pi para retomar el trabajo.

---

# Estado del proyecto al cierre de la sesión anterior

**Quorum Backoffice MVP COMPLETO + auditoría UI/UX ejecutada + marbetes rediseñados per maquette.**

## Lo que ya está hecho (NO volver a hacer)

- ✅ **13 Work Units** entregados: WU0–WU13
- ✅ **8 commits adicionales** en `feature/wu0-bootstrap`, todos pusheados a `origin`
- ✅ **PR #1 abierto**: https://github.com/Inssoft-proyects/quorum-backoffice/pull/1
- ✅ **148/148 tests verde** (85 API + 63 web RTL unit)
- ✅ **5/5 Playwright tests del rediseño** verde
- ✅ **10 recepciones RDD** ejecutadas, todas auto-aprobadas tier `low` / non-executable
- ✅ **Build production limpio** (Next.js 16.3.5 + Turbopack, 7 rutas en `/backoffice/`)
- ✅ **nginx vhost** (`infra/nginx/quorum.asistentepro.mx.conf`) con Let's Encrypt + security headers
- ✅ **RUNBOOK.md** operativo completo
- ✅ **Marbetes rediseñados** per maquette del área de diseño (commit `98ac08f`)
- ✅ **BUG-001 resuelto** (cookie mismatch en SSR data fetches — `77e1f26` + `a5edece`)
- ✅ **Tailwind CSS utilities completas** (era bug de @source en Tailwind 4 + Turbopack — fix inline en `globals.css`)

## Commits nuevos al cierre (todos pusheados)

```
1082bb1 test(lookfeel): align 06-marbetes-design spec with implementation
642449c docs(audit): update bitácora of marbetes v2 redesign with final state
98ac08f feat(web): redesign /marbetes per design team's InecConecta maquette
e66fca9 docs(audit): update findings report with post-fix state
a5edece fix(web): make getServerSession forward the real auth cookie name
802066b chore: ignore nested design-asset repos + add BUG-001 deploy runbook
77e1f26 fix(web): forward correct auth cookie name in SSR data fetches (BUG-001)
fd97871 fix(web): resolve TypeScript errors in UI/UX audit suite
1cccb24 test(web): add UI/UX audit Playwright suite + findings report
```

## URL de acceso desde tu PC

```
https://quorum.asistentepro.mx/backoffice/login
```

- `quorum.asistentepro.mx/` → sigue mostrando Jitsi
- `quorum.asistentepro.mx/backoffice/` → el backoffice (Next.js basePath='/backoffice')
- `quorum.asistentepro.mx/backoffice/api/v1/...` → la API (nginx rewrite strip-prefix)

## Ramas

- `feature/wu0-bootstrap` (HEAD `1082bb1`): todo el trabajo
- `master` (default remoto): base vacía del repo

## Archivos clave del proyecto

```
/planQuorum/dev/quorum-backoffice/
├── apps/
│   ├── api/                    # Fastify 5 + Node 22 + PG 18 + Redis 8
│   │   ├── migrations/          # 6 migrations (0001-0006)
│   │   ├── src/                 # routes, services, repositories, plugins
│   │   └── package.json         # main: dist/src/server.js
│   └── web/                     # Next.js 16 App Router + React 19 + shadcn/ui
│       ├── app/
│       │   ├── login/           # login form real
│       │   └── (authed)/        # route group con layout que valida sesión
│       │       ├── dashboard/
│       │       ├── marbetes/    # REDISEÑADO per maquette v2 (commit 98ac08f)
│       │       ├── dispositivos/ # UI anterior, sin rediseñar
│       │       └── audit/        # UI anterior, sin rediseñar
│       ├── components/
│       │   ├── inventory/        # NEW: 10 componentes del rediseño
│       │   ├── layout/           # AppShell, Sidebar, Topbar, LogoutButton
│       │   └── ui/               # shadcn wrappers (button, card, dialog, select, textarea, ...)
│       ├── lib/
│       │   ├── api-client.ts     # fetch wrappers
│       │   ├── auth-context.ts   # client auth state
│       │   └── server-session.ts # getServerSession() + getAuthCookieHeader() (usado en SSR)
│       ├── e2e/lookfeel/         # Playwright suite (24 tests totales)
│       │   ├── 01-05 specs       # audit suite original
│       │   ├── 06-marbetes-design.spec.ts # rediseño v2 (5 tests)
│       │   └── helpers/          # a11y, contrast, login, snapshot, viewports
│       ├── app/globals.css       # tokens + @layer components maquette
│       └── next.config.ts        # basePath: '/backoffice'
├── packages/shared/             # Zod DTOs + RBAC helpers
├── infra/
│   ├── nginx/quorum.asistentepro.mx.conf
│   └── systemd/{api,web}.service
├── diseno/                      # Brand tokens + icon library + MAQUETTE del área de diseño
│   ├── design/                  # PNG/JPEG referencias (color tokens, screens mockups)
│   ├── design/png-x2/           # Iconos InecConecta
│   ├── maqueta_Inec/Inec/       # MAQUETTE HTML: inventario-credenciales.html + CSS
│   └── (legacy png-x2/, __MACOSX/ pre-existentes)
├── odd/tasks/
│   ├── quorum-backoffice-mvp.md          # plan + bitácora (13 WUs documentados)
│   ├── backoffice-ui-ux-audit.md          # plan ODD del audit
│   ├── backoffice-ui-ux-audit-findings.md # informe de hallazgos + plan de remediación
│   ├── marbetes-inventory-v2.md           # plan + bitácora del rediseño
│   └── deploy-bug-001.md                 # script de deploy con verificaciones
├── RUNBOOK.md                            # operador-facing docs
├── HANDOFF.md                            # este archivo
└── package.json                           # workspaces root (api, web, shared)
```

## Verificación al iniciar nueva sesión

```bash
cd /planQuorum/dev/quorum-backoffice
git status                    # debe estar clean en feature/wu0-bootstrap
git log --oneline | head 5    # debe terminar en 1082bb1 (marbetes v2 tests)
npm install                   # 757+ paquetes
npm test                      # 148/148 verde (corre ambos workspaces)

# Detalle por workspace:
cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs --runInBand --forceExit
cd apps/web && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs

# typecheck + lint:
cd apps/api && npm run typecheck && npm run lint
cd apps/web && npm run typecheck && npm run lint
cd apps/web && npm run build    # verifica 7 rutas

# Si Redis o PG no están vivos (en este host):
bash scripts/dev-bootstrap.sh
```

## Polish items pendientes (no bloquean MVP)

1. **Endpoint `POST /api/v1/marbetes/:id/reveal`** (Revelar marbete necesita backend). Effort M.
2. **Bulk upload endpoint** para el botón "Cargar marbetes". Effort L.
3. Migración bcrypt → argon2id (OWASP 2025+).
4. Política de archivado para `audit_log` (>1 año → cold storage).

Cerrados en Polish WU v2 (commits `e0e49c7` + `218a56a` + `8d31b0b` + 764243e en `feature/wu0-bootstrap`):
- **RESP-001 P0** (mobile responsive): AppShell con sidebar colapsable en <md.
- **A11Y-001 P1**: landmark `<header>` en card de /login.
- **VIS-002 P2**: focus-visible audit + styles en .metric-card, .sort-button, .row-action, .table-pagination__toggle.

## Decisiones técnicas heredadas (no cambiar sin discutir)

- **Port convention**: DEV 3xx (api 3100, web 3002), PROD 4xx (api 4100, web 4002)
- **Stack backend**: Node 22 + Fastify 5 + PG 18 + Redis 8 + Zod + Pino + prom-client + bcrypt cost-12
- **Stack frontend**: Next.js 16 App Router + React 19 + Tailwind 4 + shadcn/ui + lucide-react
- **Shared**: Zod DTOs en `packages/shared/src/dto/<entity>.ts`; api consume desde `dist/`
- **Audit log**: append-only enforced via `REVOKE UPDATE,DELETE,TRUNCATE FROM PUBLIC` en la migration 0004
- **OTP**: header `X-OTP-Code` (6 dígitos) en operaciones destructivas; service llama `OtpClient.verify({subject,scope,code})`
- **Roles**: admin (3) > auditor (2) > operator (1). Jerarquía numérica via `ROLE_HIERARCHY` + `hasAtLeastRole`
- **canvasUserId**: marbetes se asignan por matrícula Canvas (no por PK interno). Lookup en `students_cache` con 422 si no existe o inactivo.
- **Cookies**: `AUTH_COOKIE_NAME=__Host-sid` en prod (Secure + Path=/); tokens son 32B base64url aleatorios
- **Server-side cookie forwarding**: TODAS las pages autenticadas DEBEN usar `await getAuthCookieHeader()` de `@/lib/server-session` para llamadas API (verificado en `app/(authed)/{marbetes,dispositivos,audit}/page.tsx`)
- **Next.js build env**: `NEXT_PUBLIC_API_URL=https://quorum.asistentepro.mx/backoffice` debe estar seteado en build time (se inlinea en el bundle)
- **Tailwind 4 + Turbopack**: requiere `@source` directives explícitas en `globals.css` para detectar utilities (verificado en commit `802066b`)
- **Review budget**: ≤400 líneas por WU
- **RDD aplicado**: 10 recepciones exitosas, todas tier `low` / non-executable doc-only. Para feat commits: lenses R1-R4.

## Próximos pasos sugeridos (elegir uno)

### A) Merge PR #1 + deploy en VPS
```bash
gh pr merge 1 --squash   # o rebase + merge según preferencia
# Una vez mergeado a master, en el VPS:
cd /opt/quorum-backoffice && git pull
npm install && npm run --workspaces --if-present build
cd apps/api && npm run migrate
# Configurar env files en /etc/quorum-backoffice/ (ver infra/nginx/README.md §3)
# Habilitar vhost + certbot (ver infra/nginx/README.md §6-§7)
# Habilitar systemd units (ver infra/nginx/README.md §5)
sudo systemctl enable --now quorum-backoffice-api quorum-backoffice-web
```

### B) Polish WU v3 (reveal endpoint + bulk upload + bcrypt→argon2id + audit_log archival)
Cualquier combinación de los 4 polish items restantes arriba (en orden: endpoint reveal, bulk upload, bcrypt→argon2id, audit_log archival).

### C) Endpoint faltante: POST /api/v1/marbetes/:id/reveal
Implementar en `apps/api/src/routes/marbetes.ts` con la firma:
```ts
POST /api/v1/marbetes/:id/reveal
Body: { otpCode?: string }  // OTP solo si AUTH_OTP_REQUIRED=true
Response: { code: string }  // código completo
```
Side effect: insert en `audit_log` con action='marbete.reveal', metadata con motivo.
Después wire-ar `RevealMarbeteDialog` para llamar al endpoint.

### D) Continuar con redesign de /dispositivos y /audit
Aplicar el mismo patrón de componentes inventory/* a las otras 2 pantallas.

### E) Cerrar el ciclo RDD review
Correr `gentle_review inspect` + `start` para los 8 commits nuevos. El user debe dar consent en la UI host-owned.

## Convenciones para nuevas sesiones

- **RDD**: si commiteas trabajo, el harness recordará el candidate unreviewed. Ejecutar `gentle_review inspect` + `start` (los doc-only commits se auto-aprueban; los feat commits necesitan lentes reales).
- **Multi-file edits**: el harness bloquea edits inline cuando ya tocaste un archivo. Delegar a `gentle-ai-worker` con `## Allowed edit surfaces` heading explícito + paths canónicos uno por línea.
- **Worker timeout**: los workers pueden colgarse en bash por 30+ min. Si pasa, verificar `git status` y terminar manualmente.
- **Tests verification**: siempre re-correr tests/typecheck/lint localmente después de una delegación (los workers reportan success pero vale confirmar).
- **PR**: `gh pr create --base master --head feature/wu0-bootstrap` (master es el default branch de este repo, no main).
- **Deploy staging**: `cp /planQuorum/.../apps/web/components/inventory/* /opt/quorum-backoffice/apps/web/components/inventory/` después `cd /opt/quorum-backoffice/apps/web && sudo -E env NEXT_PUBLIC_API_URL=https://quorum.asistentepro.mx/backoffice npm run build` después `kubectl delete pod -n quorum-backoffice <web-pod> --force --grace-period=0`. Esperar ~25s y validar con curl.
- **Sesión Pi**: tiene acceso SSH al cluster k3s pero NO al VPS de prod. Deploy a prod es manual.

## Bitácora viva

`odd/tasks/quorum-backoffice-mvp.md` §12 tiene el estado de los 13 WUs originales.
`odd/tasks/marbetes-inventory-v2.md` §8 tiene el estado del rediseño v2.
`odd/tasks/backoffice-ui-ux-audit.md` tiene el plan del audit.
`odd/tasks/backoffice-ui-ux-audit-findings.md` tiene los hallazgos + plan de remediación.

Actualizar después de cada WU cerrado (es ODD rule).

## Memoria de decisiones clave

Topics Engram activos (recuperar con `mem_search --topic_key`):
- `quorum-backoffice` — overview del proyecto
- `quorum-backoffice-cookie-name-mismatch` — bug BUG-001 (resuelto)
- `quorum-backoffice-ui-ux-audit` — hallazgos originales del audit
- `quorum-backoffice-marbetes-v2-inventory` — rediseño del inventario
- `quorum-backoffice-session-2026-09-23` — snapshot al cierre de esta sesión

---

# PROMPT REUTILIZABLE — para pegar al iniciar nueva sesión Pi

```
Continuá el trabajo del Quorum Backoffice. Contexto:

- Repo: /planQuorum/dev/quorum-backoffice (git)
- Branch: feature/wu0-bootstrap (HEAD 1082bb1, pusheado)
- PR abierto: https://github.com/Inssoft-proyects/quorum-backoffice/pull/1
- Staging: https://quorum.asistentepro.mx/backoffice/ (k3s cluster, deploy manual vía sync a /opt/quorum-backoffice + kubectl delete pod)
- Documentación viva:
  - HANDOFF.md (este archivo) — punto de entrada
  - odd/tasks/quorum-backoffice-mvp.md §12 — bitácora 13 WUs originales
  - odd/tasks/marbetes-inventory-v2.md §8 — bitácora rediseño v2
  - odd/tasks/backoffice-ui-ux-audit-findings.md — hallazgos + plan de remediación
- Memoria Engram: buscar con topic_key 'quorum-backoffice' o 'quorum-backoffice-marbetes-v2-inventory'

Lo que ya está hecho:
- MVP completo con 148/148 tests verde
- Marbetes rediseñados per maquette (UI v2 con 4 metric cards, donut charts, 3 dialogs)
- BUG-001 (cookie mismatch) resuelto
- Tailwind CSS utilities completas (bug @source resuelto)

[REEMPLAZAR ESTA SECCIÓN CON LA ACTIVIDAD ESPECÍFICA QUE NECESITÉS]

Por ejemplo:
- "Implementá RESP-001 (AppShell mobile responsive). Esfuerzo M. Pattern de referencia en la maquette del área de diseño."
- "Implementá el endpoint POST /api/v1/marbetes/:id/reveal y wire-ar el RevealMarbeteDialog."
- "Aplicá el rediseño de marbetes a /dispositivos y /audit siguiendo el mismo patrón."
- "Cerrá el RDD review sobre los 8 commits nuevos. Gentile-ai review mode status está on (global)."
- "Mergéá PR #1 con gh pr merge 1 --squash y verificá el deploy en VPS."

Procedé y no pares hasta terminar. Si necesitás algo, preguntá.
```

---

# Si necesitás pedirle al modelo nuevo que ejecute algo concreto

Pegá una línea como estas y el contexto está completo:

> "Continuá con el polish item RESP-001 (AppShell mobile responsive). Esfuerzo M. La rama es `feature/wu0-bootstrap`, los tests están verdes, el PR #1 sigue abierto. Las metric cards del rediseño ya están implementadas en `apps/web/components/inventory/`."

> "Implementá el endpoint `POST /api/v1/marbetes/:id/reveal` y conectá el `RevealMarbeteDialog` para que llame al backend. Esfuerzo M."

> "Aplicá el rediseño de marbetes v2 al screen `/dispositivos` siguiendo el mismo patrón de componentes inventory/. Reusá MetricCard, DonutChart, StatusChip, IdBadge, MaskedNumber, SortHeader, Pagination."

> "Cerrá el RDD review sobre los 8 commits nuevos de la rama `feature/wu0-bootstrap`."
