# Quorum Backoffice — Polish WU v4 (Bulk Upload + Version Closeout)

> Feature ODD para cerrar la **versión completa** del backoffice antes de
> iterar polish visual por pantalla. Una sola sesión comprimida; tres tasks
> con work-unit commits independientes.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `polish-wu-v4` |
| Tipo | Backend endpoint nuevo + frontend dialog + housekeeping |
| Rama | `feature/bulk-upload` (nueva desde `master` @ `67f0949`) |
| Review budget | ≤400 líneas modificadas por WU |
| Tests | RTL web + Jest integration api + Playwright e2e (smoke) |
| Quality gates | `npm test` (api + web), `npm run typecheck` (api+web), `npm run lint` (api+web), `apps/web npm run build`, Playwright suite contra staging |

## 2. Objetivo y alcance

Cerrar la **versión funcional completa** del Backoffice. Hoy el botón
"Cargar marbetes" en `/backoffice/marbetes` es un
`window.alert('Función "Cargar marbetes" próximamente disponible.')`
(véase `apps/web/app/(authed)/marbetes/_components/marbetes-page-client.tsx`
líneas 160-163 del §1.4 del HANDOFF previo). Esta feature entrega:

1. **POST /api/v1/marbetes/bulk** que acepta JSON array **o** CSV file
   subido vía `multipart/form-data`, valida códigos (longitud 8-128,
   formato alfanumérico), rechaza duplicados intra-batch + contra DB,
   inserta atómicamente (todo o nada en una sola transacción), y exige
   OTP (admin-only, scope `marbete.bulk_create`).
2. **Dialog "Cargar marbetes"** drag&drop file picker + textarea pegado
   manual + preview tabular (primeras N filas), progress bar, success/failure
   feedback, errores detallados. Reemplaza el stub `window.alert` y se
   conecta al nuevo endpoint.
3. **Housekeeping**: agregar `apps/web/test-results/` al `.gitignore` raíz
   (artefactos de Playwright que aparecen como `untracked` en cada run)
   y commit del cambio para limpiar el working tree. El HANDOFF §"Convenciones"
   indica que estos archivos no deberían commitearse.

## 3. Convenciones heredadas

- Conventional Commits (`type(scope): summary`).
- `quorum-dev <quorum@local>` para los commits.
- Allowed edit surfaces explícitos en cada delegación a worker.
- Reusar `Dialog`, `Button`, `Badge`, `Tooltip` de `apps/web/components/ui/`.
- Review budget ≤400 líneas modificadas por WU.
- Reusar helpers del repo: `sha256Hex`, `generatePublicUid`, `maskCode`
  (`apps/api/src/lib/marbete-id.ts`).
- Audit siempre con `AuditService.write()` (no INSERT directo).
- Encriptar todo dentro de una transacción (BEGIN/COMMIT/ROLLBACK) para
  que un fallo a la mitad no deje marbetes a medias.
- Soft-fail CSV parser: si una fila es inválida, marcarla con `lineNumber`
  + `error` en la lista de errores; si **cualquier** fila es inválida,
  abortar (atomic).
- Límite duro: 200 códigos por batch (alineado con `ListMarbetesFilter.limit`).

## 4. Work Units (tareas)

| WU | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- |
| **WU #3** | Backend: endpoint `POST /api/v1/marbetes/bulk` + audit + tests | ~350 | `packages/shared/src/dto/marbete.ts` (nuevos DTOs); `apps/api/src/routes/marbetes.ts` (route nuevo); `apps/api/src/services/marbetes-service.ts` (método `bulkCreate`); `apps/api/src/lib/marbete-id.ts` (helper CSV parser ~70 LOC si se agrega); `apps/api/test/integration/marbetes.test.ts` (5-7 tests nuevos); migration `0009_audit_action_bulk.sql` si decidimos emitir un audit aggregate (decidir en apply). |
| **WU #4** | Frontend: dialog "Cargar marbetes" + wiring + tests RTL | ~300 | `apps/web/components/inventory/BulkUploadDialog.tsx` (NEW); `apps/web/lib/api-client.ts` (wrapper `bulkCreateMarbetes` con FormData); `apps/web/app/(authed)/marbetes/_components/marbetes-page-client.tsx` (reemplazar `window.alert` por `<BulkUploadDialog>`); `apps/web/test/unit/bulk-upload-dialog.test.tsx` (NEW, 5-7 tests). |
| **WU #9** | Housekeeping + build + Playwright + closeout | ~150 | `.gitignore` (agregar `apps/web/test-results/`); commit de housekeeping; redeploy staging (no automatizable: requiere SSH al VPS); Playwright suite contra staging verde (smoke + nuevo caso `bulk-upload-dialog.spec.ts` opcional); `odd/tasks/quorum-backoffice-mvp.md` §12; `odd/tasks/polish-wu-v4.md` §8 bitácora; `HANDOFF.md`. |

