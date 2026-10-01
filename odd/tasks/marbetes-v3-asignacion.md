# Marbetes v3 — re-paridad, carga masiva .xlsx y pantalla Asignación de marbetes

> Re-revisar `/backoffice/marbetes` y su modal de carga masiva contra el canon
> actualizado en `/planQuorum/dev/quorum-design/design/Inec/Inec/`, y crear la
> pantalla `/backoffice/asociar` (Asignación de marbetes) con entrada de menú
> entre Marbetes y Dispositivos.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `marbetes-v3-asignacion` |
| Rama | `feature/marbetes-v3-asignacion` (desde `master`) |
| Tipo | UI parity + feature nueva full-stack (web + api + shared) |
| Canon de diseño | `/planQuorum/dev/quorum-design/design/Inec/Inec/` (NO el copy stale en `diseno/maqueta_Inec/`) |
| Archivos canon | `inventario-credenciales.html`, `carga-masiva-marbetes.html`, `asignacion-marbetes.html` + `css/` + `js/` |

## 2. Decisiones del usuario (2026-10-01)

1. **Carga masiva sigue siendo MODAL** dentro de `/marbetes`, pero rediseñado por
   completo según `carga-masiva-marbetes.html`: dropzone drag&drop, estados
   vacío/seleccionado, overlay de procesamiento con checklist de 6 etapas y
   barra de progreso, vista de resultado con métricas de error.
   Desviaciones intencionales respecto al canon: sin breadcrumb ni chrome de
   página, sin sección de simulación de hoja de cálculo (el diseño la tiene
   porque es página completa).
2. **Se adopta .xlsx** con botón "Descargar plantilla" (plantilla con orden de
   columnas correcto y hoja de ayuda de cómo llenarla).
3. **Matrículas con sync completo desde Canvas**: nuevo servicio de sincronización
   en el API que recorre el portal-api (`GET {CANVAS_PORTAL_API_URL}/v1/students`
   paginado) y upserta `students_cache` (incl. `is_active`). La pantalla lista el
   universo real hidratado. Riesgo: verificar en runtime que `/v1/students`
   sin `search` devuelve el roster completo paginado; si no, se abre work item
   aparte en quorum-canvas (fuera de alcance de este plan).
4. **OTP con ventana de 20 minutos**: un OTP verificado habilita operaciones
   destructivas de marbetes (create/update-assign/delete/bulk_create) durante
   ≥20 min para ese actor. Tabla nueva `otp_grants`; el diálogo muestra
   "OTP vigente hasta HH:MM" y omite el campo mientras haya grant activo.
   `marbete.reveal` conserva su propio OTP por operación (no entra en la ventana).

## 3. Hallazgos de exploración (base del plan)

- Menú en `apps/web/components/layout/sidebar.tsx:20-27` y réplica en
  `components/layout/mobile-nav.tsx:25-36`. Guard de auth en
  `app/(authed)/layout.tsx` (cubre `/asociar` automáticamente).
- Marbetes page actual: `app/(authed)/marbetes/_components/marbetes-page-client.tsx`
  + componentes compartidos en `apps/web/components/inventory/`.
- Dead code en `_components/`: `create-dialog.tsx`, `edit-dialog.tsx`,
  `delete-dialog.tsx`, `marbetes-filters.tsx`, `status-cards.tsx` (no importados).
- Asignación marbete↔matrícula YA existe: `marbetes.assigned_student_id` FK a
  `students_cache` (`canvas_user_id` = matrícula), PATCH `/api/v1/marbetes/:id`
  con `canvasUserId` (null desasigna), unique partial index un marbete activo
  por estudiante. NO existen: listado paginado de matrículas, asignación masiva,
  sync de students_cache.
- `CanvasClient` (`apps/api/src/services/canvas-client.ts`) ya consume
  `{CANVAS_PORTAL_API_URL}/v1/students` con Bearer token; `search` es opcional
  → base para el sync completo.
- OTP actual: `verifyOtp(actor, scope, code)` por operación destructiva,
  single-use, vía quorum-otp HMAC (`apps/api/src/services/otp-client.ts`).
