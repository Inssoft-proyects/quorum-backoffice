# Pendientes — quorum-backoffice

Plan de atención para cerrar las 5 tareas ODD marcadas como parciales (◐) o pendientes (◯) en la auditoría ODD de este workspace. Esta lista se regenera cuando hay cambios en `quorum-backoffice/odd/tasks/`.

## Tabla resumen

| # | Tarea                            | Archivo ODD                                            | Estado            | Severidad | Esfuerzo |
|---|----------------------------------|--------------------------------------------------------|-------------------|-----------|----------|
| 1 | backoffice-cors-same-origin      | `odd/tasks/backoffice-cors-same-origin.md`             | ◐ parcial         | Media     | M (~2h)  |
| 2 | backoffice-username-otp          | `odd/tasks/backoffice-username-otp.md`                 | ◐ parcial         | Alta      | M (~4h)  |
| 3 | login-otp-gold-boxes             | `odd/tasks/login-otp-gold-boxes.md`                    | ◐ parcial         | Alta      | S (~1h)  |
| 4 | backoffice-login-functional      | `odd/tasks/backoffice-login-functional.md`             | ◐ pendiente (P0)  | Crítica   | M (~3h)  |
| 5 | polish-wu-v1                     | `odd/tasks/polish-wu-v1.md`                            | ◯ pendiente       | Baja      | L (~6h)  |

## 1. backoffice-cors-same-origin.md (◐ parcial)

- **Qué falta**: Real API login/OTP delivery ejercitado contra la config CORS nueva (subdominio dedicado). Backend behavior beyond OPTIONS verificado.
- **Dónde**: `quorum-backoffice/odd/tasks/backoffice-cors-same-origin.md` (§"Final status"); nginx `infra/nginx/quorum.asistentepro.mx.conf`; plugin `apps/api/src/plugins/cors.ts`.
- **Por qué importa**: sin verificar POST/PUT/DELETE real, no se descarta que OPTIONS devuelva 200 pero las mutaciones queden bloqueadas en runtime.
- **Cómo cerrarlo (plan de pasos)**:
  1. Levantar stack contra `https://backoffice.inecuni.com`.
  2. Capturar preflight OPTIONS.
  3. Repetir con POST real (login request → OTP → login).
  4. Repetir con PUT/DELETE (OTP-guard).
  5. Documentar resultados en el archivo ODD.
- **Verificación esperada**: curl preflight + 4 mutaciones; sin warnings CORS en console.

```bash
# Preflight OPTIONS
curl -i -X OPTIONS https://backoffice.inecuni.com/api/auth/login \
  -H "Origin: https://backoffice.inecuni.com" \
  -H "Access-Control-Request-Method: POST"

# Mutaciones reales (4): POST login request, POST verify, PUT otp-guard, DELETE session
```

## 2. backoffice-username-otp.md (◐ parcial)

- **Qué falta**: API integration tests con isolated test DB; Playwright real login/OTP delivery contra staging; operator account mapping confirmado.
- **Dónde**: ODD task §"Status"; `apps/api/test/integration/auth-otp.test.ts`; `e2e/lookfeel/10-auth-otp.spec.ts`.
- **Por qué importa**: login username+OTP es camino crítico; sin integration+e2e no se garantiza flujo end-to-end.
- **Cómo cerrarlo (plan de pasos)**:
  1. Suite `auth-otp.test.ts` con `TEST_DB_URL` env var aislada.
  2. Añadir tests 4 caminos (request idempotente, verify, re-issue rate-limit, lockout 429).
  3. Registrar operator real + e2e con secrets en env.
  4. Correr `10-auth-otp.spec.ts` contra staging.
  5. Actualizar Status del archivo ODD.
- **Verificación esperada**: `npm test -- --testPathPattern=auth-otp` 0 failures; Playwright 6/6 passed.

```bash
TEST_DB_URL=postgres://test:test@localhost:5432/quorum_auth_otp_test \
  npm test -- --testPathPattern=auth-otp

# e2e contra staging (con .env.staging cargado)
PLAYWRIGHT_BASE_URL=https://backoffice.inecuni.com \
  npx playwright test e2e/lookfeel/10-auth-otp.spec.ts
```

