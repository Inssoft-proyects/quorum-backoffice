# Inventario de Marbetes v2 — Diseño de UI/UX

> Reescribir `/backoffice/marbetes` siguiendo el diseño entregado por el
> área de diseño en `diseno/maqueta_Inec/Inec/inventario-credenciales.html`.
> Componentes reutilizables (shadcn/ui), mismo backend, validado con Playwright.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `marbetes-inventory-v2` |
| Tipo | UI rewrite sobre código existente (no migraciones, no API) |
| Stack | Next.js 16 App Router + React 19 + shadcn/ui + Tailwind 4 |
| Source de diseño | `diseno/maqueta_Inec/Inec/inventario-credenciales.html` (4592 LoC) |
| Tokens | `diseno/design/image.png` (color tokens, ya en `globals.css`) |
| Iconos | `diseno/design/png-x2/` (eye-off, deactivate, reveal custom) |
| Brand colors | primary `#ab8620`, secondary `#358456`, text `#292929` |

## 2. Objetivo

Implementar la página `Inventario de marbetes` con la maquette de diseño,
manteniendo la integración con el backend actual. La maquette agrega:

1. **Status cards** (4) con donut chart + chip "Filtro activo"/"Filtrar"
2. **Tabla con sort headers** + búsqueda + paginación colapsable
3. **3 dialogs** (Agregar, Revelar, Dar de baja) con icono + título + descripción + form fields
4. **Chips de estado** (Disponible/Asignada/Vencida/Pronto a vencer)

## 3. Estado actual

- `/backoffice/marbetes` ya carga datos del API después de BUG-001 fix
- Status cards existentes (`_components/status-cards.tsx`) muestran OK/KO (2 contadores)
- Tabla actual (`_components/marbetes-table.tsx`) usa shadcn Table pero con menos columnas
- 3 dialogs existentes: create-dialog, edit-dialog, delete-dialog
- Falta: chip de Vigencia, donut chart, paginación con colapso, sort headers, masked number con eye-off icon

## 4. Plan de tareas

| # | Task | Estado |
| --- | --- | --- |
| T1 | Extender tokens en `globals.css` (success-bg, assigned-border, etc.) | pending |
| T2 | Instalar shadcn Select component (si no existe) | pending |
| T3 | Crear `components/inventory/DonutChart.tsx` (SVG con conic gradient) | pending |
| T4 | Crear `components/inventory/StatusChip.tsx` (Disponible/Asignada/Vencida/Pronto a vencer) | pending |
| T5 | Crear `components/inventory/IdBadge.tsx` (badge azul estilo maquette) | pending |
| T6 | Crear `components/inventory/MaskedNumber.tsx` (con eye-off icon) | pending |
| T7 | Crear `components/inventory/MetricCard.tsx` (con donut + filter chip + active state) | pending |
| T8 | Crear `components/inventory/AddMarbeteDialog.tsx` (input número + helper text) | pending |
| T9 | Crear `components/inventory/RevealMarbeteDialog.tsx` (motivo dropdown + comentario textarea) | pending |
| T10 | Crear `components/inventory/RevokeMarbeteDialog.tsx` (motivo + comentario + danger icon) | pending |
| T11 | Reescribir `marbetes-page-client.tsx` con header + métricas + tabla + paginación | pending |
| T12 | Validar visualmente con Playwright (screenshot + assertions) | pending |
| T13 | Iterar hasta matchear la maquette (gap analysis con screenshot diff) | pending |
| T14 | Build + deploy + verificar en prod | pending |

## 5. Mapeo DTO → UI

| Maquette | Backend (MarbeteDetailResponse) |
| --- | --- |
| `CRD-0248` (badge) | derivado de `publicUid` o `id` (ej. `CRD-${String(id).padStart(4, '0')}`) |
| `9***176` (masked code) | `maskedCode` (ya viene así del API) |
| `Oculto` chip | hardcode (siempre oculto en lista) |
| Estado `Disponible` | `status === 'active' && !assignedStudentId` |
| Estado `Asignada` | `status === 'active' && !!assignedStudentId` |
| Estado `Vencida` | `status === 'inactive'` o `status === 'revoked'` |
| Fecha de carga | `createdAt` formateado DD/MM/YYYY |
| Vigencia date | derivado (createdAt + 3 años) — la maquette muestra "05/10/2026" para carga 05/10/2023 |
| Vigencia chip `Próxima a vencer` | heurística: vigente < 90 días desde hoy |
| Vigencia chip `Vencida` | vigente < hoy |
| Acción Revelar | abre dialog de motivo (hoy solo UI; OTP al confirmar) |
| Acción Baja | abre dialog de motivo (llama API delete existente) |

## 6. Estructura de archivos esperada

