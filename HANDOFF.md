# Quorum Backoffice — Handoff prompt (continuación de sesión)

Pega este bloque en una sesión nueva de Pi para retomar el trabajo.

---

# Estado actual al cierre de la sesión (2026-09-26)

> Esta sección reemplaza las anteriores — refleja el master actual con
> el merge de `feature/backoffice-maquette-parity`. La auditoría UI/UX
> mencionada más abajo ya está cerrada e integrada.

## Working tree

- **Rama**: `master` (tracking `origin/master`).
- **HEAD**: `c85bb41 Merge feature/backoffice-maquette-parity into master`.
- **Branch base del feature merged**: `feature/backoffice-maquette-parity`
  (16 commits ahead, merged con `--no-ff`).
- **Estado**: clean. `git status` no muestra cambios sin commitear en
  archivos tracked. `.codegraph/` y `test-results/` siguen untracked
  (artefactos del IDE / runner, no parte del repo).
- **Deploy activo**: pod `quorum-backoffice-web-f6d9dd77-dwwxs` (1/1)
  sirviendo `c85bb41` en `https://backoffice.quorum.asistentepro.mx`.
  Bundle construido con `NEXT_PUBLIC_API_URL=https://backoffice.quorum.asistentepro.mx`.

## Lo que está integrado en master ahora

- ✅ **Paridad visual contra la maqueta Inec** en las 4 pantallas authed
  (Inicio / Marbetes / Dispositivos / Auditoría). Score oficial medido
  contra el bundle de producción con Playwright:
  - `/backoffice/marbetes`     96.68% hybrid
  - `/backoffice/dispositivos` 96.91% hybrid
  - `/backoffice/audit`        96.86% hybrid
  - `/backoffice/dashboard`    98.01% hybrid
  - **TOTAL 97.11%** con PARITY_THRESHOLD=95 y 42/42 chequeos
    estructurales pasados. Spec: `apps/web/e2e/lookfeel/12-maquette-parity.spec.ts`.
- ✅ **Tokens InecConecta** alineados (`--color-primary-500: #AB8620`,
  `--color-secondary-500: #358456`, `--space-*`, `--font-size-*`).
- ✅ **Donut charts** posicionados en la esquina inferior derecha de cada
  metric card (coincide con la maqueta canónica).
- ✅ **Footer de tabla sticky**: la pagination de marbetes/dispositivos/audit
  queda siempre visible al fondo del viewport (chrome + cards + search
  fijos; solo la tabla scrollea).
- ✅ **Privacy chip solo-ícono**: la columna "No. Marbete" muestra solo
  el icono Eye/EyeOff (sin texto "Oculto"/"Revelado"); `aria-label`
  preservado.
- ✅ **Row heights uniformes**: las 7 celdas de cada fila miden 96px
  (Fecha de carga dejó de colapsar a 54px por un utility auto-generada
  de Tailwind 4 / Turbopack).

## Historial reciente

- `c85bb41` Merge feature/backoffice-maquette-parity into master
- `df4c0ac` feat(web): privacy chip icon-only, unified row heights, sticky table footer
- `5bc6e91` feat(web): align metric-cards to maquette canon (drop padding-inline-end, add --space-*, --font-size-*)
- `626ca92` docs(odd): documentar topología k8s y accidente del 26-sep
- `9109ed7` docs(odd): close backoffice-maquette-parity with evidence (97.22% parity)
- `5637194` docs(odd): track backoffice-maquette-parity feature
- `10b4121` test(e2e): add hybrid maquette parity harness (pixel + structural)
- `ea98721` feat(web): rebuild dashboard on the maquette v2 pattern
- `80e5dc0` feat(web): align inventory pattern with Inec maquette tokens and donut geometry

Detalle por commit y por sub-tarea en `odd/tasks/backoffice-maquette-parity.md`.

## Constraints duros para la próxima sesión

