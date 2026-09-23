# Backoffice UI/UX Audit — Look & Feel (Playwright)

> Audit ODD read-only del sistema de backoffice contra la URL de producción.
> Entregable: suite Playwright reproducible + informe de hallazgos + plan de
> remediación. NO modifica código de producto. NO commitea.

## 1. Identidad

| Campo | Valor |
| --- | --- |
| Feature | `backoffice-ui-ux-audit` |
| Suite | Quorum Backoffice (rama `feature/wu0-bootstrap`) |
| Tipo | Audit / investigación — sin mutación de código |
| Target | Producción `https://quorum.asistentepro.mx/backoffice/` |
| Stack auditado | Next.js 16 App Router + React 19 + shadcn/ui + Tailwind 4 |
| Stack del audit | Playwright 1.63.0 + chromium (sin deps nuevas) |
| Roles cubiertos | admin, operator, auditor (credenciales seed existentes) |
| Pantallas cubiertas | /login + /dashboard, /marbetes, /dispositivos, /audit |

## 2. Objetivo

Generar un informe **reproducible** de UI/UX que el equipo pueda usar para
priorizar fixes. El informe debe responder a cuatro dimensiones:

1. **Visual + consistencia** — tipografía, espaciado, colores, alineación,
   consistencia header/nav/footer entre pantallas, estados vacíos/cargando/error.
2. **Accesibilidad (WCAG 2.1 AA)** — roles ARIA, etiquetas de formulario,
   foco visible, navegación por teclado, contraste texto/fondo.
3. **Responsive** — layout en viewports 360 / 768 / 1280 / 1920, comportamiento
   del sidebar, formularios en pantallas chicas.
4. **Flujos de interacción** — login → navegación entre pantallas → apertura
   de diálogos CRUD (create/edit/delete/revoke) → audit viewer.

## 3. Out of scope

- Cambiar código de producto (no hay rama de fix acá).
- Tests destructivos contra datos de producción (los diálogos CRUD se
  **abren** pero no se confirman; los forms se completan pero no se envían
  si requieren OTP/datos reales).
- Migración a axe-core / lighthouse (no se agregan deps).
- Performance benchmarks (no es el objetivo).

## 4. Plan de tareas (ODD work-unit)

Cada task cierra con un artefacto verificable y al menos una corrida
exitosa de Playwright. Estado registrado en §10.

| # | Task | Artefacto | Estado |
| --- | --- | --- | --- |
| T1 | Bootstrap suite: config separada + helpers (login, viewport, snapshot, a11y) | `apps/web/e2e/lookfeel/{playwright.config.ts, helpers/}` | pending |
| T2 | Auth matrix + smoke screens para 3 roles | `apps/web/e2e/lookfeel/01-auth-and-roles.spec.ts` | pending |
| T3 | Visual consistency: computed styles + screenshots baseline | `apps/web/e2e/lookfeel/02-visual-consistency.spec.ts` + screenshots | pending |
| T4 | Responsive: 4 viewports × pantallas authed | `apps/web/e2e/lookfeel/03-responsive.spec.ts` | pending |
| T5 | Accessibility (WCAG): a11y tree + roles + labels + contraste | `apps/web/e2e/lookfeel/04-accessibility.spec.ts` | pending |
| T6 | Interaction flows: login + CRUD dialogs + audit drawer (read-only) | `apps/web/e2e/lookfeel/05-interaction-flows.spec.ts` | pending |
| T7 | Findings + remediation report | `odd/tasks/backoffice-ui-ux-audit-findings.md` + `apps/web/e2e/lookfeel/artifacts/findings.json` | pending |

## 5. Estructura de archivos

```
apps/web/e2e/lookfeel/
├── playwright.config.ts                # config separada, baseURL=prod, no webServer
├── helpers/
│   ├── login.ts                        # login() por rol + storageState
│   ├── viewport.ts                     # VIEWPORTS = {mobile, tablet, desktop, wide}
│   ├── snapshot.ts                     # screenshot full-page + viewport + named element
│   ├── a11y.ts                         # walk(page.accessibility.snapshot()) + role/label checks
│   └── contrast.ts                     # parsea rgb/rgba de CSS vars y computa ratio WCAG
├── 01-auth-and-roles.spec.ts           # T2
├── 02-visual-consistency.spec.ts       # T3
├── 03-responsive.spec.ts               # T4
├── 04-accessibility.spec.ts            # T5
├── 05-interaction-flows.spec.ts        # T6
└── artifacts/                          # gitignored (screenshots, JSON)
    ├── screenshots/<screen>/<viewport>/<role>.png
    └── findings.json

odd/tasks/
├── backoffice-ui-ux-audit.md           # este archivo
└── backoffice-ui-ux-audit-findings.md  # T7: informe final
```

## 6. Metodología de auditoría

### 6.1 Visual + consistencia (T3)

- Capturar screenshot full-page por (rol × pantalla) en viewport desktop.
- Extraer `getComputedStyle` de: `<body>`, `<h1>`, `<h2>`, `<button>`,
  `<input>`, `<table th>`, `<table td>`, sidebar `<a>`, topbar.
- Comparar valores entre pantallas del mismo rol → alertar inconsistencias
  > 1px o > 1 color hex.

### 6.2 Accesibilidad (T5)

