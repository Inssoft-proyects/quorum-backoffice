# Componentes interior.dev — procedencia y contrato

Este documento registra qué primitivos de `apps/web/components/ui` se sustituyeron
por los componentes de [interior.dev](https://www.interior.dev/) (MIT, archivos
autocontenidos, dependencia única `motion`), qué se conservó del contrato anterior
y cómo actualizar una fuente vendorizada.

Repositorio upstream: <https://github.com/ddoemonn/interior> · Licencia:
<https://github.com/ddoemonn/interior/blob/main/LICENSE> (MIT).

## Reglas de convivencia

1. **Las fuentes viven en `apps/web/components/interior/`** con su URL de origen y
   la licencia en el encabezado. La lógica de micro-interacción (resortes, ancho
   reservado, paridad con `prefers-reduced-motion`) es la de upstream; la paleta,
   radios y anillos de foco son los tokens InecConecta.
2. **No hay variantes `dark:`**: el proyecto no define tokens oscuros. Al
   vendorizar se eliminaron todas las clases `dark:` de upstream.
3. **Los adaptadores viven en `apps/web/components/ui/`** y conservan el nombre y
   la API que ya consumían las pantallas (`Button`, `Dialog`, `Alert`, `Select`,
   `OtpInput`, `Textarea`, `Badge`), salvo donde el equivalente es inherentemente
   distinto (`Tabs`, `Table`, `dropdown-menu`).
4. **Los invariantes de prueba mandan**: ids, `name`, `data-testid`, `aria-label`,
   roles y textos en español se conservan byte a byte. Si un cambio de upstream
   choca con un test, gana el test y la adaptación se documenta aquí.

## Tabla de sustitución

