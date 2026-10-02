# marbetes-v3-gapfixes — cierre de gaps + prueba funcional de features

> Resolver en paralelo los gaps G1–G5 del inventario de verificación T8
> (`odd/tasks/marbetes-v3-asignacion.md` §10), mientras un verificador prueba
> las features desplegadas en https://backoffice.quorum.asistentepro.mx.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `marbetes-v3-gapfixes` |
| Rama | `feature/marbetes-v3-asignacion` (continúa) |
| Autorización | usuario 2026-10-02: "Prueba las features… ejecuta subagentes… en paralelo" |
| Escritura paralela | APROBADA por el usuario — streams con archivos exactos disjuntos |

## 2. Alcance y streams

| Stream | Contenido | Superficie (archivos exactos) |
| --- | --- | --- |
| V | Prueba funcional de features desplegadas (read-only repo; escrituras solo códigos `90000…`) | — (solo entorno desplegado) |
| W1 (G1) | Borrar dead code legacy + spec e2e obsoleto | 5 componentes legacy + 4 tests huérfanos + `apps/web/e2e/marbetes.spec.ts` |
| W2 (G2) | Helper compartido OTP-grant | `apps/api/src/lib/otp-grant-verify.ts` (nuevo), `marbetes-service.ts`, `matriculas-service.ts`, 3 tests unit |
| W3 (G3+G5) | Specs e2e `/asociar` + flujo bulk + alta en harness paridad + micro-fix búsqueda | `13-asociar-screen.spec.ts`, `14-bulk-upload-flow.spec.ts`, `12-maquette-parity.spec.ts`, `fixtures/**`, `asociar-page-client.tsx` + su test |
| W4 (G4) | CI/smoke + pin MAQUETTE_DIR | `scripts/ci-checks.sh`, `scripts/smoke-post-deploy.sh`, `RUNBOOK.md`, `lookfeel/helpers/maquette-server.ts` |
| G6 | students_cache.is_active vs bajas de Canvas | EXTERNO quorum-canvas — FUERA de alcance; requiere autorización explícita para ese repo (fuente de portal-api no visible en este workspace) |

Rangos de códigos de prueba para no colisionar: V=`90000*`, W3=`80000*` (dígitos, ≥8).

## 3. Reglas de ejecución

- Cada worker corre SOLO verificación dirigida (typecheck + tests de su alcance);
  el padre corre suites completas al integrar (evita carreras entre streams).
- Ningún worker hace commit — el padre commitea por work-unit con archivos exactos.
- Presupuesto de revisión ≤400 líneas por work-unit; si un commit lo excede se
  reporta y se ofrece el menú de entrega (cadena de ramas / cadena al default /
  PR único con excepción).
- Al cierre: preflight RDD por candidato (consentimiento humano por candidato).

## 4. Plan de tareas

| # | Task | Estado |
| --- | --- | --- |
| G1 | Probar features desplegadas (V) — login, marbetes layout, modal bulk .xlsx + taxonomía errores, ventana OTP 20min, /asociar sync+asignar+desasignar+reveal | pending |
| G2 | W1: borrar dead code legacy (5 componentes + 4 tests + e2e/marbetes.spec.ts) | pending |
| G3 | W2: helper compartido otp-grant-verify | pending |
| G4 | W3: e2e /asociar + bulk + paridad + G5 búsqueda | pending |
| G5 | W4: scripts ci-checks + smoke-post-deploy + RUNBOOK + MAQUETTE_DIR | pending |
| G6 | Integración: suites completas + typecheck + commits work-unit | pending |
| G7 | Fixes de bugs hallados por V (si los hay) | pending |
| G8 | Cierre: doc + Engram + preflight RDD | pending |
| G9 | G6 externo quorum-canvas (is_active de bajas) — REQUIERE autorización usuario para repo quorum-canvas | pending |

## 5. Registro de commits

| Task | Commit | Evidencia |
| --- | --- | --- |
| G2 (W1 dead code) | `3c4ca4c` | 10 archivos legacy eliminados (5 componentes + 4 tests huérfanos + e2e/marbetes.spec.ts obsoleto); grep cero importadores; typecheck ok; 24/24 tests dirigidos |
| G5 (W4 ops) | `7ccf55c` | scripts/ci-checks.sh (pin MAQUETTE_DIR, gates DATABASE_URL_TEST/RUN_PARITY) + scripts/smoke-post-deploy.sh (8/8 PASS en entorno desplegado) + RUNBOOK + JSDoc maquette-server |
| G3 (W2 otp-grant helper) | `9674de4` | apps/api/src/lib/otp-grant-verify.ts compartido por MarbetesService + MatriculasService; equivalencia semántica byte-for-byte (reveal nunca toca grants); api 9 suites/106 tests |
| G4 (W3 e2e + G5) | `f3f04ed` | 13-asociar-screen (8 tests) + 14-bulk-upload-flow (3 tests) + /asociar en harness de paridad + fixture .xlsx determinista + fix búsqueda (publicUid fuera del matching); web typecheck ok, 13/13 tests; Playwright compila, pendiente corrida con credenciales |
| G6 | — | Gate de integración (ci-checks.sh): **PASS 6/6**, 38 suites / 277 tests, cero fallout cross-worker. E2e con credenciales: relanzado (verify falló 2× con error de arranque del agente → fallback worker) |
| G7 | `3b7f566`, `f3b7ebe`, `c0e57f8`, `4a90e5d`, `5d23681` | D-1..D-5 + F-1..F-3 + cadena final del write flow bulk (0014_sequence_repair por seed con ids explícitos que no avanzaba el serial; totales del response recalculados sobre todas las filas; mint OTP con subject=email de sesión + scope marbete.bulk_create). Evidencia final: 10/11 e2e en verde (1 skip data-dependent); test 11 destructivo PASA en vivo (3 creados, 1 invalid_chars, 1 duplicate_in_file, ejemplo skipeado, errors workbook generado) |