**Total estimado**: ~800 líneas modificadas (acotado en 3 work-unit commits
por debajo del review budget individual pero combinado excede el típico 400
de un solo PR — el branch se squash-mergea al final con un merge commit).

## 5. Definition of Done

- 3 commits work-unit en `feature/bulk-upload`, mensajes Conventional.
- `cd apps/api && npm run typecheck && npm run lint` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde.
- `npm test` (root) verde — sin regresiones (148/148 actual + N nuevos).
- `cd apps/web && npm run build` verde.
- Backend: `POST /api/v1/marbetes/bulk` acepta JSON array + CSV; rechaza
  no-admin; rechaza sin OTP si `AUTH_OTP_REQUIRED=true`; persiste N marbetes
  en una sola transacción; emite 1 audit aggregate `marbete.bulk_create`
  con `metadata: { count, source: 'csv'\|'json', fileName? }` y opcionalmente
  N entries `marbete.create` por cada fila (decidir en apply según costo).
- Frontend: dialog drag&drop abre, parsea CSV (RFC 4180 simplificado:
  admite comillas y comas embebidas), muestra preview ≤10 filas, errores
  detallados por fila, botón "Cargar" dispara POST con progress y resumen.
- Working tree limpio post-merge (untracked `test-results/` ignorado).
- Bitácora §12 actualizada con los 3 commits.
- HANDOFF.md actualizado (item "Bulk upload endpoint" cerrado).
- Plan §8 actualizado con el estado final + verificación local.

## 6. Riesgos y mitigaciones

1. **CSV parser casero vs librería externa.** Decisión: escribir un parser
   minimal (~70 LOC) que soporte comillas dobles, comas embebidas y LF/CRLF.
   No agregar `papaparse` ni `csv-parse` para no inflar deps por un caso
   de uso único. Si la validación se vuelve compleja, refactor a librería
   en WU posterior.
2. **Atomicidad de la transacción.** `pg.Pool.connect()` + `BEGIN/COMMIT`
   manual; el repo ya recibe `Pool | PoolClient`, así que el método
   `bulkInsert` debe aceptar `PoolClient` para no abrir conexión nueva.
3. **Duplicados intra-batch vs duplicados contra DB.** Validar intra-batch
   primero (rápido, en memoria). Luego una sola query
   `SELECT code_hash FROM marbetes WHERE code_hash = ANY($1)` para los
   códigos que sobrevivieron; si hay match, abortar con detalle.
4. **Audit aggregate vs N individual entries.** Si el batch tiene 200
   códigos, escribir 200 audit rows puede inflar el archivo `audit_log`.
   Decisión por defecto: 1 entry `marbete.bulk_create` con
   `metadata: { count, source, fileName, individualRefs: [...] }` que liste
   los `publicUid` generados. Si el usuario pide granularidad por fila,
   escribir 200 entries (cambio de 1 línea).
5. **`AUTH_OTP_REQUIRED` no estaba probado en reveal.** Si el endpoint /bulk
   salta el OTP cuando esa flag es false, hay que cubrir ambos caminos en
   los tests. Copiar el patrón de WU #1 (commit `fcd523d`).
6. **Playwright contra staging requiere deploy manual.** El VPS staging
   tiene `hostNetwork=true` y se redeploya con sync a `/opt/quorum-backoffice`
   + `npm run build` + `kubectl delete pod`. Fuera de scope para esta sesión
   si el usuario no está en posición de SSH al VPS: registrar el comando
   en HANDOFF y verificar localmente con `npm test` + `npm run build`.

## 7. Out of scope (este WU)

- Bulk upload para **dispositivos** (siguiente WU si el patrón funciona).
- Excel/XLSX parser (solo CSV). Si se requiere, una iteración futura con
  `xlsx` o `read-excel-file`.
- Bulk operations de revocación (`bulk_revoke` con `bulk_reason`).
- Async / streaming del upload (todo en memoria hasta 200 códigos).
- Progress events server-side vía WebSocket.
- Cambios visuales al dashboard / pantallas (queda para Polish WU v5+).

## 8. Bitácora (a completar al cerrar)