| Primitivo anterior                           | Equivalente interior.dev                                                                                                                                       | Archivo adaptador                                                              | Qué se conservó                                                                                                                         | Qué cambió                                                                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button` (shadcn + CVA)                      | [Loading Button](https://www.interior.dev/docs/loading-button) (press plano; se retiró [Press Depth](https://www.interior.dev/docs/press-depth))               | `components/ui/button.tsx`                                                     | `variant`, `size`, `asChild`, `disabled`, `onClick`, `loading`/`loadingLabel` con ancho reservado                                       | La extrusión (losa inferior, `paddingBottom`, inclinación `rotateX`/`rotateY` con `perspective`) se sustituyó por un travel plano de 1 px con resorte                                                           |
| `Label` + `Input`                            | [Floating Label](https://www.interior.dev/docs/floating-label)                                                                                                 | `components/ui/field.tsx`                                                      | `id`, `name`, `type`, `value`, `onChange`, `required`, `disabled`, `placeholder`, `aria-label`                                          | La etiqueta sube a un renglón reservado; el placeholder solo aparece al enfocar; contador de `maxLength` con ancho fijo                                                                                         |
| `Textarea`                                   | [Inline Validation](https://www.interior.dev/docs/inline-validation)                                                                                           | `components/ui/textarea.tsx`                                                   | Nativo, `rows`, `id`, `name`                                                                                                            | Renglón de mensaje reservado y un único shake al aparecer el error (`invalid`/`error`/`hint`)                                                                                                                   |
| `Alert`                                      | [Collapsible Banner](https://www.interior.dev/docs/collapsible-banner)                                                                                         | `components/ui/alert.tsx`                                                      | `variant`, `role`, `data-testid`, `AlertTitle`, `AlertDescription`                                                                      | Altura interrumpible, plegado con `title` + `collapsible`, descarte con `dismissible` y anuncio cortés                                                                                                          |
| `Badge`                                      | [Value Flash](https://www.interior.dev/docs/value-flash)                                                                                                       | `components/ui/badge.tsx`                                                      | `variant`, `className`, contenido                                                                                                       | La píldora marca el cambio de valor (tinte + pop + anuncio) sin mover el layout                                                                                                                                 |
| `Dialog` (Radix)                             | [Modal](https://www.interior.dev/docs/modal)                                                                                                                   | `components/ui/dialog.tsx`                                                     | API compuesta, `data-testid`, `onEscapeKeyDown`, `onPointerDownOutside`, `onInteractOutside`, botón «Cerrar»                            | Radix fuera: scroll lock, focus trap, `inert`, `role=dialog`/`aria-modal` y entrada desde el origen los aporta `useModal`                                                                                       |
| `OtpInput`                                   | [OTP Input](https://www.interior.dev/docs/otp-input)                                                                                                           | `components/ui/otp-input.tsx`                                                  | `value`/`onChange` controlado, `mode`, `id` en la primera caja, `aria-label="Digit N of 6"`, `inputMode`, `autoComplete`, `data-testid` | Auto-avance, pegado, navegación, caret que parpadea solo en la caja activa y shake de error; `status`/`errorMessage` opcionales                                                                                 |
| `Select`                                     | [Dropdown](https://www.interior.dev/docs/dropdown)                                                                                                             | `components/ui/select.tsx`                                                     | `options`, `value`, `onChange({target:{value}})`, `placeholder`, `id`, `.custom-select__trigger`                                        | Listbox con resaltado viajero, typeahead, Home/End y Escape                                                                                                                                                     |
| `dropdown-menu` (sin uso)                    | [Dropdown](https://www.interior.dev/docs/dropdown)                                                                                                             | `components/ui/dropdown-menu.tsx`                                              | —                                                                                                                                       | Se reexporta el primitivo por ítems; no se reimplementa la API compuesta de Radix                                                                                                                               |
| `Skeleton` (sin uso)                         | [Skeleton Swap](https://www.interior.dev/docs/skeleton-swap)                                                                                                   | `components/ui/skeleton.tsx`                                                   | `Skeleton` como bloque estático                                                                                                         | `SkeletonSwap` mantiene el mismo recuadro para el placeholder y el contenido                                                                                                                                    |
| `Tabs` (sin uso)                             | [Tabs](https://www.interior.dev/docs/tabs)                                                                                                                     | `components/ui/tabs.tsx`                                                       | —                                                                                                                                       | API por ítems con indicador compartido; se retiró la API compuesta de Radix                                                                                                                                     |
| `Table` (sin uso)                            | [Sortable Table](https://www.interior.dev/docs/sortable-table)                                                                                                 | `components/ui/table.tsx`                                                      | —                                                                                                                                       | Filas FLIP a su nuevo orden y `aria-sort`                                                                                                                                                                       |
| `inventory/pagination`                       | [Pagination](https://www.interior.dev/docs/pagination)                                                                                                         | `components/inventory/pagination.tsx`                                          | `.table-pagination*`, `pagination-range`, `pagination-page`, `pagination-prev`, `pagination-next`, selector de filas                    | Números de página en ranuras fijas con pulgar que viaja; «Anterior»/«Siguiente» con los testids de siempre                                                                                                      |
| `bulk-upload-processing-overlay`             | [Progress Bar](https://www.interior.dev/docs/progress-bar)                                                                                                     | `components/inventory/bulk-upload-processing-overlay.tsx`                      | `data-testid` de estado y porcentaje, etapas, textos                                                                                    | La barra es la de interior (`showHeader={false}`), con entrega indeterminada→determinada y `role=progressbar`                                                                                                   |
| `mobile-nav` (Dialog)                        | [Drawer](https://www.interior.dev/docs/drawer)                                                                                                                 | `components/layout/mobile-nav.tsx`                                             | `mobile-nav-trigger`, `mobile-nav-link-*`, gate por rol                                                                                 | Panel lateral con arrastre que coincide con la salida; sin CSS `data-state`                                                                                                                                     |
| Contadores                                   | [Value Flash](https://www.interior.dev/docs/value-flash)                                                                                                       | `components/inventory/animated-counter.tsx`                                    | Texto del número sin agrupar                                                                                                            | Los dígitos ruedan en la dirección del cambio y se anuncia una sola vez                                                                                                                                         |
| Código revelado                              | [Copy Button](https://www.interior.dev/docs/copy-button)                                                                                                       | `marbetes-page-client.tsx`                                                     | `reveal-confirmation-code`                                                                                                              | Copiar con tick, ancho bloqueado y reversión a los 2 s                                                                                                                                                          |
| Tarjeta de resumen (`inventory/metric-card`) | [Poll Results](https://www.interior.dev/docs/poll-results) para el dato proporcional + [Value Flash](https://www.interior.dev/docs/value-flash) para el número | `components/inventory/metric-card.tsx` + `components/inventory/metric-bar.tsx` | `label`, `value`, `meta`, `segments`, `ratio`, `ratioLabel`, `pills`, chip de filtro, `aria-pressed`, `data-filter`, `data-testid`      | La dona se retiró: la tarjeta es una retícula de cuatro áreas (etiqueta + chip / valor + porcentaje / meta / barra), sin posicionamiento absoluto, con barra proporcional de 6 px y separación uniforme de 8 px |

`Card` no tiene equivalente en interior.dev (es un contenedor estático, no una
micro-interacción): se conserva y sus cifras usan Value Flash. La tarjeta de
resumen tampoco tiene equivalente como contenedor: se toma de _Poll Results_ la
barra proporcional y de _Value Flash_ el número, y la dona que traía la maqueta
se retiró por altura y legibilidad (`odd/tasks/backoffice-ui-canon.md`, S10).

`Input` y `Label` ya no son primitivos shadcn con Radix:

- `components/ui/input.tsx` se elimina: todo campo de texto pasa por `Field`. No
  quedaba ningún consumidor.
- `components/ui/label.tsx` es un `<label>` nativo con las mismas clases. Se usa
  para controles agrupados (grupo OTP, búsqueda de matrícula, widgets compuestos)
  donde no hay nada que flotar.

Consecuencia pendiente (follow-up, fuera de este feature): `@radix-ui/react-dialog`,
`@radix-ui/react-dropdown-menu`, `@radix-ui/react-label` y `@radix-ui/react-tabs`
quedan instalados sin uso. Retirarlos toca `package-lock.json` y merece su propia
rebanada de revisión.

## Cómo actualizar una fuente vendorizada

1. Descargar el registro: `curl -sL https://www.interior.dev/r/<name>.json` y
   extraer `files[0].content` (el JSON trae el `.tsx` completo).