## 6. Defectos hallados por G1 (prueba funcional del entorno desplegado, 2026-10-02)

| ID | Sev | Defecto | Fix |
| --- | --- | --- | --- |
| D-1 | **P0** | `OtpInput` modo numérico por defecto en bulk-upload, assign-review y unassign — el servicio OTP emite códigos alfanuméricos (alfabeto 31 chars) y la entrada los strippea: los flujos destructivos son inoperables para un humano | `mode="alphanumeric"` en los 3 diálogos |
| D-2 | P3 | `otp-input.tsx` display desincronizado (padEnd con espacios + `trim()` deja cajas visibles vacías al escribir/pegar) | renderizar cada char en su caja |
| D-3 | P3 | add-marbete-dialog sin input OTP (envía `''`, falla `otp_required` sin grant) | input alfanumérico grant-aware |
| D-4 | P3 | reveal-marbete-dialog sin input OTP (reveal nunca es grant-elegible ⇒ requiere OTP por operación) | input alfanumérico siempre |
| D-5 | P2 | helper e2e `loginAs` desincronizado del login de 6 cajas (`div role="group"` + 6 textboxes): los 11 tests mueren en helpers/login.ts:88; además los specs 13/14 reusan un OTP single-use (quorum-otp lo consume al primer verify) y la corrida agarró el playwright.config equivocado | fix loginAs (fill 6 cajas + OTP fresco por llamada, patrón issueFreshOtp) + corrida con --config=e2e/lookfeel |
| Revoke | P3 | RevokeMarbeteDialog sin input OTP (clase D-3) | grant-aware alfanumérico (`f3b7ebe`) |

Commits G7: `3b7f566` (D-1..D-4), `f3b7ebe` (Revoke), `c0e57f8` (D-5), `4a90e5d` (F-1/F-2/F-3). Re-corrida e2e post D-5: 7/11 pass; F-1..F-3 cerrados localmente (32 tests unit, build con CSS nuevo). **Redeploy web 2026-10-02 (2do)**: sync HEAD → /opt, build web (NEXT_PUBLIC_API_URL=https://backoffice.quorum.asistentepro.mx), .next/static + public al standalone, pod web restart (scale 0/1), smoke 8/8 PASS. API sin restart (refactor 9674de4 byte-for-byte; dist reconstruido en /opt sin downtime). Revalidación e2e final en curso.

Flujos G1: LOGIN ✅, MENÚ ✅, MARBETES layout ✅ (banner NO TESTED por D-3), BULK estructura ✅ (upload bloqueado por D-1), OTP WINDOW NOT TESTED (bloqueado por D-1), /asociar estructura ✅ (escrituras bloqueadas por D-1). Inventario NO modificado por las pruebas.

## 7. Cierre de pendientes (2026-10-02, "aplica los pendientes… cierra sesión")

| Pendiente | Resultado |
| --- | --- |
| Limpieza de códigos fixture `80000*` | ✅ 3 filas eliminadas del inventario desplegado |
| G9 quorum-canvas (status de enrollments) | ⛔ **Bloqueado verificado**: la fuente del endpoint `/v1/students` no existe en ningún workspace visible (`quorum-canvas/apps/portal-api` solo contiene `_canvas-side/`). Requiere acceso a la fuente real del portal-api desplegado |
| G9 parte backoffice (F4) | ✅ Aplicado: `sync()` desactiva (`is_active=false`) filas ausentes del roster solo cuando el sync es completo; nunca en sync incompleto |
| Entrega | ✅ Issue #5 + push + PR a `master` |

## 8. Entrega

- Issue: https://github.com/Inssoft-proyects/quorum-backoffice/issues/5 (`enhancement`; el repo no usa labels `type:*` ni template de PR)
- Rama `feature/marbetes-v3-asignacion` → base `master` (default branch verificado vía gh, cuenta `ci-admin-inssoftmx`)
- PR: https://github.com/Inssoft-proyects/quorum-backoffice/pull/6 (base `master`, `Closes #5`)
- Nota RDD: el consentimiento del candidato quedó registrado `declined` por el host interactivo (candidate-scoped, sin linaje); la entrega se hizo bajo política normal del repositorio