## 3. login-otp-gold-boxes.md (◐ parcial)

- **Qué falta**: `npm run build` y Playwright lookfeel `10-auth-otp.spec.ts` re-corridos en entorno funcional (bloqueados por Next 16 Turbopack EACCES `.next/trace`).
- **Dónde**: Rama `feature/username-otp-dynamic-clean` commit `8c796e8`.
- **Por qué importa**: build verde + Playwright e2e son precond de merge a master.
- **Cómo cerrarlo (plan de pasos)**:
  1. `rm -rf apps/web/.next`.
  2. `cd apps/web && npm run build` (7 rutas).
  3. Playwright 6/6 con screenshots actualizados.
  4. Squash + PR.
  5. Actualizar §"Evidence".
- **Verificación esperada**: build 7 rutas; Playwright 6/6; PR abierto.

```bash
cd apps/web
rm -rf .next
npm run build           # debe terminar con 7 rutas compiladas
npx playwright test e2e/lookfeel/10-auth-otp.spec.ts   # 6/6 verde
git push -u origin feature/username-otp-dynamic-clean
gh pr create --base master --title "feat(web): username+OTP login gold boxes"
```

## 4. backoffice-login-functional.md (◯ pendiente) — P0 BLOQUEANTE

- **Qué falta**: Cerrar 2 defectos activos de validación 2026-09-25: (a) nginx routing gap en `/login` (sin `/backoffice` prefix devuelve 404); (b) OTP service upstream dead (OTP_SERVICE_URL apunta a leftover mock-otp-service.ts).
- **Dónde**: ODD task; nginx `infra/nginx/quorum.asistentepro.mx.conf`; systemd `quorum-backoffice-api.service` env `OTP_SERVICE_URL`.
- **Por qué importa**: sin esto, `https://backoffice.inecuni.com/login` no funciona end-to-end (404 o 503 `otp_issue_failed`).
- **Cómo cerrarlo (plan de pasos)**:
  1. nginx: añadir `location = /login { return 302 https://$host/backoffice/login; }`.
  2. Matar mock-otp-service.ts viejo (pid 875493).
  3. Levantar quorum-otp binary real.
  4. Corregir `OTP_SERVICE_URL` en systemd unit del API + reiniciar.
  5. Smoke E2E con curl.
  6. Documentar + commit.
- **Verificación esperada**: smoke login curl devuelve 200; sin 503 en logs.

```bash
# 1. Editar nginx
sudoedit infra/nginx/quorum.asistentepro.mx.conf
# añadir location = /login { return 302 https://$host/backoffice/login; }
sudo nginx -t && sudo systemctl reload nginx

# 2. Matar mock-otp viejo
kill 875493 || true

# 3. Levantar OTP real
sudo systemctl start quorum-otp

# 4. Corregir env y reiniciar API
sudoedit /etc/systemd/system/quorum-backoffice-api.service
# OTP_SERVICE_URL=http://127.0.0.1:8088
sudo systemctl daemon-reload && sudo systemctl restart quorum-backoffice-api

# 5. Smoke E2E
curl -i -X POST https://backoffice.inecuni.com/backoffice/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<operator>"}'

# 6. Validar logs sin 503
sudo journalctl -u quorum-backoffice-api -n 200 | grep -c '503'  # debe ser 0
```

## 5. polish-wu-v1.md (◯ pendiente)