- NO correr `git reset`/`restore`/`stash drop`/`checkout` que toque master, ni borrar archivos del working tree sin autorización explícita.
- NO hacer push a master sin merge local previo + smoke contra `https://backoffice.quorum.asistentepro.mx`.
- NO modificar `../quorum-otp/` (read-only).
- NO desplegar vía copia directa al hostPath del pod (`/opt/quorum-backoffice`). El release real pasa por el pipeline de CI → registry → `kubectl set image` (o el mecanismo documentado en `infra/`). El flujo manual vía rsync + `kubectl rollout restart` que se usó durante la fase de pruebas deja un pod con el hostPath sobrescrito; cualquier restart subsecuente del pod usa la imagen del registry, no el bundle local.
- NO correr los integration tests de API sin antes confirmar explícitamente un DB descartable aislado (los tests hacen `DROP TABLE`).

## Próximo paso recomendado

El feature `backoffice-maquette-parity` está cerrado e integrado en master. Próximas áreas pendientes (no bloquean el MVP):

1. **Limpieza del bundle deployado vía rsync**: ahora que master tiene el código, sincronizar el bundle de producción (hostPath `/opt/quorum-backoffice/apps/web/.next`) con master para que el pod no dependa del rsync manual. El pod puede rebuildearse desde la imagen Docker configurada en el Deployment (mirror del registry) en lugar de leer del hostPath.
2. **Resolución del bug `user_unmapped`** (rama auth inalcanzable, ver `odd/tasks/backoffice-username-otp.md` §6) — pre-existente al merge, no introducido por este feature.
3. **Documentar el flujo de release real** (CI → image → kubectl set image) en `RUNBOOK.md` §Operational tasks → Deploy. Hoy el doc `odd/tasks/deploy-bug-001.md` está desactualizado (describe un flujo ssh + systemd + git pull que no aplica en el cluster k3s actual).

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
https://backoffice.quorum.asistentepro.mx/login
```

- `quorum.asistentepro.mx/` → sigue mostrando Jitsi (raíz separada)
- `backoffice.quorum.asistentepro.mx/` → el backoffice (subdominio dedicado
  post-Polish WU v6)
- `backoffice.quorum.asistentepro.mx/api/v1/...` → la API (nginx same-origin
  proxy al upstream `quorum_backoffice_api_k8s` en cluster k3s)

## Ramas

- `master` (HEAD `c85bb41`): integra `feature/backoffice-maquette-parity`
  (16 commits) y todo el historial de Polish WU v6 (HEAD `f259483`).
  Es la rama default remota (`origin/HEAD` apunta a `feature/wu0-bootstrap`
  por un setting del repo, no por contenido — `master` es la rama canónica
  per `RUNBOOK.md` y HANDOFF previos).
- `feature/backoffice-maquette-parity` (`df4c0ac`): rama mergeada; puede
  borrarse vía `git push origin :feature/backoffice-maquette-parity` cuando
  el equipo confirme que no se necesita el historial como rama visible.
- `feature/username-otp-dynamic-clean` (`b39ab30`): ancestro de la rama
  merged; sus commits `8c796e8` (login OTP zone) y `64cc867` (auth accepts
  OTP against username OR email) están ahora en master vía el merge.
- `feature/wu0-bootstrap` (remote origin/HEAD): rama legacy de PR #1;
  precede al merge de la paridad. Conservar hasta confirmar con el equipo
  si se sincroniza o se elimina.

## Archivos clave del proyecto

```
/planQuorum/dev/quorum-backoffice/
├── apps/
│   ├── api/                       # Fastify 5 + Node 22 + PG 18 + Redis 8
│   │   ├── migrations/             # 11 migrations (0001-0011_backoffice_username.sql)
│   │   ├── scripts/                # migrate.ts, seed-e2e-users.ts, mock-otp-service.ts
│   │   └── src/                    # routes, services, repositories, plugins
│   └── web/                        # Next.js 16 App Router + React 19 + shadcn/ui
│       ├── app/
│       │   ├── login/              # single-step username + OTP form
│       │   └── (authed)/           # route group con layout que valida sesión
│       │       ├── dashboard/      # ALINEADO A MAQUETA (paridad 98%)
│       │       ├── marbetes/       # ALINEADO A MAQUETA (paridad 96.68%)
│       │       ├── dispositivos/   # ALINEADO A MAQUETA (paridad 96.91%)
│       │       └── audit/          # ALINEADO A MAQUETA (paridad 96.86%)
│       ├── components/
│       │   ├── inventory/          # 10 componentes compartidos (MetricCard, DonutChart, Pagination, etc.)
│       │   ├── layout/             # AppShell, Sidebar, Topbar, MobileNav, LogoutButton
│       │   └── ui/                 # shadcn wrappers (button, card, dialog, otp-input, select, ...)
│       ├── lib/
│       │   ├── api-client.ts        # fetch wrappers
│       │   ├── auth-context.ts      # client auth state
│       │   └── server-session.ts    # getServerSession() + getAuthCookieHeader() (SSR cookie forward)
│       ├── e2e/lookfeel/           # Playwright suite
│       │   ├── 01-09 specs          # audit + auth + visual + interaction + responsive + a11y
│       │   ├── 10-auth-otp.spec.ts  # login flow con OTP
│       │   ├── 11-maquette-v3.spec.ts  # round v3 de paridad
│       │   ├── 12-maquette-parity.spec.ts  # round v4 con cookie inject + masks dinámicos
│       │   └── helpers/             # login, snapshot, viewports, parity-scorer, maquette-server, parity-diff
│       ├── app/globals.css          # tokens InecConecta + @layer components maquette (sticky footer, donut, etc.)
│       └── next.config.ts           # basePath: '/backoffice', output: 'standalone'
├── packages/shared/                # Zod DTOs + RBAC helpers
├── infra/
│   ├── nginx/
│   │   ├── backoffice.quorum.asistentepro.mx.conf  # subdominio dedicado (USADO)
│   │   └── quorum.asistentepro.mx.conf            # legacy, ya no maneja /backoffice
│   └── systemd/{api,web}.service  # plantillas de unidades systemd (referencia; cluster k3s real)
├── diseno/                         # Brand tokens + icon library + MAQUETA HTML canónica
│   ├── design/                     # InecConecta_color_tokens.png + PNG/JPEG referencias
│   ├── maqueta_Inec/Inec/          # MAQUETA: inventario-credenciales.html + CSS + JS
│   └── (legacy png-x2/, __MACOSX/ pre-existentes)
├── odd/tasks/                      # bitácora por feature
│   ├── backoffice-maquette-parity.md  # NUEVO: feature cerrado e integrado en master
│   ├── backoffice-login-functional.md # nginx + login OTP service cluster
│   ├── backoffice-cors-same-origin.md
│   ├── backoffice-username-otp.md   # ancestro de la rama mergeada (merge TBD antes)
│   ├── marbetes-inventory-v2.md
│   ├── dispositivos-inventory-v2.md
│   ├── security-auth-otp-and-maquette-v3.md
│   ├── login-otp-gold-boxes.md
│   ├── polish-wu-v3..v5.md
│   └── deploy-bug-001.md
├── RUNBOOK.md                       # operador-facing docs (arquitectura, envs, ops tasks)
├── HANDOFF.md                       # este archivo
└── package.json                      # workspaces root (api, web, shared)
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

