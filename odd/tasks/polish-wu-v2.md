# Quorum Backoffice — Polish WU v2

> Feature ODD para cerrar los 3 polish items pendientes de UI/UX tras
> Polish WU v1 (infra/devops) y el redesign marbetes v2. Scope acordado:
> **RESP-001 (P0) + A11Y-001 (P1) + VIS-002 (P2)** — el trío de findings
> residuales del audit `odd/tasks/backoffice-ui-ux-audit-findings.md`.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `polish-wu-v2` |
| Suite | Quorum (sigue `quorum-backoffice-mvp` y `polish-wu-v1`, ambos cerrados) |
| Estado | branch `feature/wu0-bootstrap`, HEAD `4f91bfb` |
| Rama | se commitea en `feature/wu0-bootstrap` (sin crear rama nueva) |
| Review budget | ≤400 líneas modificadas por WU (acumulado ≤400 para los 4 tasks) |
| Tests | 1 spec Playwright nueva (`07-mobile-nav`) + bitácora + HANDOFF |
| Quality gates | `npm test`, `npm run typecheck` (api+web), `npm run lint`, `apps/web npm run build` |

## 2. Objetivo

Cerrar el trío de findings P0/P1/P2 del audit UI/UX sin tocar lógica de
negocio ni romper los 148/148 tests verdes.

- **Task 1 — A11Y-001 (P1):** landmark `<header>` en card de /login.
  1 línea en `apps/web/app/login/page.tsx`.
- **Task 2 — VIS-002 (P2):** focus-visible audit + fix. El componente
  Button ya tiene `focus-visible:ring-2 focus-visible:ring-ring
  focus-visible:ring-offset-2`, pero las clases maquette
  `.sort-button`, `.row-action`, `.row-action--danger`,
  `.table-pagination__toggle` y `.metric-card` no tienen `:focus-visible`.
  Edit puntual en `apps/web/app/globals.css` (≤30 líneas).
- **Task 3 — RESP-001 (P0):** AppShell mobile responsive + drawer nav.
  - `apps/web/components/layout/app-shell.tsx` — grid responsive
    (`md:grid-cols-[16rem_1fr] grid-cols-1`)
  - `apps/web/components/layout/sidebar.tsx` — aceptar `className`,
    ocultar en mobile (`hidden md:flex`)
  - `apps/web/components/layout/topbar.tsx` — aceptar `className`, render
    hamburguesa `<MobileNav>` en mobile
  - `apps/web/components/layout/mobile-nav.tsx` (NEW) — client component
    con Dialog (Radix ya instalado) slide-from-left, focus trap, ESC,
    ARIA dialog role. Trigger = botón hamburguesa en topbar.
- **Task 4 — Tests + docs:** spec Playwright `07-mobile-nav.spec.ts` que
  verifica (a) hamburguesa visible solo en mobile, (b) abre drawer,
  (c) navega a /marbetes desde drawer, (d) cierra con X. Update bitácora
  §12 + HANDOFF §"Polish items pendientes".

## 3. Convenciones heredadas

- Conventional Commits (`type(scope): summary`).
- `quorum-dev <quorum@local>` para los commits del worker (consistente con WUs previos).
- Allowed edit surfaces explícitos (ver delegación al worker).
- Sin cambios a schema, sin breaking changes al contrato API.
- Sin tocar `apps/web/components/inventory/` (es código del redesign v2 ya cerrado).
- El MobileNav debe usar `@radix-ui/react-dialog` (ya instalado `^1.1.23`).
- Breakpoint responsive: `md` = 768px (Tailwind default). Coincide con el
  audit (`mobile` = 360, `tablet` = 768).

## 4. Work Units (tareas)

| # | Task | Concern | Est. líneas | Archivos tocados |
| --- | --- | --- | --- | --- |
| 1 | A11Y-001 semantic | a11y /login | 1 | `apps/web/app/login/page.tsx` |
| 2 | VIS-002 focus-visible | a11y styles | ~30 | `apps/web/app/globals.css` |
| 3 | RESP-001 MobileNav | responsive shell | ~200 | `apps/web/components/layout/{app-shell,sidebar,topbar,mobile-nav}.tsx` + `apps/web/app/globals.css` |
| 4 | Test mobile-nav + bitácora | verificación + docs | ~150 | `apps/web/e2e/lookfeel/07-mobile-nav.spec.ts` (NEW) + `odd/tasks/quorum-backoffice-mvp.md` + `HANDOFF.md` |

