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

| Primitivo anterior               | Equivalente interior.dev                                                                                                  | Archivo adaptador                                         | Qué se conservó                                                                                                                         | Qué cambió                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Button` (shadcn + CVA)          | [Press Depth](https://www.interior.dev/docs/press-depth) + [Loading Button](https://www.interior.dev/docs/loading-button) | `components/ui/button.tsx`                                | `variant`, `size`, `asChild`, `disabled`, `onClick`                                                                                     | Profundidad de 2 px con resorte y origen del puntero; `loading` + `loadingLabel` con ancho reservado                            |
| `Label` + `Input`                | [Floating Label](https://www.interior.dev/docs/floating-label)                                                            | `components/ui/field.tsx`                                 | `id`, `name`, `type`, `value`, `onChange`, `required`, `disabled`, `placeholder`, `aria-label`                                          | La etiqueta sube a un renglón reservado; el placeholder solo aparece al enfocar; contador de `maxLength` con ancho fijo         |
| `Textarea`                       | [Inline Validation](https://www.interior.dev/docs/inline-validation)                                                      | `components/ui/textarea.tsx`                              | Nativo, `rows`, `id`, `name`                                                                                                            | Renglón de mensaje reservado y un único shake al aparecer el error (`invalid`/`error`/`hint`)                                   |
| `Alert`                          | [Collapsible Banner](https://www.interior.dev/docs/collapsible-banner)                                                    | `components/ui/alert.tsx`                                 | `variant`, `role`, `data-testid`, `AlertTitle`, `AlertDescription`                                                                      | Altura interrumpible, plegado con `title` + `collapsible`, descarte con `dismissible` y anuncio cortés                          |
| `Badge`                          | [Value Flash](https://www.interior.dev/docs/value-flash)                                                                  | `components/ui/badge.tsx`                                 | `variant`, `className`, contenido                                                                                                       | La píldora marca el cambio de valor (tinte + pop + anuncio) sin mover el layout                                                 |
| `Dialog` (Radix)                 | [Modal](https://www.interior.dev/docs/modal)                                                                              | `components/ui/dialog.tsx`                                | API compuesta, `data-testid`, `onEscapeKeyDown`, `onPointerDownOutside`, `onInteractOutside`, botón «Cerrar»                            | Radix fuera: scroll lock, focus trap, `inert`, `role=dialog`/`aria-modal` y entrada desde el origen los aporta `useModal`       |
| `OtpInput`                       | [OTP Input](https://www.interior.dev/docs/otp-input)                                                                      | `components/ui/otp-input.tsx`                             | `value`/`onChange` controlado, `mode`, `id` en la primera caja, `aria-label="Digit N of 6"`, `inputMode`, `autoComplete`, `data-testid` | Auto-avance, pegado, navegación, caret que parpadea solo en la caja activa y shake de error; `status`/`errorMessage` opcionales |
| `Select`                         | [Dropdown](https://www.interior.dev/docs/dropdown)                                                                        | `components/ui/select.tsx`                                | `options`, `value`, `onChange({target:{value}})`, `placeholder`, `id`, `.custom-select__trigger`                                        | Listbox con resaltado viajero, typeahead, Home/End y Escape                                                                     |
| `dropdown-menu` (sin uso)        | [Dropdown](https://www.interior.dev/docs/dropdown)                                                                        | `components/ui/dropdown-menu.tsx`                         | —                                                                                                                                       | Se reexporta el primitivo por ítems; no se reimplementa la API compuesta de Radix                                               |
| `Skeleton` (sin uso)             | [Skeleton Swap](https://www.interior.dev/docs/skeleton-swap)                                                              | `components/ui/skeleton.tsx`                              | `Skeleton` como bloque estático                                                                                                         | `SkeletonSwap` mantiene el mismo recuadro para el placeholder y el contenido                                                    |
| `Tabs` (sin uso)                 | [Tabs](https://www.interior.dev/docs/tabs)                                                                                | `components/ui/tabs.tsx`                                  | —                                                                                                                                       | API por ítems con indicador compartido; se retiró la API compuesta de Radix                                                     |
| `Table` (sin uso)                | [Sortable Table](https://www.interior.dev/docs/sortable-table)                                                            | `components/ui/table.tsx`                                 | —                                                                                                                                       | Filas FLIP a su nuevo orden y `aria-sort`                                                                                       |
| `inventory/pagination`           | [Pagination](https://www.interior.dev/docs/pagination)                                                                    | `components/inventory/pagination.tsx`                     | `.table-pagination*`, `pagination-range`, `pagination-page`, `pagination-prev`, `pagination-next`, selector de filas                    | Números de página en ranuras fijas con pulgar que viaja; «Anterior»/«Siguiente» con los testids de siempre                      |
| `bulk-upload-processing-overlay` | [Progress Bar](https://www.interior.dev/docs/progress-bar)                                                                | `components/inventory/bulk-upload-processing-overlay.tsx` | `data-testid` de estado y porcentaje, etapas, textos                                                                                    | La barra es la de interior (`showHeader={false}`), con entrega indeterminada→determinada y `role=progressbar`                   |
| `mobile-nav` (Dialog)            | [Drawer](https://www.interior.dev/docs/drawer)                                                                            | `components/layout/mobile-nav.tsx`                        | `mobile-nav-trigger`, `mobile-nav-link-*`, gate por rol                                                                                 | Panel lateral con arrastre que coincide con la salida; sin CSS `data-state`                                                     |
| Contadores                       | [Value Flash](https://www.interior.dev/docs/value-flash)                                                                  | `components/inventory/animated-counter.tsx`               | Texto del número sin agrupar                                                                                                            | Los dígitos ruedan en la dirección del cambio y se anuncia una sola vez                                                         |
| Código revelado                  | [Copy Button](https://www.interior.dev/docs/copy-button)                                                                  | `marbetes-page-client.tsx`                                | `reveal-confirmation-code`                                                                                                              | Copiar con tick, ancho bloqueado y reversión a los 2 s                                                                          |

`Card` no tiene equivalente en interior.dev (es un contenedor estático, no una
micro-interacción): se conserva y sus cifras usan Value Flash.

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

La paridad pixel contra la maqueta (`e2e/lookfeel/12-maquette-parity.spec.ts`)
necesita `E2E_ADMIN_USERNAME` y un OTP fresco del servicio: al cambiar la
apariencia de botones, campos y diálogos, su línea base debe regenerarse antes de
volver a exigir el umbral de 96.