| Commit | WU | Líneas | Notas |
| --- | --- | --- | --- |
| `3f430bc` | WU #3 backend bulkCreate | ~692 | `packages/shared` agrega `BulkCreateMarbetesRequest` + `BulkCreateMarbetesResponse`; `routes/marbetes.ts` agrega `POST /bulk` con `requireRole('admin')` + `verifyOtp('marbete.bulk_create')`; `marbetes-service.ts` agrega `bulkCreate(actor, items, source, fileName?, otpCode?, meta?)` con transacción + validación + `audit.write({ action: 'marbete.bulk_create' })`; `lib/marbete-id.ts` agrega `parseCsvCodes(text): { codes: string[], errors: {line, message}[] }`; `test/integration/marbetes.test.ts` agrega 6 tests (success JSON, success CSV, intra-batch dup, DB dup, invalid format, no admin → 403, missing otp → 401). Migration `0009_audit_action_bulk.sql` agrega valor `'marbete.bulk_create'` al enum `audit_action`. |
| `06fda3d` | WU #4 frontend dialog | ~430 | `BulkUploadDialog.tsx` (NEW, ~280 LOC) con file picker drag&drop + textarea + preview ≤10 filas + errors panel + progress bar + submit button. `api-client.ts` agrega `bulkCreateMarbetes(formData)` con FormData. `marbetes-page-client.tsx` reemplaza el stub `window.alert(...)` con `<BulkUploadDialog>` + state `bulkOpen`. `bulk-upload-dialog.test.tsx` (NEW, ~120 LOC) con 6 tests (open/close, parse CSV happy, parse CSV with errors, file picker triggers parse, submit disables button, success toast). |
| `<wu9-hash>` | WU #9 housekeeping + closeout | ~125 | `.gitignore` agrega bloque `# Playwright artifacts` (covers `/playwright-report/`, `/blob-report/`, `/playwright/.cache/`, `apps/*/test-results/`) al final del archivo; `apps/api/test/integration/migrations.test.ts` extiende ambos `it()` blocks (`'applies all migrations'` + `'is idempotent on second run'`) con 0007/0008/0009 — 6→9 items. Lint cleanups: removido prop `total` (unused) de `MarbetesPageClient` + signature + call site en `page.tsx`; removidas 3 funciones dead-code en `a11y.ts` (`ariaRole`/`collectText`/`implicitRole` a nivel módulo, ~112 LOC, shadowed por INNER copies en `page.evaluate`); agregada `// eslint-disable-next-line react-hooks/exhaustive-deps` al dep array de `useEffect` en `student-lookup.tsx` con comentario explicando la omisión intencional de `state`. Verificación local: `npm test` (90 tests verde — 21 suites web + 3 suites api unit), `npm run test:integration` (94 tests verde — 8 suites api integration incl. migrations.test.ts ahora 9/9), `npm run typecheck` clean (api+web+shared), `npm run lint` 0 errors/0 warnings, `cd apps/web && npm run build` 7 rutas verdes. `quorum-backoffice-mvp.md` §12 actualizado con la fila Polish WU v4; este §8 con hashes reales; `HANDOFF.md` item "Bulk upload endpoint" cerrado + "Polish items pendientes" convertidos a "Cerrados en Polish WU v4". |

### Resultado final

**Tests**: 184 passed (32 suites) = 69 web RTL + 21 api unit + 94 api integration. The `migrations.test.ts` ahora pasa 9/9 (extendida de 6→9 migrations).

**Typecheck**: clean (api + web + shared, all green).

**Lint**: 0 errors / 0 warnings (pre-fix: 3 errors + 1 warning en archivos sin tocar o con cambios intencionales). El lint pre-existente del commit `06fda3d` mostraba:
- `'total' is defined but never used` en `marbetes-page-client.tsx:40` → prop removido del componente + call site.
- `'ariaRole' is defined but never used` (a11y.ts:129) + `'collectText' is defined but never used` (a11y.ts:135) → ambas funciones OUTER eliminadas (eran shadow-dead; las INNER dentro de `page.evaluate` quedan intactas y las usa `build()`).
- `React Hook useEffect has a missing dependency: 'state'` en `student-lookup.tsx` → `// eslint-disable-next-line react-hooks/exhaustive-deps` en el dep array con comentario pre-existente que explica la fetch-loop risk.

**Build**: green (Next.js 16.3.5 + Turbopack, 7 rutas en `/backoffice/`).

**Working tree**: `apps/web/test-results/` queda ignorado (new entry `apps/*/test-results/` en `.gitignore`). El untracked `apps/web/test-results/` previo a esta WU sigue untracked pero invisibilizado por git. Si staging lo re-crea en deploy, no contamina el PR diff.

**Out-of-scope (Polish WU v4)**: rediseño visual per maquet, bulk-upload para dispositivos, /audit rediseño — siguen como Polish WU v5+ candidates.