- **Qué falta**: Ejecutar 4 tasks del plan sin evidencia de ejecución: (1) dist path fix (`apps/api/package.json` `main`+`start`); (2) systemd files committed; (3) ESLint flat config; (4) e2e seed script.
- **Dónde**: ODD task §"1-4 Tasks" + §"5. Definition of Done"; `apps/api/package.json`, `infra/systemd/*.service`, `infra/nginx/README.md`, `apps/web/.eslintrc.cjs`, `apps/web/package.json`, `apps/api/scripts/seed-e2e-users.ts`, `RUNBOOK.md`.
- **Por qué importa**: polish-wu v2-v5 ya mergeados; v1 es shadow pendiente que cierra el ciclo.
- **Cómo cerrarlo (plan de pasos)**:
  1. Branch `feature/polish-wu-v1` con 4 work-unit commits.
  2. Commit 1 — dist path fix (`apps/api/package.json` `main`+`start`).
  3. Commit 2 — systemd files committed (`infra/systemd/*.service`).
  4. Commit 3 — ESLint flat config (`apps/web/.eslintrc.cjs`).
  5. Commit 4 — e2e seed script (`apps/api/scripts/seed-e2e-users.ts` + `RUNBOOK.md`).
  6. `npm run typecheck` + `npm run lint` + `npm test` (148/148 verde) + `npm run build` (7 rutas).
  7. PR a master.
- **Verificación esperada**: 4 commits Conventional; 148/148 tests verde; PR abierto.

```bash
git checkout -b feature/polish-wu-v1

# Commit 1
git add apps/api/package.json
git commit -m "fix(api): point main/start to compiled dist"

# Commit 2
git add infra/systemd/
git commit -m "chore(infra): commit systemd unit files"

# Commit 3
git add apps/web/.eslintrc.cjs apps/web/package.json
git commit -m "chore(web): migrate ESLint to flat config"

# Commit 4
git add apps/api/scripts/seed-e2e-users.ts RUNBOOK.md
git commit -m "test(e2e): add seed-e2e-users script and RUNBOOK section"

# Validación
npm run typecheck
npm run lint
npm test           # 148/148
npm run build      # 7 rutas

git push -u origin feature/polish-wu-v1
gh pr create --base master --title "chore: polish-wu v1 (4 WU commits)"
```

## Orden recomendado de abordaje

| Prioridad | Tarea # | Rationale                                                                                                   |
|-----------|---------|-------------------------------------------------------------------------------------------------------------|
| P0        | #4      | Login bloqueante: sin esto el producto no entra. nginx 404 + OTP upstream dead = smoke E2E falla.           |
| P1        | #2      | Camino crítico username+OTP sin integration+e2e: no garantiza flujo end-to-end antes de merge a master.     |
| P2        | #3      | Precond de merge (#2): build verde + Playwright 6/6. Sin esto, no se puede cerrar #2 en master.              |
| P3        | #1      | CORS real-mutations: defensa en profundidad; OPTIONS ya responde 200, falta evidencia de POST/PUT/DELETE.    |
| P4        | #5      | Polish de housekeeping: cierra el ciclo wu v1-v5 pero no bloquea funcionalidad de negocio.                   |

## Convenciones a respetar

- **Conventional Commits**: `feat(scope): …`, `fix(scope): …`, `chore(scope): …`, `test(e2e): …`, `docs(…): …`.
- **Branch**: `feature/<task-slug>` por tarea ODD; ejemplo `feature/backoffice-login-functional`.
- **Work-unit commits**: ≤400 líneas por commit; un commit por sub-paso verificable.
- **RDD native**: si la tarea cruza umbrales de revisión (multi-archivo, contrato API, config prod), ejecutar el switch de review antes de reportar completion.
- **Bitácora**: actualizar `## Status` y `## Evidence` del archivo ODD correspondiente al cerrar cada paso; commit de evidencia junto al commit de código.
- **No staging/push automatizado**: el push y la apertura de PR son decisión humana.

## Reference

- [`quorum-backoffice/README.md`](../README.md) — overview del workspace, suite completa y acceso al suite.
- [`quorum-backoffice/HANDOFF.md`](../HANDOFF.md) — overview del repo y contexto histórico del workspace.
- [`quorum-backoffice/odd/tasks/quorum-backoffice-mvp.md`](../odd/tasks/quorum-backoffice-mvp.md) — spec de producto MVP y bitácora acumulada de WUs.
- [`quorum-backoffice/odd/status-snapshot-2025-11-21.md`](../odd/status-snapshot-2025-11-21.md) — snapshot de auditoría ODD que originó esta lista.