2. Reemplazar el archivo en `apps/web/components/interior/<name>.tsx` conservando
   el encabezado de procedencia y **reaplicando** la adaptación de tokens: sin
   `dark:`, `neutral-*`/`stone-*` → tokens InecConecta, radios 8/12 px, anillos de
   foco `--color-primary-500`.
3. Revisar el `Omit` del adaptador (`components/ui/*`) si upstream agrega props, y
   correr `npx tsc --noEmit -p tsconfig.json` más la suite RTL de `apps/web`.

## Verificación

```bash
cd apps/web
npx tsc --noEmit -p tsconfig.json
npx jest --config jest.config.cjs
npm run build
```

### Smoke de navegador (sin credenciales)

```bash
cd apps/web
npm run test:cosmetic
```

Construye el standalone con `NEXT_PUBLIC_API_URL=http://127.0.0.1:3211`, levanta
un API determinista (`e2e/cosmetic/stub-api.mjs`) y corre Chromium sobre
`http://127.0.0.1:3210/backoffice`. Cubre login con OTP, banner de error,
dashboard, diálogo de creación, paginación y drawer móvil, y falla si aparece
cualquier error de CORS en consola. No toca hosts reales, base de datos ni el
emisor de OTP.

### Base del API: mismo origen por defecto

Un bundle construido **sin** `NEXT_PUBLIC_API_URL` incrustaba
`http://127.0.0.1:3100`, así que el navegador del visitante llamaba a su propia
máquina y la petición se bloqueaba como cross-origin (síntoma reportado en
`https://backoffice.inecuni.com/backoffice/login`). Ahora:

- **Navegador**: si `NEXT_PUBLIC_API_URL` está definido se usa tal cual
  (comportamiento histórico para APIs cross-origin). Si no, la base es `''` y
  todas las llamadas son relativas (`/api/v1/...`), es decir, contra el mismo
  origen que sirvió la página. Producción ya enruta `/api/` al API con nginx.