(none — todos los items XS/M cerrados en Polish WU v1 (infra/devops) + v2 (UI/UX) + v3 (security + endpoint + archival) + v4 (bulk upload + closeout))

Cerrados en Polish WU v3 (commits `859c8f3` + `157b163` + `70c9c16` + `fcd523d` + `1fa0513` → `5fe6692` en master, merge de `feature/polish-wu-v3`):
- **W #1 M** (Reveal endpoint): `POST /api/v1/marbetes/:id/reveal` admin-only + `RevealMarbeteDialog` wired.
- **W #5 S-M** (argon2id migration): dual-verify + transparent re-hash on first successful login.
- **W #6 M** (audit_log archival): `audit_log_archive` table + `archive_audit_log(retention_days)` SECURITY DEFINER + cron weekly en RUNBOOK.

Cerrados en WU #2 (commits `f7d071c` + `9a425b8` en feature/dispositivos-v2, merge TBD a master):
- **WU #2 L** (Rediseño /dispositivos): replica del patrón marbetes v2. 4 metric cards (Total / Activos / Revocados / Sin marca con pills attention), DonutChart segments, tabla rediseñada con IdBadge DIS-#### + StatusChip, filtros en `.inventory-search` shell, Playwright spec `08-dispositivos-design.spec.ts` con 5 cases (T8.1-T8.5). 3 dialogs (Create/Edit/Revoke) intactos. Plan en `odd/tasks/dispositivos-inventory-v2.md`.

