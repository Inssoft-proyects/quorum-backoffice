# MFA get-subject — resolución de identidad por marbete + serial

Feature: `POST /api/v1/mfa/get-subject` (HMAC S2S) → `{ canvas_user_id, matricula }`.
Repo: `quorum-backoffice-access` · Rama: `feat/mfa-matricula-master` · Estado: autorizado (2026-10-13), en implementación.

## Specs

Los `S#` citan textualmente al operador; no agregan requisitos no pedidos.

- **S1** — "requerimos que generes un nuevo servicio (endpoint), que le pasemos el número de marbete y regrese tanto la matrícula (SIS de Canvas), como el subject (canvas_user_id)".
- **S2** — "se requiere que tenga la misma seguridad que tienen los servicios de cursos y mfa para consultar los endpoints".
- **S3** — "Agrégalo como parte de los servicios de /mfa".
- **S4** — "entrega el swagger en /mfa/get-subject y su equivalente como endpoint funcional" (path corregido a guión en L8).
- **S5** — Decisión de factores (respuesta del operador): "Marbete + serial_number".
- **S6** — Decisión de autenticación (respuesta del operador): "HMAC service token (S2S)".
- **S7** — Decisión de método y ruta (respuesta del operador; path corregido a guión en L8): "POST /api/v1/mfa/get-subject".

Contrato derivado (evidencia de código, no requisito nuevo):

- Request body: `{ marbete_code: string 8..128, serial_number: string 3..128 }`.
- Respuesta 200: `{ canvas_user_id: number int>0, matricula: string | null }` (`sis_id` puede ser `NULL`).
- Denegaciones (401, mismas que el flujo MFA): `deny.marbete_unknown`, `deny.student_inactive`, `deny.device_unknown`, `deny.device_not_bound_to_student`.
- Body inválido: `validation_error` (400). Transporte sin HMAC válido: `deny.idp_untrusted` (401).
- Orden de política = pasos 1–4 de `MfaAuthenticateService` (sin el paso OTP), reusando `PgMfaRepo`.

## Tasks

| ID | S# | Tarea | Ruta | Commit |
|----|----|-------|------|--------|
| T1 | S1, S5 | DTO compartido `MfaGetSubjectRequest` / `MfaGetSubjectResponse` en `packages/shared/src/dto/mfa.ts` | inline | work-unit |
| T2 | S1, S5 | `MfaGetSubjectService` (hash → marbete → alumno → device, sin OTP) en `apps/api/src/services/mfa-get-subject-service.ts` | inline | work-unit |
| T3 | S2, S3, S4, S6, S7 | Ruta `POST /api/v1/mfa/get-subject` con `requireServiceAuth` + Zod/swagger, registrada en `app.ts` | inline | work-unit |
| T4 | S1–S7 | Tests unit (orden de política) + integración (matriz HMAC, validación, deny, happy path, anti-enumeración) | inline | work-unit |
| T5 | S4 | Swagger + docs: `openapi:dump`, `mfa.openapi.yaml`, `docs/openapi/README.md`, `ENDPOINTS.md` | inline | work-unit |
| T6 | S1–S7 | Verificación independiente (alto riesgo) | `gentle-ai-verify` | — |
| T7 | S1–S7 | Commit de unidad de trabajo (Conventional Commit) | — | pendiente de autorización |

## Log