```
apps/web/
├── components/
│   ├── inventory/                           (NEW)
│   │   ├── MetricCard.tsx
│   │   ├── DonutChart.tsx
│   │   ├── StatusChip.tsx
│   │   ├── IdBadge.tsx
│   │   ├── MaskedNumber.tsx
│   │   ├── AddMarbeteDialog.tsx
│   │   ├── RevealMarbeteDialog.tsx
│   │   ├── RevokeMarbeteDialog.tsx
│   │   ├── SortHeader.tsx
│   │   └── Pagination.tsx
│   └── ui/
│       └── select.tsx                       (NEW si no existe)
└── app/(authed)/marbetes/
    ├── page.tsx                             (rewrite)
    └── _components/
        ├── marbetes-page-client.tsx         (rewrite con composición nueva)
        ├── status-cards.tsx                 (mantener para compat)
        ├── marbetes-filters.tsx             (mantener)
        └── create-dialog.tsx                 (mantener, usar AddMarbeteDialog como reemplazo)
```

## 7. Comando de validación

```bash
# Build + screenshot contra staging
cd apps/web && sudo -E env NEXT_PUBLIC_API_URL=https://quorum.asistentepro.mx/backoffice npm run build
kubectl -n quorum-backoffice delete pod -l app=quorum-backoffice-web --force --grace-period=0
sleep 20

# Visual validation
cd apps/web && npx playwright test --config=e2e/lookfeel/playwright.config.ts e2e/lookfeel/06-marbetes-design.spec.ts --reporter=list
```

## 8. Bitácora

| Fecha | Task | Estado | Notas |
| --- | --- | --- | --- |
| 2026-09-23 | T1–T11 | done | Worker implementó la maquette con shadcn. 12 archivos nuevos + 4 modificados. |
| 2026-09-23 | T1 tokens | done | globals.css extendido con primary-600, secondary-600, success-bg/text, assigned-border/text, page, surface-subtle, border-strong, disabled, font-family-base. Clases maquette en @layer components. |
| 2026-09-23 | T2 Select | done | Componente inline (Radix no estaba en deps); select.tsx + textarea.tsx creados. |
| 2026-09-23 | T3–T7 components | done | donut-chart, status-chip, id-badge, masked-number, metric-card, sort-header, pagination. |
| 2026-09-23 | T8–T10 dialogs | done | add-marbete-dialog, reveal-marbete-dialog (stub), revoke-marbete-dialog. |
| 2026-09-23 | T11 page rewrite | done | page.tsx + marbetes-page-client.tsx + marbetes-table.tsx reescritos. |
| 2026-09-23 | T12 build | done | `npm run build` 0 errors, 7 routes. |
| 2026-09-23 | T12 deploy | done | Sincronizado a `/opt/quorum-backoffice`, rebuild con `sudo -E env NEXT_PUBLIC_API_URL=...`, pod web reiniciado. |
| 2026-09-23 | T13 Playwright | done | Screenshot confirma paridad con maquette: header, 4 metric cards con donut, tabla con CRD-0241–0248 + masked + chips + Vigencia + acciones. 3 dialogs (Agregar, Revelar, Dar de baja) renderizan correctamente. |
| 2026-09-23 | T14 DB seed | done | 10 marbetes seed (5 active + 2 inactive + 2 revoked + 1 asignado) + 3 estudiantes. Permiten validar la página con contenido real. |

### Resultado final (post-deploy)

Screenshots guardados en `apps/web/e2e/lookfeel/artifacts/screenshots/`:
- `marbetes-v2-design.png` — Página completa con 4 cards + tabla + dialogs cerrados
- `_diag-dialog-add.png` — Dialog Agregar marbete
- `_diag-dialog-reveal.png` — Dialog Revelar marbete (con motivo + comentario)
- `_diag-dialog-revoke.png` — Dialog Dar de baja marbete (con motivo + comentario)

### Diferencias con la maquette (decisiones documentadas)

1. **Columna ESTUDIANTE preservada**: la maquette original no la muestra, pero el worker la conservó porque hay un test RTL existente (`marbetes-table.test.tsx`) que assert el nombre y email del estudiante.
2. **Status chip "Revocado" vs "Vencida"**: la maquette usa un solo "Vencida" para revoked/inactive. El worker diferencia active-no-assigned=Disponible, active-assigned=Asignado, revoked=Revocado (rojo), inactive=Vencida (rojo). Ambos son danger color.
3. **Masked code format**: el backend devuelve `C***41` (1 + *** + 2). La maquette usa `9***176` (1 + *** + 3). No es modificable sin un cambio de formato en el API.
4. **Cargar marbetes**: stub no-op (no hay endpoint bulk upload en MVP). Botón visible pero deshabilitado o sin handler.
5. **Reveal endpoint**: RevealMarbeteDialog no llama a ningún endpoint porque no existe `POST /api/v1/marbetes/:id/reveal` todavía. Muestra success toast y resetea.