Cerrados en Polish WU v2 (commits `e0e49c7` + `218a56a` + `8d31b0b` + `764243e` en `feature/wu0-bootstrap`):
- **RESP-001 P0** (mobile responsive): AppShell con sidebar colapsable en <md.
- **A11Y-001 P1**: landmark `<header>` en card de /login.
- **VIS-002 P2**: focus-visible audit + styles en .metric-card, .sort-button, .row-action, .table-pagination__toggle.
- **W #7 XS** (dialog animation): fade-in/out para los 3 dialogs existentes de marbetes (add/reveal/revoke). Cerrado en v3 commit `859c8f3`.
- **W #8 XS** (aria-modal MobileNav): explícito en `<DialogContent>`. Cerrado en v3 commit `157b163`.

Pendientes (L effort, sesiones dedicadas futuras):
- (none — Polish WU v5 cerró el rediseño /audit; ver bloque "Cerrados en Polish WU v5" abajo).

Cerrados en Polish WU v4 (commits `3f430bc` + `06fda3d` + `<wu9-hash>` en `feature/bulk-upload`, merge TBD a master):
- **Bulk upload endpoint** para "Cargar marbetes": `POST /api/v1/marbetes/bulk` admin-only, OTP-enforced, acepta JSON array o CSV (RFC-4180-lite parser), valida códigos (length 8-128, alphanumeric), rechaza duplicados intra-batch + contra DB, persiste N marbetes atómicamente en una transacción, emite 1 audit aggregate `marbete.bulk_create` con `metadata: { count, source, fileName, individualRefs }`. Frontend: `BulkUploadDialog` con drag&drop + paste + preview ≤10 filas + errors panel + progress bar + OTP, reemplaza el stub `window.alert('Cargar marbetes próximamente')`. Plan + bitácora en `odd/tasks/polish-wu-v4.md`.
- **Housekeeping WU #9**: `.gitignore` agrega bloque `# Playwright artifacts` cubriendo `apps/*/test-results/` (genérico); `migrations.test.ts` ahora espera los 9 migrations (0001-0009) en ambas assertions; 4 lint cleanups (removed unused `total` prop de `MarbetesPageClient` + call site; deleted 3 dead functions en `a11y.ts` que eran shadowed por INNER copies en `page.evaluate`; `// eslint-disable-next-line react-hooks/exhaustive-deps` en `student-lookup.tsx` con comentario explicando la omisión intencional de `state`). Resultado: 184 tests verde (32 suites), typecheck clean, lint 0 errors / 0 warnings, build 7 rutas verdes.

