# Quorum Backoffice — Polish WU v6 (Security: Auth OTP + Maquette v3)

> Feature ODD para dos mejoras solicitadas por el operador:
> 1. **Seguridad de login**: migrar de `email + password` a `email + OTP`
>    dinámico (con entrega SMTP), eliminando cualquier superficie donde la
>    password viaje por URL/logs, y manteniendo `users.password_hash`
>    intacto en DB como respaldo (NO se usa en el flujo de login).
> 2. **Alineación de pantallas con la maqueta** del área de diseño
>    (`./diseno/maqueta_Inec/Inec/*` actualizado), usando componentes
>    reutilizables de shadcn/ui siempre que sea posible.

Naming: **"marbete"** (alineado al HTML canónico de la maqueta). El PNG
dice "credencial" pero la fuente de verdad es `inventario-credenciales.html`.

Orden de ataque: **Auth OTP primero** (security-first), después maqueta.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `security-auth-otp` + `maquette-v3-align` |
| Tipo | Security rewrite + UI cosmetic align (sin tocar API contract de GETs) |
| Source de diseño | `apps/web/components/inventory/*` (reutilizar); shadcn/ui (`button`, `dialog`, `input`, `label`, `card`, `alert`, `dropdown-menu`) |
| Stack | Fastify 5 + Zod + pg + ioredis + Nodemailer (SMTP) + Next.js 16 + React 19 + Tailwind 4 |
| Branch | nueva `feature/security-auth-otp` desde `master` @ `38d7e1d` |
| Review budget | ≤400 líneas modificadas por task |
| Tests | tests integración API nuevos (request-otp, verify-otp, rate-limit, lockout) + tests RTL web nuevos (login OTP 2-step) + Playwright spec (login OTP e2e) |

## 2. Estado al cierre de la sesión anterior