- `page.accessibility.snapshot({interestingOnly: false})` por pantalla.
- Reglas automáticas:
  - Cada `<input>` con label asociado (`for`/`id` o `<label>` wrapper).
  - Cada `<img>` y `<svg>` con `aria-label` o `alt`.
  - Cada `<button>` con texto accesible o `aria-label`.
  - Cada `<a>` con texto accesible.
  - `:focus-visible` style distinto al default (compute `outline`).
  - Contraste texto/fondo ≥ 4.5:1 (AA) o ≥ 3:1 para texto ≥18pt.
  - Roles landmarks: `<main>`, `<nav>`, `<header>`, `<aside>`.
  - Tab order: tabbable elements sin `tabindex` positivo.

### 6.3 Responsive (T4)

- Viewports: `mobile=360×800`, `tablet=768×1024`, `desktop=1280×800`,
  `wide=1920×1080`.
- Por viewport × rol × pantalla: capturar screenshot + medir:
  - Sidebar: visible/oculto/colapsado.
  - Main: ancho en px vs viewport width (overflow horizontal).
  - Tablas: ¿scroll horizontal? ¿columnas truncadas?
  - Forms: ¿inputs full-width?
  - Botones primarios: ¿alcanzables sin scroll?

### 6.4 Flujos de interacción (T6)

- Login fallido (credenciales malas) → mensaje visible.
- Login OK → URL cambia a `/dashboard`.
- Sidebar: cada link navega a su ruta.
- Marbetes: click en "Crear" → dialog se abre, tiene título, tiene botón
  Cancelar/Cerrar; click afuera cierra; Escape cierra.
- Marbetes: filtros (status, search) → actualizan URL.
- Marbetes: status cards (OK/KO) → click cambia filtro.
- Dispositivos: análogo a Marbetes.
- Audit: click en fila → drawer abre con detalle; Escape cierra.

## 7. Severidad de hallazgos

- **P0 (blocker)**: contraste < 3.0, keyboard trap, screen reader
  rompe (form sin label, button sin nombre), overflow horizontal
  irrecuperable, JS error en consola.
- **P1 (high)**: contraste 3.0–4.4, foco no visible, sidebar rota
  en mobile, dialog sin Escape, layout desalineado.
- **P2 (medium)**: espaciado inconsistente > 4px, color hardcoded
  fuera del sistema, tipografía inconsistente, copy en inglés.
- **P3 (low)**: nice-to-have (transiciones, microcopy, icon size).

## 8. Plan de remediación (entrega del informe)

Cada hallazgo lleva:

- ID único (BUG-001, A11Y-002, etc.)
- Pantalla + rol donde se reproduce
- Pasos para reproducir
- Impacto (qué usuario se afecta, qué WCAG/heurística falla)
- Esfuerzo estimado (S/M/L)
- Sugerencia técnica concreta (archivo + cambio propuesto)
- Prioridad sugerida (orden de ejecución)

## 9. Comandos de validación

```bash
# Solo para T1–T7 (la suite es NO destructiva, safe para prod):
cd apps/web
npx playwright test --config=e2e/lookfeel/playwright.config.ts
npx playwright test --config=e2e/lookfeel/playwright.config.ts --reporter=list,html
```

## 10. Bitácora de avance

| Fecha | Task | Estado | Notas |
| --- | --- | --- | --- |
| 2026-09-22 | T1 | done | Suite reproducible en `apps/web/e2e/lookfeel/` (1 config + 5 helpers + 5 specs + .gitignore). |
| 2026-09-22 | T2 | done | 10/10 tests verde: auth matrix completa, RBAC respetado, login OK/KO funcionan. |
| 2026-09-22 | T3 | done | 1/1 test verde; `styles.json` con 1 inconsistencia (body color entre dashboard y pantallas rotas — causado por BUG-001) y 4 hits de outline:none en botones. |
| 2026-09-22 | T4 | done | 1/1 test verde; `responsive.json` con 48 filas; 4/48 overflow horizontal en mobile (3 en /dashboard + 1 en /audit operator). |
| 2026-09-22 | T5 | done | 1/1 test verde; `a11y.json` con 10 findings (3 P0 + 4 P1 + 3 P2); los P0/P1 en marbetes/dispositivos/audit son consecuencia de BUG-001. |
| 2026-09-22 | T6 | done | 1/11 tests verde (10 fallaron — el destino no carga por BUG-001). 1 skipped. |
| 2026-09-22 | T7 | done | `findings.json` consolidado + `odd/tasks/backoffice-ui-ux-audit-findings.md` con plan de remediación en 3 fases. **Hallazgo crítico**: BUG-001 P0 — las 3 pantallas con datos están caídas en producción (cookie `sid` hardcodeado vs real `__Host-sid`). |

### Resumen ejecutivo de la auditoría

- **P0**: 2 (BUG-001 + RESP-001). BUG-001 bloquea el 100% del flujo operativo.
- **P1**: 4 (3 son consecuencia directa de BUG-001, desaparecen al fix).
- **P2**: 2 (etiquetado de SVGs + audit de focus-visible).
- **Esfuerzo total de remediación**: ~1 día (Fase 1 = 30 min, Fase 2 = 2 h, Fase 3 = polish).
- **Reproducibilidad**: suite de Playwright corre contra prod sin levantar nada, ~3 min.
