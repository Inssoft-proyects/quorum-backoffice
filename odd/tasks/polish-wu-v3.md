# Quorum Backoffice — Polish WU v3

> Feature ODD para cerrar los 5 polish items XS/M que quedaron del HANDOFF §"Polish items pendientes" (filtrados por scope realista para una sola sesión). Items L (#2 rediseño dispositivos, #3 rediseño audit, #4 bulk upload) quedan para sesiones dedicadas. Item #9 (RDD review) bloqueado por config del harness.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `polish-wu-v3` |
| Suite | Quorum (sigue `quorum-backoffice-mvp`, `polish-wu-v1`, `polish-wu-v2`) |
| Estado | branch `feature/polish-wu-v3` (fork desde `master` @ `4999500`) |
| Rama | se commitea en `feature/polish-wu-v3` (nueva) |
| Review budget | ≤400 líneas modificadas por task individual |
| Tests | unit + integration (api) + RTL (web) + Playwright (staging) |
| Quality gates | `npm test` (148/148), `npm run typecheck` (api+web), `npm run lint`, `apps/web npm run build`, Playwright 25/25 contra staging |

## 2. Objetivo

Cerrar los 5 polish items XS/M del HANDOFF sin tocar lógica de negocio grande ni romper los 25/25 Playwright tests.

- **Task 1 (WU #7) — Dialog animation fix (XS).** `tailwindcss-animate` no instalado en este repo. Los 3 dialogs existentes de marbetes (add/reveal/revoke) tienen clases `data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0` en `apps/web/components/ui/dialog.tsx` que resuelven a empty selectors. Fix: agregar reglas CSS custom bajo `@layer components` en `globals.css` (mismo patrón que las 2 reglas `slide-in-from-left`/`slide-out-to-left` agregadas para MobileNav en Polish WU v2).

- **Task 2 (WU #8) — aria-modal fix (XS).** MobileNav DialogContent no tiene `aria-modal="true"` (Radix UI Dialog 1.1.23 no lo setea automáticamente). Fix: agregar `aria-modal="true"` como atributo explícito al DialogContent del MobileNav. Mejora a11y real para screen readers.

- **Task 3 (WU #5) — bcrypt → argon2id migration (S-M).** OWASP 2025+ recomienda argon2id. Plan: dual-hash en login. Si el hash almacenado es bcrypt, verificar con bcrypt y re-hashear con argon2id en el siguiente login exitoso. Nuevos users siempre argon2id. Backward-compatible (no requiere force-reset).

- **Task 4 (WU #1) — Reveal endpoint (M).** `POST /api/v1/marbetes/:id/reveal` con body `{ otpCode?: string }` (OTP si AUTH_OTP_REQUIRED), response `{ code: string }`, side effect en `audit_log` con `action='marbete.reveal'`. Después wire-ar `RevealMarbeteDialog` para llamar al endpoint (hoy sólo abre el dialog, no llama al API).

- **Task 5 (WU #6) — Audit log archival (M).** Política de archivado para `audit_log` (>1 año). Plan: nueva tabla `audit_log_archive` con mismo schema, función SQL `archive_audit_log(retention_days integer)` que mueve rows viejos. Documentar en RUNBOOK el cron schedule. NO ejecuta el archivado en este WU — sólo provee las herramientas.

## 3. Convenciones heredadas

- Conventional Commits (`type(scope): summary`).
- `quorum-dev <quorum@local>` para los commits.
- Allowed edit surfaces explícitos (ver delegación al worker).
- Sin cambios a schema hasta Task 5 explícitamente (entonces nuevas migrations 0007 + 0008).
- argon2id params: m=64MB, t=3, p=4 (OWASP minimum for argon2id 2024+).
- bcrypt cost-12 se mantiene para verificación legacy (no remover hasta confirmar 0 usuarios con hash bcrypt).
- Review budget ≤400 líneas por task.

## 4. Work Units (tareas)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| 1 | Dialog animation fix | a11y/UX | ~25 | `apps/web/app/globals.css` |
| 2 | aria-modal MobileNav | a11y | ~5 | `apps/web/components/layout/mobile-nav.tsx` |
| 3 | argon2id migration | security | ~150 | `apps/api/src/lib/password.ts`, `apps/api/src/services/auth-service.ts`, `apps/api/package.json`, `apps/api/test/unit/password.test.ts`, integration test update |
| 4 | Reveal endpoint + UI wiring | feature | ~200 | `apps/api/src/routes/marbetes.ts`, `apps/api/src/services/marbetes-service.ts`, `apps/web/components/inventory/reveal-marbete-dialog.tsx`, `apps/web/app/(authed)/marbetes/_components/marbetes-page-client.tsx`, integration test |
| 5 | Audit log archival | schema + ops | ~180 | `apps/api/migrations/0007_audit_archive.sql`, `apps/api/migrations/0008_archive_function.sql`, `RUNBOOK.md` |

**Total estimado**: ~560 líneas, dentro del budget de 400 PER TASK (cada task individual ≤400).

## 5. Definition of Done

- 5 commits work-unit en `feature/polish-wu-v3`, mensajes Conventional.
- `cd apps/api && npm run typecheck` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde.
- `npm test` (root) verde — sin regresiones sobre los 148/148 baseline.
- `cd apps/web && npm run build` verde.
- Deploy a staging (sync files + rebuild + restart pod).
- Playwright suite contra staging: **25/25 verde**.
- Mobile-nav spec sigue 5/5 (no regresión).
- RUNBOOK.md actualizado con la nueva sección de audit archival cron.
- Bitácora §12 actualizada en `odd/tasks/quorum-backoffice-mvp.md` con los 5 commits.
- Plan §8 actualizado con el estado final.

## 6. Riesgos y mitigaciones

1. **Task 3 (argon2id) puede romper login si la detección de formato es incorrecta.** Mitigación: tests unit + integration exhaustivos; feature flag `AUTH_USE_ARGON2` (default true) para rollback inmediato.
2. **Task 4 (reveal endpoint) debe respetar OTP.** Mitigación: si `AUTH_OTP_REQUIRED=true`, exigir `otpCode` en body; verificar vía OtpClient igual que DELETE/PATCH actuales. Audit log entry con `metadata.otp_verified: true/false`.
3. **Task 5 (audit_log archival) requiere permisos SQL cuidadosos.** Mitigación: la función `archive_audit_log` se crea con `SECURITY DEFINER` y `REVOKE EXECUTE` para no-admin. La tabla `audit_log_archive` no tiene REVOKE (no es append-only — necesita DELETE para recibir rows).
4. **Cada task individual debe tener Playwright o test que verifique el cambio.** Si un task no tiene test directo, agregar uno mínimo (smoke test).

## 7. Out of scope (este WU)

- Items L: redesign /dispositivos, /audit, bulk upload. Sesiones dedicadas.
- Item #9: cerrar RDD review. Bloqueado por config del harness (modelo no asignado al host relay).
- Integración real con portal-api (mockeado en tests; ya documentado en WU3/WU11).
- Cambios a Next.js 17 upgrade o Tailwind 5 (stays on Next 16.3.5 + Tailwind 4).
- Remover soporte bcrypt (legacy users pueden seguir re-hasheando por años).

## 8. Bitácora (a completar al cerrar)

| Commit | Task | Líneas | Notas |
| --- | --- | --- | --- |
| `859c8f3` | WU #7 dialog animation | +22 | 1 archivo (`apps/web/app/globals.css`). 4 `[data-state]` selectors (`animate-in` / `animate-out` / `fade-in-0` / `fade-out-0`) + 2 `@keyframes` (`dialog-enter` / `dialog-exit`) al final de `@layer components`. |
| `157b163` | WU #8 aria-modal MobileNav | +1 | 1 archivo (`apps/web/components/layout/mobile-nav.tsx`). `aria-modal="true"` explícito en el `<DialogContent>`. Radix UI 1.1.23 no setea el atributo por sí solo. |
| `70c9c16` | WU #5 argon2id migration | +504/-7 (7 files) | `apps/api/package.json` agrega `@node-rs/argon2` ^2.0.0. `password.ts` (85 líneas) con dispatch por PHC prefix. `pg-users.ts` agrega `updatePasswordHash()`. `auth-service.ts` upgrade transparente on login exitoso (best-effort, no bloqueante). 11 tests unit nuevos (`password.test.ts`) + 2 integration nuevos. Root `package-lock.json` +219 líneas (deps de @node-rs/argon2). |
| `fcd523d` | WU #1 reveal endpoint | +344/-15 (8 files) | `packages/shared/src/dto/marbete.ts` agrega `RevealMarbeteRequest`/`RevealMarbeteResponse`. `marbetes-service.ts` agrega `reveal()` method. `routes/marbetes.ts` agrega `POST /:id/reveal` (admin-only). `audit-service.ts` agrega `metadata` opcional en `write()` (folds into `after_jsonb`). `api-client.ts` agrega `revealMarbete()`. `RevealMarbeteDialog` llama el endpoint real (reemplaza placeholder mock). `marbetes-page-client.tsx` agrega `lastRevealedCode` state + design-token banner. 5 integration tests nuevos. **DEV NOTE**: usa `action: 'marbete.reveal' as AuditAction` con cast hasta que se actualice el Zod enum. |
| `1fa0513` | WU #6 audit archival + enum reveal | +135/-13 (5 files) | `apps/api/migrations/0007_audit_archival.sql` (NEW) crea `audit_log_archive` (LIKE audit_log + `archived_at` + idx) + función `archive_audit_log(retention_days)` PL/pgSQL `SECURITY DEFINER` que bypassea el REVOKE. `0008_audit_action_reveal.sql` (NEW) extiende enum con `'marbete.reveal'` (ALTER TYPE standalone txn). `marbetes-service.ts` usa `'marbete.reveal'` en lugar del placeholder. `marbetes.test.ts` test actualizado. `RUNBOOK.md` nueva sección §"Audit log archival" con cron weekly. |
| `5fe6692` | Merge to master | — | `git merge --no-ff feature/polish-wu-v3` colapsa los 5 commits anteriores. Master HEAD = `5fe6692`. |