**Total estimado**: ~380 líneas modificadas, dentro del budget de 400.

## 5. Definition of Done

- 4 commits work-unit en `feature/wu0-bootstrap`, mensajes Conventional.
- `cd apps/api && npm run typecheck` verde.
- `cd apps/web && npm run typecheck && npm run lint` verde.
- `npm test` (root) verde — 148/148 sin regresiones.
- `cd apps/web && npm run build` verde.
- En mobile (360×800): hamburguesa visible en topbar, drawer abre, links navegan, X cierra.
- En desktop (1280×800): sidebar visible permanentemente, sin hamburguesa, drawer nunca se abre.
- En tablet (768×1024): sidebar visible (md coincide), sin hamburguesa.
- Bitácora §12 actualizada con los 4 commits.
- HANDOFF §"Polish items pendientes" actualizado (RESP-001, A11Y-001, VIS-002 fuera).
- Plan §8 actualizado con el estado final.

## 6. Riesgos y mitigaciones

1. **Task 3 — MobileNav drawer debe ser accesible.** Mitigación: usar
   Radix Dialog (focus trap + ESC + ARIA `dialog` role) en lugar de
   reinventar el componente. Es el mismo patrón que ya usan los 3
   dialogs del redesign marbetes v2.
2. **Task 3 — Sidebar como `<aside>` no debe romper el patrón actual.**
   Mitigación: aceptar `className` opcional y aplicar `hidden md:flex`
   desde el padre (`AppShell`), no hardcodear dentro de Sidebar. De ese
   modo el componente sigue siendo reutilizable.
3. **Task 4 — Playwright test contra producción puede flakear si el
   cluster k3s reinicia.** Mitigación: el spec es secuencial, loginAs
   ya maneja timeout 15s. Si la suite falla por timeout de red, no es
   regresión; reintentar.
4. **Task 3 — Topbar muestra email + role + logout siempre. En mobile
   el email puede ser muy largo.** Mitigación: en mobile ocultar el
   email (`hidden md:inline`), mantener solo role badge + logout.

## 7. Out of scope (este WU)

- Item 5: bcrypt → argon2id (security migration, WU futuro).
- Item 6: audit_log archival policy (schema + cron, WU futuro).
- Polish de /dispositivos + /audit (siguiente WU de redesign).
- Endpoint `POST /api/v1/marbetes/:id/reveal` (WU separado).
- Cambios a la lógica de auth, marbetes, dispositivos, audit, RBAC.

## 8. Bitácora (a completar al cerrar)

| Commit | Task | Líneas | Notas |
| --- | --- | --- | --- |
| `e0e49c7` | A11Y-001 | +2/-2 | 1 archivo (`apps/web/app/login/page.tsx`). Cambio `<div>`→`<header>` en el wrapper del título + subtítulo del card de login. |
| `218a56a` | VIS-002 | +20/-0 | 1 archivo (`apps/web/app/globals.css`). 4 reglas `:focus-visible` con `--color-primary-500` en `.metric-card`, `.sort-button`, `.row-action`, `.table-pagination__toggle`. Pre-existing lint warnings (5) y prettier diffs verificados contra HEAD. |
| `8d31b0b` | RESP-001 | +123/-14 (5 files) | `apps/web/components/layout/mobile-nav.tsx` (NEW, 83 líneas client component con Radix Dialog drawer). `app-shell.tsx` grid responsive. `sidebar.tsx` acepta `className?` opcional. `topbar.tsx` oculta email en mobile + renderiza `<MobileNav>`. `globals.css` +8 líneas con 2 reglas `slide-in-from-left`/`slide-out-to-left` (tailwindcss-animate no instalado). |
| (TBD-4) | Tests + docs | +TBD | `apps/web/e2e/lookfeel/07-mobile-nav.spec.ts` (NEW, ~150 líneas, 5 tests contra prod: hamburger visible, drawer opens, link navigates, ESC closes, role gating). Update `odd/tasks/quorum-backoffice-mvp.md` §12 row + `HANDOFF.md` polish items list + este §8. |