Cerrados en Polish WU v5 (commits `959a5fb` en `feature/audit-v2`, merge `dc6e46b` a master):
- **Rediseño `/audit`** per maquet InecConecta (replica del marbetes v2 adaptado a entries del audit log): page server `limit:100` → `200` + `VALID_ACTIONS` extendido a los 12 valores del enum `AuditAction` (incluye `marbete.reveal` y `marbete.bulk_create`); page-client con 4 MetricCards (Total / Marbetes / Dispositivos / Autenticación con pill danger cuando hay `auth.failed`); filtros en `.inventory-search` shell + `.grid` row para los 5 filtros estructurados; tabla rediseñadaada con `IdBadge` `AUD-${id.padStart(4,'0')}` + `StatusChip` mapeando las 12 acciones a las 3 variantes existentes ('available'/'assigned'/'danger') + `SortHeader` para ID y Fecha (ciclo 2-state con default `desc` para occurredAt y `asc` para id) + `Pagination` + `<tr onClick>` que abre el drawer. Tests nuevos: `audit-page-client.test.tsx` (6 cases: T1 4 cards, T2 Marbetes filter, T3 Fecha sort cycle, T4 Total reset, T5 Dispositivos filter, T6 ID sort cycle); `audit-table.test.tsx` (+2: IdBadge AUD-#### + StatusChip variant); `audit-filters.test.tsx` (+2: search URL update + shell containment); `09-audit-design.spec.ts` (6 Playwright cases T9.1-T9.6: cards + screenshot, AUD-#### badges, search URL, Fecha sort cycle, auditor RBAC reach, operator redirect). `AuditDetailDrawer` intacto (`data-testid="audit-detail"` preservado). 79 web RTL + 115 API integration = 194 tests verdes sin regresiones. typecheck/lint clean. build 7 rutas. Plan + bitácora en `odd/tasks/polish-wu-v5.md`.

Cerrados en Polish WU v6 (**14 commits** en `feature/security-auth-otp` @ `7fe86d4`, **PR #3 abierto** contra master):

**Fase A — Security rewrite (email + OTP)**, 11 commits, 11 nuevos tests verdes:
- **(A1)** `2d03fde feat(api): add SMTP mailer + config` — Nodemailer + dev-mode logged fallback (`createMailerForTest` para integration suite).
- **(A2)** `b66a7df feat(api): OtpClient.issue()` — extiende `verify()` para que el backoffice pueda pedir OTP al quorum-otp service.
- **(A5)** `88d92b4 feat(auth): DTOs + client wiring` — `RequestLoginRequest` + `LoginRequestOtp` (campo `password` preservado en el wire type como ignored optional, no se usa).
- **(A3+A4)** `ceeef88 feat(api): email+OTP login flow` — `AuthService.requestLoginOtp()` (idempotent 200 para emails desconocidos, evita enumeración) + `loginWithOtp()` (OTP-service verify + emisión session); rutas `POST /api/v1/auth/login/request` + `POST /api/v1/auth/login`; plugin `auth-deps` que registra OtpClient+Mailer al boot; migración `0010_audit_action_otp_login.sql` que extiende el enum `audit_action` con `auth.login.requested`/`auth.login.otp_verified`/`auth.login.failed`.
- **(A6)** `74d43f9 test(api): migrate integration suite` — auth.test.ts (21 tests), rbac.test.ts, marbetes.test.ts, migrations.test.ts todos migrados al flujo 2-step con `FakeOtpClient` + `createMailerForTest`.
- **(A7)** `8f46a39 feat(web): 2-step LoginFormOtp` — compuesto exclusivamente de shadcn primitives (Input, Label, Button, Alert) + `OtpInput` reusado; login-form.tsx legacy borrado.
- **(A8)** `7fb2a22 test(web): RTL coverage` — 6 tests nuevos en `login-form-otp.test.tsx` + actualización de `auth-context.test.tsx`.
- **(A9)** `cd96e99 test(e2e): Playwright spec` — 6 casos T10.1-T10.6 contra staging, incluyendo regression guard `expect(page.locator('input[type="password"]')).toHaveCount(0)` que cierra el hallazgo original.

**Fase B — Maquette v3 alignment**, 3 commits, 5 nuevos tests verdes:
- **(B1)** `75e5e01 chore: drop __MACOSX + png-x2 leftovers` + `783b350 chore: regenerate package-lock after nodemailer install` — limpieza del working tree antes del PR.
- **(B7)** `47a4f6a test(e2e): fix T10.3 + add mock-otp-service for local Playwright runs` — helper mock OTP para tests locales + fix del regression T10.3.
- **(B7)** `7fe86d4 test(e2e): maquette v3 visual regression` — `11-maquette-v3.spec.ts` T11.1-T11.5 verifica que `/marbetes` + `/dispositivos` + `/audit` + `/dashboard` + `/login` renderizan con el copy y métricas del HTML canónico (`diseno/maqueta_Inec/Inec/inventario-credenciales.html`). Screenshots en `apps/web/e2e/lookfeel/artifacts/`.

`users.password_hash` preservado en DB pero ignorado en el login flow. RUNBOOK actualizado con bloque "OTP delivery" + nuevas env vars `SMTP_*`/`LOGIN_OTP_*`. **Resultado: 216/216 tests verde** (122 API + 83 web + 11 Playwright; antes 194 → +22 nuevos netos). typecheck/lint/build verde. Plan + bitácora en `odd/tasks/security-auth-otp-and-maquette-v3.md`. **PR abierto**: https://github.com/Inssoft-proyects/quorum-backoffice/pull/3

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

## Próximos pasos sugeridos

Items L pendientes (sesiones dedicadas):
1. ~~Rediseño `/dispositivos`~~ (done in WU #2)
2. ~~**Bulk upload endpoint** para "Cargar marbetes"~~ (done in Polish WU v4)
3. ~~**Rediseño `/audit`** per maquet InecConecta~~ (done in Polish WU v5)

Bloqueado por config:
- **RDD review** del Polish WU v3 (5 commits + 1 merge). requiere asignar modelo al host relay en `agent model routing config`.

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
