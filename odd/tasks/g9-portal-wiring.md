# G9 portal-wiring — slice vertical: portal-api PG adapter + despliegue + wiring operador

Creado: 2026-10-03 · Estado: **EN PROGRESO**
Ramas: `quorum-jitsi` → `feat/portal-v1-students` (local, sin remote) · `quorum-backoffice` → `feature/g9-portal-wiring` (desde `origin/master` @ 2431525)

## 0. Objetivo

Que `/backoffice/asociar` → "Sincronizar matrículas" vea **bajas reales**: el portal-api debe
servir `GET /v1/students` con `is_active` derivado de `enrollments` (reales, PG) y el sync del
backoffice debe consumirlo. Cierra el gap G9 de `marbetes-v3-gapfixes.md` §9.

## 1. Decisiones de alcance (2026-10-03, confirmadas por el usuario)

| Decisión | Elección |
| --- | --- |
| Alcance de sesión | **Slice vertical completo** (ítem 2 + ítem 1): adapter PG + migración + deploy + wiring + smoke |
| Cero-enrollments | **Incluirlos con `is_active=false`** (baja explícita por `is_active`, sin depender del safety-net F4) |
| Patrón de deploy portal-api | **hostPath + node:22** (igual que `quorum-backoffice-api`): tsc → `dist/`, sync a `/opt/quorum-jitsi`, Service ClusterIP. Sin dependencia de CI externo (la imagen `quorum/portal-api:0.1.x` no incluye el código de students y no hay Dockerfile en ningún workspace) |

## 2. Hallazgos de exploración (evidencia)

- La ruta `/v1/students` solo se registra si `createPortalApp({ userRepository })` recibe el repo
  (`apps/portal-api/src/app.ts:40,57-59`); `main()` en `apps/portal-api/src/server.ts` **no lo pasa** → ruta dormida hoy. "Wiring" real = adapter PG + wiring de `userRepository`, no solo env vars.
- Solo existe `createInMemoryUserRepository` (`apps/portal-api/src/courses/repo.ts:378-419`), sin seed. Interfaz `UserRepository` (`repo.ts:225-247`): `findBySub`, `readLastAcr`, `listStudents`.
- Auth de `/v1/students`: bearer **estático** contra `ADMIN_TOKEN` (comparación `===`, `auth.ts:67-75`, `server.ts:387-393`) — no HMAC como dice el comment de `canvas-client.ts`.
- Esquema real del portal DB (`postgres.quorum-control.svc:5432`, base `quorum`, rol `quorum_app`):
  el schema de tests de integración no trae `enrollments` ni `users.canvas_id`/`users.email_hash` → migración requerida (ver T1).
- Cluster: portal-api **no está desplegado** (solo jitsi-web/prosody/jicofo/jvb en `quorum-media`). `openbao-0` en `quorum-control` viene `0/1 Ready` — verificar antes de depender de `portal-api-secrets`.
- Config backoffice: `CANVAS_PORTAL_API_URL=https://canvas.invalid/api/v1` (placeholder) en `quorum-backoffice-api-config`; `CANVAS_PORTAL_API_TOKEN` en `quorum-backoffice-api-secret`. API corre `node dist/src/server.js` con hostNetwork sobre hostPath `/opt/quorum-backoffice`.

## 3. Tareas

- [x] **T1. Inventario read-only del entorno portal** — COMPLETO (2026-10-03):
  - Portal DB = k8s `postgres-0.quorum-control`, base `quorum`, rol `quorum_app` (CREATE). **Esquema vacío** (ni `users`, ni ltijs): T3 crea todo desde cero; el bootstrap del runbook nunca corrió completo.
  - JWT Jitsi: secret `quorum-media/jitsi-jwt-shared-secret` + `JWT_APP_ID` (configmap jicofo) ⇒ deploy de portal-api en **namespace `quorum-media`** para `secretKeyRef` directo.
  - Redis del host (127.0.0.1:6379, systemd) está en uso por el OTP (PID 4421 `node dist/server.js`); `portal-redis.quorum-control.svc` (del configmap histórico) **no existe**. Decisión T4: redis propio o DB index dedicada.
  - Puertos host: `8080/8081` ocupados por **JVB (hostNetwork, jvb + jvb-metrics-nginx)**; libres `8090`/`8091`/`8443`. portal-api usará 8090 (HTTP) / 8091 (LTI).
  - `openbao-0` `0/1 Ready` (readiness 501) ⇒ **no se depende de OpenBao**: Secret plano en `quorum-media`.
  - Datos: base `quorum` vacía ⇒ para T6 hace falta seeding de filas de prueba (convención de fixtures) o aceptar roster vacío.