- Harness de paridad `apps/web/e2e/lookfeel`: resuelve el maquette a
  `diseno/maqueta_Inec/Inec` (copia STALE del canon); `12-maquette-parity`
  hace pixel+structural diff; no cubre bulk modal ni `/asociar`.
- `students_cache` no tiene fecha de registro de la matrícula; la columna
  "Fecha de registro" del diseño se alimentará de `last_synced_at` (mejor
  dato disponible). "Usuario" (quién asignó) requiere `assigned_by` nuevo en
  `marbetes`.

## 4. Gaps a cerrar — pantalla Marbetes (T2)

Fuente: scout report + diff del canon nuevo vs copy stale.

- G1 Banner global `.app-alert` dismissable tras Add/Revoke (hoy solo reveal
  inline, sin close).
- G2 Card "Por atender" sin donut; el canon da chart a las 4 cards.
- G3 Chip "Filtrar" visible en cards inactivas ("Filtro activo" en la activa).
- G4 Headers de tabla sortables (`sort-button`, `aria-sort`) — existe
  `sort-header.tsx` sin usar.
- G5 Clases de celda `.data-table__date` y `.data-table__validity*` según canon.
- G6 Botones de acción `.admin-action(--reveal|--danger)` con sprite SVG
  `icon-reveal`/`icon-eye-off` (hoy `.row-action` + lucide).
- G7 Prefijo bold "Solo el " en el porcentaje de "Por atender".
- G8 `<h2 class="sr-only">Indicadores del inventario</h2>` landmark.
- G9 Diff de CSS del canon (`credential-inventory.css`, `components.css`):
  `.inventory-header__bulk-link`, hover de `admin-action--danger`, ajustes de
  `metric-card__meta` responsive — portar a `globals.css`.
- G10 Borrar dead code de `_components/`.

## 5. Gaps a cerrar — modal Carga masiva (T4+T5)

- B1 Dropzone `.xlsx` con drag&drop, `is-dragging`/`is-error`, estados
  empty/selected, metadata de archivo y bloque "Datos generados automáticamente"
  (vigencia = carga + 3 años).
- B2 Botón "Descargar plantilla" (.xlsx generada, con hoja de instrucciones).
- B3 Overlay de procesamiento: 6 etapas (read/rows/format/duplicates/existing/
  result) + progressbar + nota.
- B4 Resultado: heading "Carga procesada", summary, 4 metric cards de error
  (dígitos, caracteres, duplicado, ya registrado), "Subir nuevo archivo" y
  descarga de `.xlsx` de errores.
- B5 Backend: `POST /api/v1/marbetes/bulk-xlsx` (parseo server-side, misma tx
  y respuesta per-row de `bulkCreate`, + workbook de errores en base64).
- B6 OTP dentro del modal, consciente de la ventana de 20 min (T3).

## 6. Pantalla nueva /asociar (T6+T7)

Canon: `asignacion-marbetes.html` + `assignment-marbetes.css/js`.

- API: DTOs `packages/shared/src/dto/matricula.ts`; `GET /api/v1/matriculas`
  (join students_cache ⋈ marbetes, filtro assigned/unassigned, search, paginación)
  + `GET /api/v1/matriculas/counters`; `POST /api/v1/matriculas/assign`
  (bulk pairs, admin, OTP window scope `marbete.assign`, audit); desasignación
  vía `POST /api/v1/matriculas/unassign` (marbeteId, motivo, comentario, OTP
  window); `POST /api/v1/matriculas/sync` (admin; hidrata students_cache desde
  portal-api; sin OTP — operación de lectura hacia Canvas).
- Migración `0013`: `marbetes.assigned_by TEXT` + índice para el join.
- Web: `app/(authed)/asociar/page.tsx` (server, role operator+) + client con:
  4 metric cards (Matrículas totales / Marbetes disponibles / Disponibles sin
  marbete / Asignados — las dos últimas actúan como filtro de tab), tabs
  "Sin asignar"/"Asignados", tablas con checkbox y paginación independiente por
  tab, búsqueda compartida, barra de selección con límite = marbetes
  disponibles, modal de asignación (propuesta matrícula→marbete con select
  por fila, búsqueda y swap de conflictos), modal de desasignación (motivo
  obligatorio + comentario), reveal de número, banner de éxito dismissable.