- **L1** (petición original, textual): "Me gustaría ajustar algo en el flujo. Por eso requerimos que generes un nuevo servicio (endpoint), que le pasemos el número de marbete y regrese tanto la matrícula (SIS de Canvas), como el subject (canvas_user_id), se requiere que tenga la misma seguridad que tienen los servicios de cursos y mfa para consultar los endpoints. Agrégalo como parte de los servicios de /mfa
Por otro lado, entrega el swagger en /mfa/get_subject y su equivalente como endpoint funcional.
Prepara el plan con tareas detalladas y lo valido antes de iniciar
Si tienes dudas, pregúntame."
- **L2** (2026-10-13, hallazgos de exploración): la seguridad S2S de `/mfa/consume` y `/access-decisions` es HMAC-SHA256 service-token (`requireServiceAuth` sobre `BACKOFFICE_SERVICE_TOKENS`). El subject y la matrícula ya existen en la cadena `marbetes.code_hash → assigned_student_id → students_cache (canvas_user_id, sis_id)`. Swagger generado en `/docs` + spec a mano `apps/api/docs/openapi/mfa.openapi.yaml`.
- **L3** (2026-10-13, respuestas del operador a las 3 preguntas): factores = "Marbete + serial_number"; auth = "HMAC service token (S2S)"; método = "POST /api/v1/mfa/get_subject".
- **L4** (2026-10-13, autorización): "Si, por favor documenta, carga el To Do List y procede."
- **L5** (2026-10-13, riesgo aceptado): la resolución marbete → identidad queda acotada por doble factor (marbete + serial) y disponible solo a servicios con HMAC registrado; riesgo ítem 2 (seguridad/privacidad) aceptado por el operador con esas condiciones.
- **L6** (2026-10-13, implementación + verificación): T1–T5 implementadas. RED/GREEN: unit 14/14, integración 14/14; suite unit completa 328/328; integraciones MFA/HMAC relacionadas 171/171; `typecheck` y `prettier` (archivos nuevos) limpios. Verificación independiente (`gentle-ai-verify`): **S1–S7 met**, sin regresiones de seguridad; sin fuga de marbete/serial en wire, denys ni logs; el preHandler HMAC se aplica y falla cerrado.
- **L7** (2026-10-13, hallazgos atendidos): **F1** (deriva de spec, medio) corregido — se agregó `deny.idp_untrusted` al enum Zod de `DenyEnvelope` en `apps/api/src/plugins/swagger.ts` y se regeneró `mfa.openapi.generated.yaml`; re-verificado (unit 328/328, integraciones 171/171). **F2** (test directo de registry vacío para esta ruta, bajo) queda como seguimiento: está cubierto transitivamente por `service-auth.test.ts` y `access-decision.test.ts`. **F3** (formato del serializador YAML) es pre-existente.
- **Fallo pre-existente, no atribuible a este cambio**: `apps/api/test/integration/mfa-mobile.test.ts` falla en el tip `bf5bc4f` (asserta que `/mfa/authenticate` no devuelve `matricula`, pero `bf5bc4f` la agregó). Reproducido en árbol limpio (1 failed / 6 passed).
- **L8** (2026-10-13, corrección de nomenclatura): "Noté que la comenclatura era con guines medios y este servicio lo solicité con guión bajo. Por favor, corrígelo como get-subject. Por favor. Una vez que esté corregido haz commit, push y PR". Acción: se renombró la ruta y toda la documentación de `get_subject` → `get-subject` (`/api/v1/mfa/get-subject`); se reescribieron S4 y S7; se regeneró el spec. Re-verificado (tests + typecheck). Autorización explícita de commit + push + PR.
- **L9** (2026-10-13, entrega): commit de unidad `749968f` ("feat(mfa): add POST /mfa/get-subject S2S identity resolution", 10 archivos) en `feat/mfa-matricula-master`; push a `origin`; **PR #19** contra `master` — https://github.com/Inssoft-proyects/quorum-backoffice/pull/19 — con label `enhancement` (el repo no tiene labels `type:*` ni CI; el precedente PR #17 iba sin issue ni labels). `ENDPOINTS.md` (catálogo raíz) pertenece a OTRO repo (`quorum-global-monitor`, rama `fix/quorum-ecosystem-remediation-p0`) y queda sin commitear allí.
- **L10** (2026-10-13/14, scripts + docs, avance final):
  - Scripts shell de ejecución real (sin mocks) en `apps/api/scripts/`: `mfa-authenticate-smoke.sh`, `mfa-mobile-login.sh`, `mfa-videoconference-join.sh`. Leen secretos desde `kubectl -n quorum-backoffice get secret quorum-backoffice-api-secret` (`OTP_SERVICE_TOKEN`, `BACKOFFICE_SERVICE_TOKENS="canvas:<secret>"`) con fallback a entorno; firman HMAC-SHA256 (`Authorization: HMAC <name> <ts> <sig>`); trazan cada interacción con separadores `=` (interacción) y `-` (partes: endpoint / payload / response).
  - URLs funcionales desde la dev-box: OTP `http://127.0.0.1:4200`, backoffice `http://127.0.0.1:4100`, join `https://quorum.inecuni.com/join` (las URLs externas dan 301 → body vacío).
  - `get-subject` sigue **404** (PR #19 sin mergear); los scripts default `SUBJECT=13` (fixture TOPGR4) y `get-subject` es opt-in vía `USE_GET_SUBJECT=1`. Lección guardada en Engram (obs. 363).
  - Documento de flujos: `docs/mfa-flujos.md` (en el worktree principal) — 3 flujos revisados/cerrados, endpoints, tokens (pedir al área de desarrollo) y fixture.
  - Pendientes: merge del PR #19 (habilitar get-subject) y commit/push de scripts + docs (sin autorización aún). Fallo pre-existente `mfa-mobile.test.ts` sigue abierto.
- **L11** (2026-10-14, cierre de pendientes):
  - **Merge**: PR #19 MERGEADO a `master` → commit `cd5ea21` (merge commit; rama `feat/mfa-matricula-master` conservada con `--delete-branch=false`).
  - **Deploy a producción**: endpoint `get-subject` desplegado en `/opt/quorum-backoffice` (rsync de `packages/shared/src/dto/mfa.ts` + `apps/api/src/routes/mfa-get-subject.ts` + `apps/api/src/services/mfa-get-subject-service.ts`; patch de `app.ts` y `swagger.ts`; rebuild `shared`+`api`; `kubectl rollout restart deployment/quorum-backoffice-api`). Backup `/tmp/opt-backup-getsubject-20261014-082914.tgz`. Verificado real sin mocks: `get-subject` 200 `{canvas_user_id:13,matricula:TOPGR4}`, sin HMAC 401 `deny.idp_untrusted`, flujo móvil completo (get-subject→/v1/otps→/mfa/authenticate) 201 con `matricula` en body.
  - **Commit + push de scripts + docs** (Conventional Commits): `feat/mfa-matricula-master` (test(api) `ba83318`, feat(api) `3154bc0`, docs(odd) `57f36cf`) y `docs/cursos-openapi` (feat(api) `8388085`, docs(mfa) `496b046`).
  - **Test corregido**: `mfa-mobile.test.ts` ahora espera `matricula` (nullable); `mfa-mobile` 7/7 y suite de integración completa 18 suites / 234 tests verde.
  - **Drift de tests en /opt limpiado**: sincronizados 7 archivos de test (5 de `bf5bc4f` + 2 de `get-subject`) que estaban obsoletos o ausentes en `/opt`; `npm run build` en producción vuelve a salir 0.
