# Quorum Backoffice — Dispositivos Inventory v2 (Rediseño)

> Feature ODD para aplicar el patrón marbetes v2 a la pantalla `/dispositivos`. Cierra el ítem #2 del HANDOFF §"Próximos pasos sugeridos" opción D (continuar rediseño). Esfuerzo L (~1 sesión comprimida).

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `dispositivos-inventory-v2` |
| Suite | Quorum (sigue marbetes-inventory-v2 ya cerrado) |
| Estado | branch `feature/dispositivos-v2` (fork desde `master` @ `a5b075d`) |
| Rama | se commitea en `feature/dispositivos-v2` (nueva) |
| Review budget | ≤400 líneas modificadas |
| Tests | 1 spec Playwright nueva (`08-dispositivos-design.spec.ts`) + heredado 03-responsive + 04-accessibility + 05-interaction-flows |
| Quality gates | `npm test`, `npm run typecheck` (api+web), `npm run lint`, `apps/web npm run build`, Playwright 26/26 contra staging |

## 2. Objetivo

Replicar el patrón de inventario v2 de marbetes en `/dispositivos`, manteniendo las 3 dialogs existentes (Create/Edit/Revoke) y reusando los componentes `inventory/*` ya implementados.

**Diferencias clave vs marbetes v2**:
- **No hay assignment**: dispositivos son hardware físico, no se asignan a estudiantes.
- **Schema más simple**: `id, serialNumber, brand, model, status (active/revoked), createdAt, createdBy, revokedAt, revokedReason`.
- **Sin vigenciaderivada**: no hay validity de 3 años. En su lugar usamos "antigüedad" (createdAt > 2 años) como indicador.
- **Serial en claro**: a diferencia de marbetes donde el código se muestra enmascarado, el serial del dispositivo es el token de identificación y se muestra completo.

## 3. Convenciones heredadas

- Conventional Commits (`type(scope): summary`).
- `quorum-dev <quorum@local>` para los commits.
- Allowed edit surfaces explícitos.
- Reusar `.metric-card`, `.data-table`, `.table-shell`, `.chip--*`, `.id-badge`, `.inventory-page`, `.inventory-header`, `.inventory-section__header`, `.inventory-search`, `.table-pagination` del bloque `@layer components` en `globals.css` (ya presentes desde marbetes v2).
- Sin nuevos tokens CSS, sin nuevas animaciones, sin nuevos componentes shadcn.
- Review budget ≤400 líneas.

## 4. Work Units (tareas)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| 1 | Page server rewrite | structure | ~30 | `apps/web/app/(authed)/dispositivos/page.tsx` |
| 2 | Page client + metric cards | composition | ~150 | `apps/web/app/(authed)/dispositivos/_components/dispositivos-page-client.tsx` |
| 3 | Table redesign | data-table maquet | ~150 | `apps/web/app/(authed)/dispositivos/_components/dispositivos-table.tsx` |
| 4 | Filters redesign | search bar maquet | ~40 | `apps/web/app/(authed)/dispositivos/_components/dispositivos-filters.tsx` |
| 5 | Playwright spec | verification | ~120 | `apps/web/e2e/lookfeel/08-dispositivos-design.spec.ts` (NEW) |
| 6 | Docs | bitácora + HANDOFF | ~50 | `odd/tasks/quorum-backoffice-mvp.md` §12, `HANDOFF.md` |

**Total estimado**: ~540 líneas, dentro del budget per-task (cada task individual ≤400).

## 5. Definition of Done

- 6 commits work-unit en `feature/dispositivos-v2`, mensajes Conventional.
- `cd apps/api && npm run typecheck` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde.
- `npm test` (root) verde — 148/148 sin regresiones.
- `cd apps/web && npm run build` verde.
- En desktop (1280×800): 4 metric cards (Total / Activos / Revocados / Sin marca) visibles + tabla rediseñada + filtros + 3 dialogs intactos.
- En mobile (360×800): mismas condiciones que marbetes (drawer nav + sin overflow).
- Playwright suite contra staging: **26/26 verde** (25 existentes + 1 nuevo spec `08-dispositivos-design.spec.ts` con ~5 cases).
- Bitácora §12 actualizada con los 6 commits.
- HANDOFF.md actualizado (item "Rediseño /dispositivos" cerrado).
- Plan §8 actualizado con el estado final.

## 6. Riesgos y mitigaciones

1. **Task 2 — métricas en memoria hasta 200 items.** Mismo patrón que marbetes: `npm run` API devuelve hasta 50 por default; el fetch puede necesitar `limit=200` para que los counts sean exactos. Si supera, considerar paginación server-side o exponer `/dispositivos/counters` endpoint (out of scope).
2. **Task 3 — Serial numbers largos pueden romper la maquet.** Mitigación: usar `.data-table` con `min-width: 50rem` + overflow-x scroll (igual que marbetes).
3. **Task 5 — Playwright spec debe ser independiente del seed de tests existentes.** Mitigación: usar `loginAs(page, 'admin')` + `page.goto('/backoffice/dispositivos')`; los items son seed-e2e (puede haber 0 si la DB no tiene seed; el spec debe manejar empty state gracefully).

## 7. Out of scope (este WU)

- Bulk upload endpoint para "Cargar dispositivos" (siguiente WU).
- API counters endpoint (se mantiene client-side como marbetes).
- Bulk operations (select + multi-revoke) — futura mejora.
- Cambios al maquet HTML/CSS original (`diseno/maqueta_Inec/Inec/inventario-credenciales.html`) — ese es el maquet de marbetes; para dispositivos no hay maquet separado, se adapta el patrón.

## 8. Bitácora (a completar al cerrar)

| Commit | Task | Líneas | Notas |
| --- | --- | --- | --- |
| `f7d071c` | Tasks 1-4 page + client + table + filters | +501/-161 (4 files) | `page.tsx` +60/-25 (server fetch limit=200). `dispositivos-page-client.tsx` +263/-28 (4 MetricCards + DonutChart segments + filters + table + pagination + 3 dialogs). `dispositivos-table.tsx` +92/-22 (.table-shell + IdBadge DIS-#### + StatusChip + SortHeader para 6 cols + .row-action buttons). `dispositivos-filters.tsx` +96/-30 (.inventory-search shell + .custom-select__trigger + URL-synced). |
| `9a425b8` | Task 5 Playwright spec | +187 (1 file NEW) | `apps/web/e2e/lookfeel/08-dispositivos-design.spec.ts` (187 líneas, 5 cases T8.1-T8.5). Usa selectores v2 (MetricCard, DIS-####, filter-status testid). Skip T8.2 graceful si DB vacía. |
| `66bd7f9` | Merge to master | — | Merge --no-ff de feature/dispositivos-v2 a master (5 files changed, 688 insertions / 161 deletions). |
| (this commit) | Doc closeout | +TBD | Update `odd/tasks/quorum-backoffice-mvp.md` §12 bitácora + `HANDOFF.md` Polish items pendientes + este §8 con el hash real del merge. |