- **Servidor (Node)**: una URL relativa no es fetchable, así que usa
  `API_INTERNAL_URL` (variable solo de servidor, leída en runtime) y, si falta,
  el puerto por defecto del API para herramientas locales.
- **Desarrollo / standalone**: `next.config.ts` declara un rewrite
  `/api/:path* → API_INTERNAL_URL`, así que `next dev` y el servidor standalone
  funcionan sin configurar CORS.

`apps/api/src/app.ts` sigue registrando CORS con `origin: ALLOWED_ORIGIN ?? false`:
con el nuevo default ya no hace falta para el flujo normal (no hay petición
cross-origin), pero sigue siendo necesario si se opta por una API absoluta en
otro origen.

### Paridad visual

La paridad pixel contra la maqueta (`e2e/lookfeel/12-maquette-parity.spec.ts`)
necesita `E2E_ADMIN_USERNAME` y un OTP fresco del servicio: al cambiar la
apariencia de botones, campos y diálogos, su línea base debe regenerarse antes de
volver a exigir el umbral de 96.

## Botones planos (sin extrusión)

Ningún control renderizado puede aparentar relieve: lo prohíbe el dueño del
producto en S1 de `odd/tasks/backoffice-ui-canon.md` («lo que sí está
prohíbido es dejar esos botones, que aparentan ser en 3D»). interior.dev
publica los dos patrones —_Press Depth_, con losa `depth=4` e inclinación
`tilt=7`, y _Loading Button_, con cara plana— y se adoptó el plano: el botón
de `components/ui/button.tsx` perdió la losa, el `paddingBottom` que la
sostenía y la inclinación `rotateX`/`rotateY` con `perspective`.

El par `0 0 0 1px` (anillo) + `0 1px 2px` (sombra ambiente) es canon de
interior.dev y **no se quita**: aplanar la extrusión no autoriza a borrar el
anillo. La pulsación se conserva como travel de 1 px más `brightness(.98)`, con
paridad de `prefers-reduced-motion`. Los wrappers `PressDepth` y `LoadingButton`
se eliminaron por quedarse sin consumidores; el hook que el botón sí usa,
`usePressDepth`, permanece en `components/interior/press-depth.tsx` (ese archivo
pasó a contener únicamente el hook).

## Armonización del chrome heredado

Los primitivos de interior.dev son el canon visual. La capa final de
`app/globals.css` (`@layer components`, sección «Cosmetic harmony») lleva las
clases de la maqueta a la misma geometría para que una pantalla no muestre dos
lenguajes a la vez:

| Regla                 | Valor canónico                                                     |
| --------------------- | ------------------------------------------------------------------ |
| Altura de control     | 40 px (compacto 32-36)                                             |
| Radio                 | 8 px controles, 12 px paneles                                      |
| Tipografía de control | 13 px / 500; hints 11.5 px / 400                                   |
| Borde                 | 1 px `--color-border` + anillo `0 0 0 1px rgb(0 0 0 / 12%)`        |
| Foco                  | anillo de 2 px `--color-primary-500` (dorado), nunca el verde 4 px |
| Press                 | `translateY(1px)` + `brightness(.98)`                              |

Clases alineadas: `.btn` / `.btn--primary` / `.btn--secondary`, `.row-action`,
`.admin-action--*`, `.form-field__*`, `.custom-select__trigger`,
`.inventory-search__*`, `.data-table` (tipografía y padding), `.sort-button`
(min-width 6.25rem), `.table-pagination` (footer en flujo, tarjeta propia),
`.metric-card__*` (chip sin solapar la etiqueta, porcentaje sin recortarse),
`.modal-dialog__*`, `.status-chip`, `.app-alert`, `.assignment-checkbox`.

Además se corrigieron defectos de layout que la inconsistencia hacía visibles:
la barra de filtros de auditoría no tenía `flex-wrap` y sus campos se
superponían; `.inventory-section--table` no existía en CSS, así que la tabla
crecía con la página y el paginador quedaba fuera de vista; la tabla de
dispositivos excedía el contenedor ~120 px y recortaba la columna Acciones.