- Menú: `{ href: '/asociar', label: 'Asignación' }` entre Marbetes y
  Dispositivos en `sidebar.tsx` y `mobile-nav.tsx`.
- Matrículas de alumnos y maestros: depende de lo que devuelva
  `/v1/students` (verificar en runtime; si solo cubre alumnos, queda como
  follow-up en quorum-canvas — documentado en riesgos).

## 7. Plan de tareas

| # | Task | Alcance | Verificación |
| --- | --- | --- | --- |
| T1 | Harness de paridad apunta al canon nuevo (env `MAQUETTE_DIR`, preferencia `quorum-design`) | `apps/web/e2e/lookfeel/helpers/maquette-server.ts` | unit/config check |
| T2 | Fixes de paridad pantalla Marbetes (G1–G10) | `apps/web/app/(authed)/marbetes/`, `components/inventory/`, `globals.css`, tests | unit + typecheck |
| T3 | Ventana OTP 20 min (`otp_grants`, grant-aware verify, endpoint de estado, UI) | `apps/api/`, `packages/shared/`, `apps/web/components/inventory/*dialog*` | unit api + web |
| T4 | Backend .xlsx: `bulk-xlsx`, plantilla, workbook de errores | `apps/api/`, `packages/shared/`, `apps/web/public/assets/`, script generador | unit api |
| T5 | Modal de carga masiva rediseñado (B1–B6) | `apps/web/components/inventory/bulk-upload-dialog.tsx`, `globals.css` | unit + typecheck |
| T6 | API matrículas: list/counters/assign/unassign/sync + migración 0013 | `apps/api/`, `packages/shared/` | unit + integración |
| T7 | Pantalla `/asociar` + menú | `apps/web/app/(authed)/asociar/`, `components/layout/`, `lib/api-client.ts`, `globals.css` | unit + typecheck |
| T8 | Verificación global: typecheck, unit, harness de paridad (marbetes + asociar), screenshots Playwright | todo | gentle-ai-verify |

Dependencias: T3 antes de T5/T6/T7 (OTP window consumida por esos flujos);
T4 antes de T5; T6 antes de T7; T1 y T2 independientes.
Cada tarea cierra con un commit work-unit (Conventional Commits) en la rama.

## 8. Riesgos / follow-ups conocidos

- R1 `/v1/students` sin `search` podría no devolver roster completo → verificar
  en runtime (T6); fallback: work item en quorum-canvas.
- R2 Maestros: si portal-api solo expone alumnos, follow-up en quorum-canvas.
- R3 "Fecha de registro" de matrícula: se usa `last_synced_at` (mejor dato).
- R4 Sync de `students_cache` es manual (botón/endpoint); no hay scheduler.
- R5 La ventana OTP de 20 min relaja single-use por diseño del usuario; queda
  auditada (cada op registra grant + otpId original).

## 9. Registro de commits

| Task | Commit | Evidencia |
| --- | --- | --- |
| T1 | `c613a6a` | harness resuelve canon quorum-design + env MAQUETTE_DIR |
| T2 | `e1a79ed` | G1/G3–G9 cerrados; G2 skip por canon (card sin chart); G10 diferido (tests/e2e referencian archivos legacy); 26 suites / 126 tests web, typecheck ok |
| T3 | `95a12ad` | otp_grants (migración 0012), verifyOtp grant-aware (reveal exento), GET /api/v1/marbetes/otp-grant, hook useOtpGrant + diálogos Add/Revoke grant-aware; api 6 suites/56 tests, web 29 suites/142 tests; integración diferida (sin DB local) |
| T4 | `4e819f9` | POST /api/v1/marbetes/bulk-xlsx + taxonomía de errores + workbook de errores + plantilla oficial en apps/web/public/assets/; api 7 suites/75 tests; shared+web ok |
| T5 | `893c2ea` | Modal carga masiva rediseñado (dropzone .xlsx, overlay 6 etapas, resultado con 4 métricas de error, plantilla, errores xlsx, OTP grant-aware); web 29 suites/151 tests |
| T6 | pendiente | — |
| T7 | pendiente | — |
| T8 | pendiente | — |
