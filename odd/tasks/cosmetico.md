# Quorum Backoffice — Cosmético: shadcn → interior.dev

> Feature ODD para sustituir los primitivos tipo shadcn de `apps/web/components/ui` por los componentes con micro-interacciones de `https://www.interior.dev/` (MIT), conservando tokens InecConecta, APIs públicas, ids, `data-testid`, textos y roles que ya consumen 38 suites RTL y 14 specs Playwright.
> Rama de trabajo: `feat/cosmetico` en el worktree `.worktrees/cosmetico`.

## Specs

- **S1** — "revises el sitio https://www.interior.dev/". Cada componente adoptado debe rastrearse a su página de origen (`https://www.interior.dev/docs/<name>`, registry `https://www.interior.dev/r/<name>.json`) y registrar esa procedencia (URL + licencia MIT) en el encabezado del archivo vendorizado.
- **S2** — "cambies los elementos tipo shadcn que tenemos por los que en ese sitio existen (Según equivalente)". Todo primitivo shadcn de `apps/web/components/ui` debe quedar mapeado a un equivalente documentado; donde existe equivalente, la implementación shadcn/Radix se reemplaza (no se conserva como base).
- **S3** — "esto permitirá tener componentes con micro interacciones profesionales". Cada reemplazo debe incorporar la micro-interacción del original: resorte que retoma desde su posición, ancho reservado sin layout shift, entrada/salida interrumpible, focus handling, y paridad bajo `prefers-reduced-motion` (la información llega, el viaje se omite).
- **S4** — "Prepara un plan para dicho cambio, genera una tabla de elemento que modificarás por cuál (Según el sitio de interior.dev)". La tabla elemento→equivalente vive en este documento y en el reporte final.
- **S5** — "Luego inicia un worktree llamado 'cosmetico' para trabajar en él". El trabajo se ejecuta en `.worktrees/cosmetico`, rama `feat/cosmetico`.
- **S6** — "Luego inicia la ejecución / No pares hasta terminar". La feature se ejecuta hasta el cierre verificado; sólo se detiene ante un bloqueo real (prueba no disponible, decisión de producto pendiente).

Invariantes no negociables (derivados del estado actual del repo):

- **I1** — Se conservan tokens InecConecta (`--color-primary-500: #ab8620`, `--color-secondary-500: #358456`, alertas, radios 4/8/12). No se introducen grises `neutral`/`stone` de interior.dev ni variantes `dark:` (el proyecto no define tokens oscuros).
- **I2** — Se conservan ids, `name`, `data-testid`, `aria-label`, roles y textos exactos consumidos por tests (`create-code`, `filter-search`, `login-error`, `pagination-range`, `pagination-page`, `pagination-prev`, `pagination-next`, `create-error`, `edit-error`, `delete-error`, `OtpInput` group `OTP code`, cajas con `Digit N of 6`).
- **I3** — El paquete nuevo permitido es sólo `motion` (dependencia declarada por interior.dev). No se añaden otras dependencias.
- **I4** — `npm test` (web) y `npm run typecheck` (web) verdes; `npm run build` (web) verde. La suite E2E de paridad contra la maqueta no puede ejecutarse sin `E2E_ADMIN_USERNAME` + OTP del servicio: se documenta como re-baseline pendiente, no se falsifica.
- **I5** — Los archivos vendorizados conservan su licencia MIT y su forma de archivo único autocontenido (sin barrels internos que oculten la dependencia `motion`).

## Tabla de equivalencias

