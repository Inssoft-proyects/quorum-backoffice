# Quorum Backoffice — Polish WU v5 (Audit v2)

> Feature ODD para aplicar el patrón marbetes v2 a la pantalla `/audit`.
> Replica de WU #2 (dispositivos v2) adaptado a entries del audit log.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `audit-inventory-v2` |
| Tipo | UI rewrite sobre código existente (no API, no migraciones) |
| Source de diseño | `apps/web/components/inventory/*` reusados; sin maquette separado |
| Stack | Next.js 16 App Router + React 19 + shadcn/ui + Tailwind 4 |
| Branch | nueva `feature/audit-v2` desde `master` @ `f1fee3a` (post merge Polish WU v4) |
| Review budget | ≤400 líneas modificadas por WU |
| Tests | playwright spec nueva + tests RTL actualizados |

## 2. Objetivo

Adaptar el patrón de inventario v2 (4 metric cards + donut + tabla con sort + filtros en shell) a la pantalla `/audit`, manteniendo:
- API read-only intacto (`GET /api/v1/audit?entityType=...&actorId=...&action=...&since=...&until=...&search=...`)
- `AuditDetailDrawer` intacto (Dialog con `data-testid="audit-detail"`)
- 6 filtros existentes (entityType, action, actorId, since, until, search)
- 2 tests Playwright `05-interaction-flows.spec.ts` que actualmente dependen del flujo actual (T6 audit filter URL update + drawer open on row click)

## 3. Convenciones heredadas

- Conventional Commits + `quorum-dev <quorum@local>` para commits.
- Allowed edit surfaces explícitos.
- Reusar `.metric-card`, `.data-table`, `.table-shell`, `.chip--*`, `.id-badge`, `.inventory-page`, `.inventory-header`, `.inventory-section__header`, `.inventory-search`, `.table-pagination` de `@layer components` en `globals.css` (ya presentes desde marbetes v2).
- Reusar `<MetricCard>`, `<DonutChart>`, `<StatusChip>`, `<IdBadge>`, `<SortHeader>`, `<Pagination>` de `apps/web/components/inventory/*`.
- **No** agregar nuevos tokens CSS, **no** nuevas animaciones, **no** nuevos componentes shadcn.
- Sin OTP (audit es read-only); el botón "Detalle" abre drawer, no dialog.
- Review budget ≤400 líneas por task.

## 4. Work Units (tareas)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| 1 | Page server rewrite (limit=200) | structure | ~30 | `apps/web/app/(authed)/audit/page.tsx` |
| 2 | Page client + 4 metric cards + filters shell + table rediseñada | composition | ~280 | `apps/web/app/(authed)/audit/_components/audit-page-client.tsx`; `apps/web/app/(authed)/audit/_components/audit-table.tsx`; `apps/web/app/(authed)/audit/_components/audit-filters.tsx` |
| 3 | Playwright spec | verification | ~120 | `apps/web/e2e/lookfeel/09-audit-design.spec.ts` (NEW) |
| 4 | Docs | bitácora + HANDOFF | ~50 | `odd/tasks/quorum-backoffice-mvp.md` §12; `HANDOFF.md`; este §8 |

**Total estimado**: ~480 líneas, dentro del budget per-task (cada task individual ≤400).

## 5. Definition of Done

- 4 commits work-unit en `feature/audit-v2`, mensajes Conventional.
- `cd apps/api && npm run typecheck && npm run lint` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde.
- `npm test` (root) verde — sin regresiones (184/184 actual + N nuevos).
- `cd apps/web && npm run build` verde.
- En desktop (1280×800): 4 metric cards (Total / Marbetes / Dispositivos / Auth) visibles con donuts + tabla rediseñada con AUD-#### IdBadges + filtros en `.inventory-search` shell + drawer intacto.
- En mobile (360×800): drawer nav + sin overflow (mismo patrón que marbetes/dispositivos).
- Playwright suite contra staging: **35+ passed** (24+3+5+1 nuevos + 1N nuevos).
- Bitácora §12 actualizada con los 4 commits.
- HANDOFF.md actualizado (item "Rediseño /audit" cerrado).
- Plan §8 actualizado con el estado final.

## 6. Riesgos y mitigaciones

1. **Filtros actuales usan `startTransition` + URL params; transición a `.inventory-search` shell.** Mitigación: reusar el componente `marbetes-filters.tsx` con copy adaptado (sin `status select`, manteniendo entityType/action/actorId/since/until/search).
2. **Playwright `05-interaction-flows.spec.ts` línea 116 + 119 usan `getByTestId('audit-detail')` (DialogContent) — sigue siendo válido.** Verificar tras el rewrite.
3. **No hay `validateRole` adicional en /audit (auditor+ enforced en page server).** Mantener ese patrón.
4. **Métricas en memoria hasta 200 items.** Mismo patrón que marbetes/dispositivos.

## 7. Out of scope (este WU)

- Auditoría export a CSV/Excel.
- Real-time updates (SSE/WebSocket).
- Búsqueda full-text server-side (sólo en memoria con `search` field).
- Bulk actions de audit (archive/delete masivo).
- Cambios al `AuditDetailDrawer` (queda intacto per spec).

## 8. Bitácora (a completar al cerrar)

| Commit | Task | Líneas | Notas |
| --- | --- | --- | --- |
| (TBD) | Tasks 1-3 page + client + table + filters + Playwright spec | TBD | (a llenar al cierre con hashes reales) |
| (this commit) | Doc closeout | TBD | Update `odd/tasks/quorum-backoffice-mvp.md` §12 + `HANDOFF.md` + este §8 |