- [x] **T2. `createPgUserRepository` + wiring (quorum-jitsi)** — COMPLETO: commit **`980d050`** (`apps/portal-api/src/courses/pg-repo.ts`, `migrations/001_courses_users_schema.sql`, wiring en `server.ts:58,73`, 20 tests nuevos). Test-first: RED (módulo inexistente) → GREEN 20/20. Verificación independiente (ASSESS `unassessable` ⇒ como `high`): PASS sin discrepancias — suite completa 662/663 (1 fallo pre-existente `jitsi-config.test.ts` confirmado contra el commit padre), typecheck PASS, check:pii PASS. Follow-ups menores: scanner PII estático no cubre `courses/`/`backoffice/`; falta test unitario focalizado del escape de LIKE.
- [x] **T3. Migración de esquema portal DB** — COMPLETO: `001_courses_users_schema.sql` aplicado a la base `quorum` (5 tablas: users + `canvas_id` NUMERIC + `email_hash`, courses, enrollments, conferences, auth_sessions). GRANTs con guardia de rol para `quorum_app` (+ `CREATE` en schema public, requerido por ltijs al boot — error 42501 corregido). Verificado: `has_table_privilege` t/t/t. Datos de prueba siembrados (convención 90000*): 90001 (enrollment active), 90002 (inactive), 90003 (cero enrollments).
- [x] **T4. Deploy portal-api en k3s** — COMPLETO: commit **`4b11a09`** (`infra/k3s/portal/hostpath-deployment.yaml`, ns `quorum-media`, hostNetwork + `ClusterFirstWithHostNet`, ports 8090/8091 — 8080/8081 ocupados por JVB). Secret `portal-api-secret` (PORTAL_DB_URL/LTI_ENCRYPTION_KEY/ADMIN_TOKEN, nunca en git). Son­das en `/healthz` (este build no sirve `/livez`). Pod 1/1; smoke `GET /v1/students` → 200.
- [x] **T5. Wiring operador backoffice** — COMPLETO: `CANVAS_PORTAL_API_URL=http://127.0.0.1:8090` (configmap) + `CANVAS_PORTAL_API_TOKEN` = `ADMIN_TOKEN` del portal (secret). API redeployada (scale 0→1).
- [x] **T6. Verificación funcional** — COMPLETO con incidentes (ver §5): `ci-checks.sh` 6/6, `smoke-post-deploy.sh` 6/6, portal 662/663 (1 fallo pre-existente `jitsi-config.test.ts`), fix `upsertMany` commit **`346c151`** verificado por verificador independiente (128/128 unit + 2/2 integración PG real, binario == fuente). **ACEPTACIÓN G9 EN VIVO** (2026-10-03 19:11): `POST /api/v1/matriculas/sync` → 200 `total:3, deactivated:3, incomplete:false`; `students_cache`: 90001 `is_active=t`, 90002/90003 `is_active=f` (bajas reales por fila) + 1001-1003 desactivados por F4 (roster completo).
- [ ] **T7. Cierre**: actualizar §9 de `marbetes-v3-gapfixes.md` (o referencia cruzada), commits unitarios por tarea en ambas ramas, memoria Engram, reporte final.

## 4. Riesgos / notas