| # | Elemento actual (shadcn) | Equivalente interior.dev | Acción |
| --- | --- | --- | --- |
| 1 | `components/ui/button.tsx` (shadcn Button + CVA) | **Press Depth** + **Loading Button** | Implementación sobre `usePressDepth`/`useAsyncAction`; API `Button` y `buttonVariants` intactas; nueva prop `loading` |
| 2 | `components/ui/input.tsx` + `components/ui/label.tsx` | **Floating Label** | Nuevo `components/ui/field.tsx` (`FloatingLabelInput`); migrar 10 formularios; `Input` queda para búsquedas sin etiqueta |
| 3 | `components/ui/textarea.tsx` | **Inline Validation** | Textarea nativo + `InlineValidation` para mensaje que no desplaza el formulario |
| 4 | `components/ui/alert.tsx` | **Collapsible Banner** | `Alert`/`AlertTitle`/`AlertDescription` sobre `CollapsibleBanner` (plegable/descartable opcional) |
| 5 | `components/ui/badge.tsx` | **Value Flash** | Insignia que marca el cambio de valor |
| 6 | `components/ui/dialog.tsx` (Radix) | **Modal** | API compuesta (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`) sobre `useModal` |
| 7 | `components/ui/otp-input.tsx` | **OTP Input** | Reemplazo directo: auto-avance, pegado, shake de error, modo controlado conservado |
| 8 | `components/ui/select.tsx` | **Dropdown** | Select sobre lista con resaltado viajero; API `options`/`value`/`onChange` intacta |
| 9 | `components/ui/dropdown-menu.tsx` (sin uso) | **Dropdown** | Reemplazo de implementación |
| 10 | `components/ui/skeleton.tsx` (sin uso) | **Skeleton Swap** | Esqueleto→contenido sin layout shift |
| 11 | `components/ui/tabs.tsx` (sin uso) | **Tabs** | Indicador compartido entre pestañas |
| 12 | `components/ui/table.tsx` (sin uso) | **Sortable Table** | Filas que viajan a su nuevo orden |
| 13 | `components/inventory/pagination.tsx` | **Pagination** | La ventana se mueve, la fila no; conserva testids y props |
| 14 | `components/inventory/bulk-upload-processing-overlay.tsx` | **Progress Bar** | Indeterminada→determinada |
| 15 | `components/layout/mobile-nav.tsx` + `audit/_components/audit-detail-drawer.tsx` | **Drawer** | Panel lateral que conserva su lugar |
| 16 | `components/ui/card.tsx` + `status-cards.tsx` | **Value Flash** | Sin equivalente de tarjeta: se conserva; contadores con flash |
| 17 | `components/inventory/masked-number.tsx` (códigos) | **Copy Button** | Copiar con tick y ancho bloqueado |

## Tasks

- **T1 · Fundación** (S1, S3, S5) — `motion` instalado; 16 fuentes vendorizadas en `apps/web/components/interior/` con procedencia, tokens InecConecta y `motion` como única dependencia nueva. Commit: `chore(web): vendor interior.dev micro-interaction sources`.
- **T2 · Button** (S2, S3) — `ui/button.tsx` sobre Press Depth + Loading Button; API intacta; prop `loading`. Commit: `feat(web): rebuild button on interior press-depth and loading-button`.
- **T3 · Field (Floating Label)** (S2, S3) — `ui/field.tsx` + migración de los 10 formularios; `Input`/`Label` quedan para casos sin etiqueta flotante. Commit: `feat(web): adopt floating-label field across forms`.
- **T4 · Textarea + Inline Validation** (S2, S3) — mensaje de error con altura reservada. Commit: `feat(web): textarea with inline validation`.
- **T5 · Alert → Collapsible Banner** (S2, S3) — API `Alert*` conservada. Commit: `feat(web): rebuild alerts as collapsible banners`.
- **T6 · Badge → Value Flash** (S2, S3) — flash al cambiar el valor. Commit: `feat(web): badge with value-flash`.
- **T7 · Dialog → Modal** (S2, S3) — API compuesta sobre `useModal`; 15 consumidores sin cambios. Commit: `feat(web): rebuild dialog on interior modal`.
- **T8 · OTP Input** (S2, S3, I2) — reemplazo directo con modo controlado y tests verdes. Commit: `feat(web): adopt interior otp-input`.
- **T9 · Select → Dropdown** (S2, S3) — API `Select` intacta. Commit: `feat(web): select on interior dropdown`.
- **T10 · Primitivos sin uso** (S2) — dropdown-menu, skeleton, tabs, table sobre sus equivalentes. Commit: `feat(web): replace unused shadcn primitives`.
- **T11 · Pagination** (S2, S3, I2) — ventana que se mueve; testids conservados. Commit: `feat(web): interior pagination`.
- **T12 · Progress Bar** (S2, S3) — overlay de carga masiva. Commit: `feat(web): progress bar for bulk upload`.
- **T13 · Drawer** (S2, S3) — mobile nav y audit detail drawer. Commit: `feat(web): drawer for mobile nav and audit detail`.
- **T14 · Value Flash + Copy Button** (S2, S3) — contadores y códigos. Commit: `feat(web): value-flash counters and copy button`.
- **T15 · Verificación y cierre** (I4, S6) — tests RTL nuevos, `npm test`, `typecheck`, `build`, `lint`, docs (`docs/interior-components.md`) y tabla de procedencia. Commit: `docs(web): document interior.dev component provenance and verification`.

## Log

- **L1** — «Para esta ocasión sobre el backend de Quorum, solicito que revises el sitio https://www.interior.dev/ y de este proyecto cambies los elementos tipo shadcn que tenemos por los que en ese sitio existen (Según equivalente), esto permitirá tener componentes con micro interacciones profesionales. Prepara un plan para dicho cambio, genera una tabla de elemento que modificarás por cuál (Según el sitio de interior.dev) Luego inicia un worktree llamado 'cosmetico' para trabajar en él Luego inicia la ejecución No pares hasta terminar»
- **L2** — Evidencia de exploración: `apps/web/components/ui` contiene 14 primitivos (10 en uso: button 22 archivos, otp-input 16, alert 16, dialog 15, input 13, label 10, textarea 3, card 3, badge 2, select 1; sin uso: dropdown-menu, skeleton, tabs, table). `motion` no estaba instalado. `components.json` declara shadcn `style: default`, `baseColor: neutral`. Tokens en `app/globals.css` `@theme`.
- **L3** — Restricción descubierta: el proyecto no define tokens `dark:`; los componentes vendorizados se adaptan a tokens claros y se eliminan las variantes `dark:` heredadas. El proveedor de tema existente no se modifica.
- **L4** — Evidencia de la librería: `https://www.interior.dev/llms.txt` (16 categorías, ~56 componentes), registry shadcn en `https://www.interior.dev/r/<name>.json` con dependencia única `motion`, licencia MIT (`https://github.com/ddoemonn/interior/blob/main/LICENSE`).