- 194/194 tests verde (115 API + 79 web RTL unit).
- Working tree con basura `__MACOSX/._*` + `image.png` + `png-x2.zip` (44 archivos deleted) — limpiar antes de cerrar.
- Branch actual: `master` @ `38d7e1d` (PR #2 merged).
- Endpoint auth actual: `POST /api/v1/auth/login { email, password }` → bcrypt/argon2id verify.
- OTP service ya emite OTPs (`POST /v1/otps`) pero el caller recibe el `token` y debe entregarlo al usuario final (no hay SMTP en el backoffice).
- Página `/marbetes` ya rediseñada per maqueta v2 (commit `98ac08f`); `/dispositivos` y `/audit` también.

## 3. Convenciones heredadas (no cambiar sin discutir)

- Conventional Commits + `quorum-dev <quorum@local>`.
- Allowed edit surfaces explícitos.
- Tokens CSS en `@layer components` de `globals.css` (ya presentes desde maqueta v2).
- Reusar `MetricCard`, `DonutChart`, `StatusChip`, `IdBadge`, `SortHeader`, `Pagination`, `MaskedNumber`, `AddMarbeteDialog`, `RevealMarbeteDialog`, `RevokeMarbeteDialog`, `BulkUploadDialog` de `apps/web/components/inventory/*`.
- **Reusar shadcn/ui** (`Dialog`, `Button`, `Input`, `Label`, `Card`, `Alert`) en lugar de inventar wrappers nuevos.
- `__Host-sid` cookie en prod (Secure + Path=/); tokens son 32B base64url aleatorios.
- `OtpClient.verify({subject, scope, code})` con scope `login` para OTP de login (nuevo).
- `verifyPassword` + `hashPassword` (argon2id) siguen existiendo para mantener `users.password_hash` actualizado en DB (sin uso en login flow).
- OTP service token HMAC + `Authorization: Bearer ${OTP_SERVICE_TOKEN}`.
- Review budget ≤400 líneas por task.

## 4. Work Units (tareas)

### Fase A — Auth OTP (security-first)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| A1 | Config: añadir `SMTP_*` env vars + Mailer service | infra | ~150 | `apps/api/src/config.ts`; `apps/api/src/services/mailer.ts` (NEW); `.env.example` |
| A2 | OtpClient extend: `issue(subject, scope)` además de `verify()` | api | ~80 | `apps/api/src/services/otp-client.ts` |
| A3 | AuthService: `requestLoginOtp(email)` + `loginWithOtp(email, code)` (reemplaza `login()`) | api | ~200 | `apps/api/src/services/auth-service.ts` |
| A4 | Route: `POST /api/v1/auth/login/request` + actualizar `POST /api/v1/auth/login` | api | ~80 | `apps/api/src/routes/auth.ts` |
| A5 | DTOs nuevos: `LoginRequestOtpRequest`, `RequestLoginRequest` + actualizar `LoginRequest` (mantener `password` opcional, default vacío) | shared | ~40 | `packages/shared/src/dto/auth.ts` |
| A6 | Tests integración: rate limit OTP request, lockout, verify flow, email disabled, expired OTP | api | ~250 | `apps/api/test/integration/auth-otp.test.ts` (NEW) |
| A7 | Frontend: nuevo `LoginFormOtp` (email → otp → submit) con 2 steps, reusando shadcn/ui | web | ~280 | `apps/web/app/login/login-form-otp.tsx` (NEW); `apps/web/app/login/page.tsx`; `apps/web/lib/auth-context.tsx`; `apps/web/lib/api-client.ts` |
| A8 | Tests RTL: render form 2-step, OTP submit, error handling, back-to-email | web | ~150 | `apps/web/test/unit/login-form-otp.test.tsx` (NEW) |
| A9 | Playwright spec: login OTP e2e contra staging (admin/auditor/operator) | e2e | ~120 | `apps/web/e2e/lookfeel/10-auth-otp.spec.ts` (NEW); `apps/web/e2e/lookfeel/helpers/login.ts` (update) |
| A10 | Auditoría de seguridad + documentación (HANDOFF, RUNBOOK) | docs | ~150 | `apps/api/README.md`; `RUNBOOK.md`; `HANDOFF.md`; `odd/tasks/quorum-backoffice-mvp.md` §12 |

**Subtotal Fase A**: ~1500 líneas en ~10 tasks. Cada task individual ≤400.

### Fase B — Maqueta v3 alignment

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| B1 | Limpieza working tree: commit `chore: drop __MACOSX + zip leftovers` | housekeeping | ~30 | `diseno/__MACOSX/**` (delete); `diseno/image.png` (delete); `diseno/png-x2.zip` (delete); `diseno/png-x2/**` (delete); `diseno/design/png-x2.zip` (delete) |
| B2 | Audit visual del HTML actualizado vs código actual (`/marbetes`) — alinear copy residual | ui | ~80 | `apps/web/components/inventory/*.tsx` (ajustes finos); `apps/web/app/(authed)/marbetes/_components/*.tsx` |
| B3 | Verificar `/dispositivos` y `/audit` contra maqueta (sin PNG; ajustar copy/UI desde HTML) | ui | ~80 | `apps/web/app/(authed)/dispositivos/_components/*`; `apps/web/app/(authed)/audit/_components/*` |
| B4 | Refactor: extraer `LoginFormOtp` para reusar shadcn primitives (`Dialog`, `Button`, `Input`, `Label`) sin nuevos custom wrappers | refactor | ~50 | `apps/web/app/login/login-form-otp.tsx` |
| B5 | Reusar shadcn/ui en `AddMarbeteDialog`, `RevealMarbeteDialog`, `RevokeMarbeteDialog` (donde aún haya HTML crudo) | refactor | ~200 | `apps/web/components/inventory/{add,reveal,revoke,bulk-upload}-*-dialog.tsx` |
| B6 | Tests RTL adicionales si las refactors cambian DOM (testid preservados) | tests | ~120 | varios `*.test.tsx` |
| B7 | Playwright visual regression: 1 caso por pantalla contra staging con screenshots | e2e | ~150 | `apps/web/e2e/lookfeel/11-maquette-v3.spec.ts` (NEW) |
| B8 | Docs: actualizar `odd/tasks/quorum-backoffice-mvp.md` §12 + HANDOFF | docs | ~80 | `odd/tasks/quorum-backoffice-mvp.md`; `HANDOFF.md` |

**Subtotal Fase B**: ~790 líneas en ~8 tasks.

## 5. Definition of Done

### Fase A
- Endpoint `POST /api/v1/auth/login/request` operativo (rate-limited a 5/min/email, 10/min/IP).
- Endpoint `POST /api/v1/auth/login` solo acepta `{ email, code }` (password removido del body útil; `password` opcional/ignored para back-compat).
- `users.password_hash` permanece en DB (no se elimina) — usuario puede resetear si quiere, pero el flujo UI no lo expone.
- Frontend `/login` muestra 2 steps: "Ingresa tu correo" → "Ingresa el código de 6 dígitos" → submit.
- SMTP integration: Nodemailer + `SMTP_HOST/PORT/USER/PASS/FROM` configurables; en `NODE_ENV=development`, si SMTP no está configurado, log del código a stdout (warning visible).
- Audit emission: `auth.login.requested`, `auth.login.otp_verified`, `auth.login.failed`.
- Tests: 115 + 12 nuevos API integration verde; 79 + 8 nuevos web RTL verde; Playwright `10-auth-otp.spec.ts` verde contra staging.
- `cd apps/api && npm run typecheck && npm run lint` verde; `cd apps/web && npm run typecheck && npm run lint` verde.
- `cd apps/web && npm run build` verde.
- `npm test` (root) verde.
- bitácora + HANDOFF actualizados.

### Fase B
- Working tree sin archivos `__MACOSX/_*` ni zips huérfanos.
- Copy UI consistente con HTML canónico ("marbete", no "credencial").
- Dialogs usan shadcn primitives sin HTML crudo.
- Playwright `11-maquette-v3.spec.ts` verde contra staging con screenshots saved.
- typecheck/lint/build verde.
- 194 + N tests verde sin regresiones.

## 6. Riesgos identificados

- **SMTP no configurado en producción**: si no se setean `SMTP_*` envs, el login OTP falla. Mitigación: fail-closed con error 503 + audit, **no** revelar el código en la respuesta del backend en producción (sólo en dev).
- **OTP service caído**: el login OTP falla. Mitigación: error claro + audit.
- **Race condition en doble-click**: mitigado por `disabled` mientras `isPending`.
- **Email enumeration**: el endpoint `/auth/login/request` debe responder 200 incluso si el email no existe (mismo tiempo de respuesta), sólo audit internamente.
- **Lockout local vs lockout OTP service**: usamos OTP service lockout (5 attempts / OTP); rate-limit local al endpoint (5 / 15 min) por separado.
- **Screenshot regression por cambio visual**: capturar antes/después en Playwright.

## 7. Decisiones tomadas (confirmadas con el usuario)

- **Naming**: "marbete" (alineado al HTML de la maqueta, NO al PNG "credencial").
- **OTP delivery**: SMTP integrado en el backoffice (Nodemailer + env vars).
- **Password hash**: se mantiene en DB (`users.password_hash`) pero se ignora en el flujo de login UI.
- **Orden**: Auth OTP primero (security-first), después maqueta.

## 8. Bitácora (se actualiza al cerrar cada task)

| Task | Commit | Estado |
| --- | --- | --- |
| A1 Config SMTP + Mailer | `2d03fde` | ✅ done |
| A2 OtpClient.issue | `b66a7df` | ✅ done |
| A3 AuthService.requestLoginOtp + loginWithOtp | `ceeef88` | ✅ done (combined with A4) |
| A4 Routes | `ceeef88` | ✅ done (combined with A3) |
| A5 DTOs | `88d92b4` | ✅ done |
| A6 Tests API | `74d43f9` | ✅ done |
| A7 Frontend 2-step | `8f46a39` | ✅ done |
| A8 Tests RTL | `7fb2a22` | ✅ done |
| A9 Playwright e2e | `cd96e99` | ✅ done |
| A10 Docs + auditoría | `7cde86e` | ✅ done |
| **Total Fase A**: | **9 commits, +205 tests verde** | ✅ completa |
| B1 Limpieza working tree | TBD | pendiente |
| B2 Audit visual /marbetes | TBD | pendiente |
| B3 Audit visual /dispositivos + /audit | TBD | pendiente |
| B4 Refactor LoginFormOtp a shadcn | TBD | pendiente |
| B5 Refactor dialogs a shadcn | TBD | pendiente |
| B6 Tests RTL post-refactor | TBD | pendiente |
| B7 Playwright visual regression | TBD | pendiente |
| B8 Docs + HANDOFF | TBD | pendiente |