- Pitfall conocido: stale `tsbuildinfo` ⇒ `tsc` no emite sin error (limpiar antes de build). **Pitfall nuevo**: `packages/shared/dist` stale ⇒ el runtime del API valida contra DTOs viejos (fue el que rompió el sync con `canvas_api_invalid_response`); SIEMPRE reconstruir `shared` antes que `api` y sincronizar ambos `dist` a `/opt`.
- `ADMIN_TOKEN` se compara con `===` (no constant-time): follow-up.
- Los datos de `enrollments` son la fuente de verdad de `is_active`.
- El deploy de backoffice exige **reconstruir y sincronizar `dist` a `/opt/quorum-backoffice`** antes del restart del pod (el hostPath no se actualiza solo; en T5 inicial quedó el binario pre-G9).

## 5. Incidentes de esta sesión (2026-10-03)

1. **Crédenciales inestables de `websop` (host PG)**: el password del rol fue re-escrito por un actor no determinado (sospecha: tooling de tests u otra sesión concurrente; `log_statement=none` impide forense; hay 7377 fallos de auth desde 2026-10-01). Solución convergente aplicada: secrets (`quorum-backoffice-api-secret.DATABASE_URL`, `quorum-otp-secret.{DATABASE_URL,PG_PASSWORD}`) **alineados al valor canónico `quorum_backoffice_dev`** (el que el entorno re-asegura), + restart de ambos servicios. Verificado: API-PG-OK, readyz ok, mint ok. **Follow-up #1 (prioridad)**: rol de servicio dedicado con password fuerte, `websop` dejar de ser SUPERUSER, aislar credenciales de tests, habilitar `log_statement=ddl`.
2. **`upsertMany` con bug de columnas (5 vs 4)**: confirmado en fuente (`a48d822`) — enmascarado por pool mockeado en unit y por integration gateado tras `DATABASE_URL_TEST`. Fix `346c151` + tests de integración PG real.
3. **Binario desplegado pre-G9** en `/opt/quorum-backoffice` (build 2026-10-02): el pod se reinició sin resincronizar `dist`; corregido (rebuild + rsync + roll).
4. **Verificador independiente ejecutó 2 `ALTER USER` no autorizados** (ronda 2) y luego los revirtió; registrado por el propio agente. Además imprimió en su reporte el valor de `CANVAS_PORTAL_API_TOKEN` y apareció el valor del secret `jitsi-jwt-shared-secret` en el transcript de la sesión ⇒ **follow-up #2: rotar ambos tokens** si el transcript se comparte.

## 6. Follow-ups (orden sugerido)

1. Credenciales: rol dedicado + password fuerte para servicios (quitar SUPERUSER a `websop`), y `log_statement=ddl` temporalmente para cazar al re-escritor.
2. Rotar `CANVAS_PORTAL_API_TOKEN`/`ADMIN_TOKEN` y `jitsi-jwt-shared-secret` (expuestos en transcript).
3. `pg-matriculas.ts`: bug latente de conteo `xmax` (bigint como string vs `=== 0`) ⇒ `created/updated` imprecisos en la respuesta del sync.
4. Tests de integración pre-existentes rotos (seed `'a'.repeat(64)` en SQL, `FST_ERR_CTP_EMPTY_JSON_BODY`, fetch shim de OTP, lista de migraciones desactualizada) y flag `--testPathPattern`→`--testPathPatterns` en `apps/api/package.json`; `ci-checks.sh` doble-cuenta fallos (cosmético). Ampliar `ci-checks.sh` para correr integración con `DATABASE_URL_TEST`.
5. Scanner PII estático no cubre `courses/`/`backoffice/`; falta test unitario del escape de LIKE (quorum-jitsi).
6. Portal: decisiones abiertas — adapter PG de `CourseRepository`, Redis propio para portal (hoy comparte el redis del host con OTP en DB 2), `openbao-0` sigue `0/1 Ready` (readiness 501).
7. UI: re-confirmación visual del botón "Sincronizar matrículas" en `/asociar` (el endpoint fue probado; el click de Playwright quedó en `/tmp/g9-sync.spec.ts`).
8. **Transversal (handoff inter-sesiones)**: `BulkCreateMarbeteFailure` requiere `category` en `feature/marbetes-v3-asignacion` pero `master` no la tiene (registrado como B4 por la sesión hermana de `quorum-backoffice-access`) — pendiente de diseño propio del stream Marbetes.
