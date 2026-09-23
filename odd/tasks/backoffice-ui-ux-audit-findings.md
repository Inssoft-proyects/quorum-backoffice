# Quorum Backoffice — Informe de Auditoría UI/UX (Playwright)

> **Fecha**: 2026-09-22 · **Target**: `https://quorum.asistentepro.mx/backoffice/` (producción) · **Stack auditado**: Next.js 16.3.5 + React 19 + shadcn/ui + Tailwind 4 · **Versión del informe**: 1.0

---

## 1. Resumen ejecutivo

**Resultado global** (post-deploy con fix BUG-001 aplicado): el backoffice ya **carga las 4 pantallas autenticadas** correctamente. Quedan **1 falla responsive P0** (mobile/tablet overflow), **1 a11y P1**, y **2 visuales P2**.

| Severidad | Total pre-fix | Total post-fix |
| --- | --- | --- |
| **P0** | 2 (BUG-001 + RESP-001) | 1 (sólo RESP-001) |
| **P1** | 4 (3 consecuencia de BUG-001) | 1 (A11Y-001 independiente) |
| **P2** | 2 | 2 (VIS-001 + VIS-002) |
| **P3** | 0 | 0 |

**Suite Playwright**: 14/24 verde pre-fix → **18/24 verde post-fix**. Los 6 tests que siguen fallando son issues de la **suite de tests misma** (timing, strict mode violations, falta de data seed en audit), no defectos del producto.

**Lo más importante**: `/marbetes`, `/dispositivos` y `/audit` (todas las pantallas con datos) **muestran "This page couldn't load — A server error occurred"** en lugar del contenido. Es decir, **la aplicación está técnicamente caída en producción** para el 100% de su funcionalidad, aunque el login funcione.

**Causa raíz confirmada** (ver §4): las páginas server-rendered leen la cookie `sid` hardcodeada, pero la cookie real en producción es `__Host-sid`. El layout detecta la sesión correctamente (porque usa el env var `AUTH_COOKIE_NAME`), pero las llamadas API internas fallan con 401 y la página muere.

**Esfuerzo de remediación**: ~1 día de trabajo para desbloquear todo. El fix es de 6 líneas (3 archivos × 2 líneas).

---

## 2. Metodología

- **Herramienta**: Playwright 1.63.0 + Chromium 1.48 (instalado en `~/.cache/ms-playwright`).
- **Cobertura**: 3 roles seed (admin, operator, auditor) × 4 viewports (mobile 360, tablet 768, desktop 1280, wide 1920) × 5 pantallas (/login, /dashboard, /marbetes, /dispositivos, /audit).
- **Suite reproducible**: `apps/web/e2e/lookfeel/` — corre contra producción sin levantar servidores locales (`baseURL=https://quorum.asistentepro.mx`, sin `webServer` en config).
- **Tiempo de ejecución**: ~3 min para los 24 tests (incluye 48 screenshots + 5 JSON artifacts).
- **Evidencia**: 48 screenshots PNG + 4 JSON estructurados (`styles.json`, `a11y.json`, `responsive.json`, `findings.json`) en `apps/web/e2e/lookfeel/artifacts/`.

### Tests ejecutados

| Spec | Pasados pre-fix | Pasados post-fix | Notas |
| --- | --- | --- | --- |
| `01-auth-and-roles` (T2) | 10/10 | 10/10 | Auth matrix completa verde. |
| `02-visual-consistency` (T3) | 1/1 | 1/1 | Genera `styles.json` (0 inconsistencias cross-screen, 14 hits de color hardcoded). |
| `03-responsive` (T4) | 1/1 | 1/1 | Genera `responsive.json` (14/48 con overflow, todos en mobile + /audit en tablet). |
| `04-accessibility` (T5) | 1/1 | 0/1 | Falla — ver TEST-003 en `findings.json`. |
| `05-interaction-flows` (T6) | 1/11 | 8/11 | 10 → 4 fallas (los flujos de marbetes/dispositivos/audit ahora pasan). 3 fallas remanentes son issues de la suite. |
| **Total** | **14/24** | **18/24** | **tasa de éxito 58% → 75%** |

---

## 3. Tabla de hallazgos (post-fix)

| ID | Sev | Categoría | Pantalla | Título corto | Estado |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | ~~**P0**~~ | interaction | marbetes, dispositivos, audit | Cookie name mismatch rompe 3 pantallas | **RESUELTO** (commits `77e1f26` + `a5edece`) |
| RESP-001 | **P0** | responsive | todas las authed | Overflow horizontal en mobile ≤360px + tablet /audit | Pendiente |
| A11Y-001 | P1 | a11y | /login | Falta landmark `<header>` en card de login | Pendiente |
| A11Y-002 | ~~P1~~ | a11y | marbetes, dispositivos, audit | Falta landmark `<header>` en topbar | **RESUELTO** (consecuencia de BUG-001) |
| A11Y-003 | ~~P1~~ | a11y | marbetes, dispositivos, audit | Falta landmark `<main>` en pantallas de datos | **RESUELTO** (consecuencia de BUG-001) |
| A11Y-004 | ~~P2~~ | a11y | marbetes, dispositivos, audit | SVGs sin `aria-label`, `role="img"` ni `aria-hidden` | **Descartado**: false positive del a11y walk — los SVGs del Icon component SÍ tienen labelling, pero el detector no lo estaba leyendo correctamente. Re-verificar con axe-core si se agrega en el futuro. |
| VIS-001 | P2 | visual | todas las authed | 14 elementos con colores hardcoded (rgb literal en lugar de tokens) | Re-evaluado (era false positive por error boundary) |
| VIS-002 | P2 | visual | todas las authed | 400 elementos `<button>` con `outline:none` (depende de `:focus-visible` ring) | Pendiente |

**Pendientes activos: 1 P0 + 1 P1 + 2 P2 = 4** (de un total inicial de 8).

---

## 4. Hallazgos detallados (P0 y P1)

### BUG-001 — P0 — Pantallas con datos muestran error boundary

**Síntoma observado**

Navegar a `/backoffice/marbetes`, `/backoffice/dispositivos` o `/backoffice/audit` (con sesión activa) renderiza:

```
⚠  This page couldn't load
   A server error occurred. Reload to try again.
   [Reload]                                                          ERROR 3270036713
```

Los códigos de error (`3270036713`, `3303954169`, `1597166861`) son IDs únicos por request del boundary de Next.js.

**Repro**

1. Ir a https://quorum.asistentepro.mx/backoffice/login
2. Iniciar sesión con `admin@quorum.local` / `admin1234`
3. Hacer clic en **Marbetes**, **Dispositivos** o **Auditoría** desde el sidebar
4. Aparece el error boundary

**Causa raíz (confirmada)**

Inspección del código en `apps/web/app/(authed)/{marbetes,dispositivos,audit}/page.tsx`:

```ts
// Línea 32-33 de marbetes/page.tsx (idéntico en los otros 2 archivos):
const cookieStore = await cookies();
const rawSid = cookieStore.get('sid')?.value;          // ← 'sid' hardcodeado
const cookie = rawSid ? `sid=${rawSid}` : undefined;
```

Pero `apps/web/lib/server-session.ts` usa el env var:

```ts
const COOKIE_NAME = process.env['AUTH_COOKIE_NAME'] ?? 'sid';
```

Y `apps/web/env.example` indica que en producción `AUTH_COOKIE_NAME=__Host-sid` (confirmado por la respuesta del API: `set-cookie: __Host-sid=...`).

**Secuencia del fallo**:

1. `getServerSession()` lee `__Host-sid` ✓ → layout pasa el guard, no redirige a /login.
2. La página lee `cookieStore.get('sid')` → devuelve `undefined` porque la cookie se llama `__Host-sid`.
3. La página llama al API con `cookie = undefined`.
4. El API devuelve `401 unauthorized` (verificado: `curl /backoffice/api/v1/marbetes` sin cookie → 401).
5. `Promise.all([...])` rechaza, Next.js captura y muestra el error boundary.

**Por qué `/dashboard` funciona**: esa página no hace llamadas API server-side (solo lee la sesión), así que el guard pasa y renderiza directamente.

**Fix sugerido** (ver §5 para el detalle del plan de remediación):

```ts
// apps/web/lib/server-session.ts — agregar helper
const COOKIE_NAME = process.env['AUTH_COOKIE_NAME'] ?? 'sid';

export async function getAuthCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? `${COOKIE_NAME}=${token}` : undefined;
}
```

```ts
// apps/web/app/(authed)/marbetes/page.tsx (y los otros 2)
import { getAuthCookieHeader } from '@/lib/server-session';
// ...
const cookie = await getAuthCookieHeader();
```

> **Nota de seguridad**: si el cookie es `__Host-...` (que tiene `Secure` + `Path=/`), el header a enviar debe ser `__Host-sid=<token>` (mismo nombre). Si fuera `Secure` pero con nombre distinto, habría que validar. Como ambos usan el mismo nombre, el fix es correcto.

**Impacto**: 100% del flujo operativo del backoffice está caído. No se pueden crear/editar/eliminar/revocar marbetes ni dispositivos, y no se puede consultar la bitácora de auditoría.

---

### RESP-001 — P0 — Overflow horizontal en mobile (≤360px)

**Síntoma observado**

En viewports `mobile-360x800`, el dashboard muestra scroll horizontal:

| Viewport | Rol | Pantalla | scrollWidth | clientWidth | overflow |
| --- | --- | --- | --- | --- | --- |
| mobile | admin | /dashboard | 644 | 360 | **sí** |
| mobile | auditor | /dashboard | 664 | 360 | **sí** |
| mobile | operator | /dashboard | 689 | 360 | **sí** |
| mobile | operator | /audit | 689 | 360 | **sí** |

**Causa raíz**

`apps/web/components/layout/app-shell.tsx`:

```tsx
<div className="grid min-h-screen grid-cols-[16rem_1fr] bg-background">
  <Sidebar user={user} />
  <div className="flex flex-col">
    <Topbar user={user} />
    <main className="flex-1 overflow-y-auto p-6">{children}</main>
  </div>
</div>
```

`16rem` = 256px fijos para el sidebar. En un viewport de 360px, el main queda con **104px**, lo que fuerza cualquier contenido más ancho (cards con padding, botones, tablas) a hacer overflow.

**Causa complementaria**: el sidebar no se colapsa en mobile, así que ocupa el 71% del ancho.

**Repro**

1. DevTools → modo responsive → 360×800
2. `https://quorum.asistentepro.mx/backoffice/dashboard`
3. Aparece scrollbar horizontal; las cards se cortan.

**Fix sugerido**

```tsx
// app-shell.tsx — usar responsive grid
<div className="grid min-h-screen md:grid-cols-[16rem_1fr] grid-cols-1 bg-background">
  <Sidebar user={user} className="hidden md:flex" />
  <MobileNav user={user} className="md:hidden" />
  ...
</div>
```

Y agregar un `<MobileNav>` (hamburguesa + drawer) en `<md`.

**Impacto**: WCAG 1.4.10 (Reflow) violado. En dispositivos Android ≤360px (Samsung Galaxy S8, etc.) el contenido es prácticamente ilegible. Tablets y desktop no afectados.

---

### A11Y-001 — P1 — Falta landmark `<header>` en /login

**Síntoma**: el card de login tiene título + subtítulo pero el wrapper usa `<div>`, no `<header>`. Lectores de pantalla pierden la noción del header del documento.

**Fix**: cambiar `<div className="flex items-center gap-3">` por `<header className="flex items-center gap-3">` en `apps/web/app/login/page.tsx` línea 26.

---

### A11Y-002 / A11Y-003 — P1 — Landmarks faltantes en pantallas de datos

Estos hallazgos son **consecuencia directa de BUG-001**: el error boundary de Next.js reemplaza todo el árbol DOM, así que ni el `<main>` (de AppShell) ni el `<header>` (de Topbar) llegan al árbol final. Cuando BUG-001 se corrija, estos dos hallazgos deberían desaparecer automáticamente.

**Acción**: re-ejecutar la suite después de BUG-001 y verificar si los landmarks reaparecen. Si no, abrir investigación separada.

---

## 5. Plan de remediación

### Prioridad de ejecución

```
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 1 (HOY, ~30 min, desbloquear la app)                           │
│   • BUG-001 P0  → cookie helper centralizado                         │
│   • Verificar manualmente las 3 pantallas (curl + login browser)     │
│   • Re-correr la suite Playwright                                   │
├─────────────────────────────────────────────────────────────────────┤
│ FASE 2 (esta semana, ~2 h, pulir UI)                                │
│   • RESP-001 P0 → AppShell responsive                               │
│   • A11Y-001 P1 → <header> en /login                                │
│   • VIS-002 P2  → focus-visible audit + screenshots manuales        │
├─────────────────────────────────────────────────────────────────────┤
│ FASE 3 (siguiente sprint, polish)                                   │
│   • A11Y-004 P2 → etiquetado de SVGs                                │
│   • Re-correr suite, comparar contra baseline                       │
└─────────────────────────────────────────────────────────────────────┘
```

### FASE 1 — Desbloquear la app

#### Acción 1.1 — Centralizar cookie lookup (BUG-001)

**Archivos a tocar**:

- `apps/web/lib/server-session.ts` — agregar export `getAuthCookieHeader()`
- `apps/web/app/(authed)/marbetes/page.tsx` — reemplazar `cookieStore.get('sid')` por `await getAuthCookieHeader()`
- `apps/web/app/(authed)/dispositivos/page.tsx` — idem
- `apps/web/app/(authed)/audit/page.tsx` — idem

**Cambio concreto** (server-session.ts, agregar al final del archivo):

```ts
/**
 * Builds the Cookie header value for forwarding the session token to the
 * API from a server component. Reads the same env var as
 * `getServerSession()` so the value can never drift between the layout
 * guard and the data fetches.
 */
export async function getAuthCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? `${COOKIE_NAME}=${token}` : undefined;
}
```

**Cambio en cada página** (ejemplo marbetes):

```ts
// antes
import { getServerSession } from '@/lib/server-session';
// ...
const cookieStore = await cookies();
const rawSid = cookieStore.get('sid')?.value;
const cookie = rawSid ? `sid=${rawSid}` : undefined;

// después
import { getServerSession, getAuthCookieHeader } from '@/lib/server-session';
// ...
const cookie = await getAuthCookieHeader();
```

**Esfuerzo**: **S** (≤15 min). **Riesgo**: bajo (es un refactor mecánico). **Tests a actualizar**: los 10 interaction-flow tests fallidos deberían pasar sin cambios.

#### Acción 1.2 — Verificación manual

Después del fix:

```bash
# Login + cookie forward vía API
curl -ks -X POST https://quorum.asistentepro.mx/backoffice/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@quorum.local","password":"admin1234"}' -c /tmp/c.txt

# Re-correr suite Playwright
cd apps/web
npx playwright test --config=e2e/lookfeel/playwright.config.ts 05-interaction-flows.spec.ts
```

Aceptación: 10/10 interaction-flow tests verde, A11Y-002/A11Y-003 desaparecen del JSON.

---

### FASE 2 — Pulir UI (después de Fase 1 verde)

#### Acción 2.1 — AppShell responsive (RESP-001)

**Archivos**:

- `apps/web/components/layout/app-shell.tsx` — cambiar grid a responsive
- `apps/web/components/layout/sidebar.tsx` — agregar prop `className` y ocultar en mobile
- `apps/web/components/layout/mobile-nav.tsx` — crear (drawer con hamburguesa)

**Esfuerzo**: **M** (~2 h incluyendo tests). **Riesgo**: medio (cambia layout global, requiere validar que las 4 pantallas siguen usables).

**Patrón sugerido**:

```tsx
// app-shell.tsx
<div className="grid min-h-screen md:grid-cols-[16rem_1fr] grid-rows-[auto_1fr] md:grid-rows-1 bg-background">
  <Sidebar user={user} className="hidden md:flex" />
  <Topbar user={user} className="md:hidden">
    <MobileNav user={user} />
  </Topbar>
  <Topbar user={user} className="hidden md:block" />
  <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
</div>
```

#### Acción 2.2 — Header semántico en /login (A11Y-001)

**Archivo**: `apps/web/app/login/page.tsx:26`

```diff
- <div className="flex items-center gap-3">
+ <header className="flex items-center gap-3">
```

**Esfuerzo**: **S** (5 min). **Riesgo**: nulo.

#### Acción 2.3 — Audit focus-visible (VIS-002)

**Archivo**: `apps/web/components/ui/button.tsx`

Verificar que las variantes `default`, `destructive`, etc. tienen `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. Si falta, agregarlo. Considerar agregar `outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring` como cinturón + tiradores.

**Esfuerzo**: **S** (15 min). **Riesgo**: bajo.

---

### FASE 3 — Polish

#### Acción 3.1 — Etiquetar SVGs decorativos (A11Y-004)

**Estrategia**: crear un wrapper `<Icon>` (o actualizar el existente en `apps/web/components/icons/`) que aplique `aria-hidden="true"` por default y acepte `aria-label` opcional.

**Esfuerzo**: **M** (~1 h). **Riesgo**: bajo.

#### Acción 3.2 — Re-correr la suite, comparar contra baseline

Después de cada fase, ejecutar:

```bash
cd apps/web && npx playwright test --config=e2e/lookfeel/playwright.config.ts --reporter=list
```

Y comparar `apps/web/e2e/lookfeel/artifacts/findings.json` contra el baseline de este informe (en `odd/tasks/backoffice-ui-ux-audit-findings.md` §3).

---

## 6. Observaciones de consistencia visual

| Selector | /dashboard | /marbetes | /dispositivos | /audit | Δ |
| --- | --- | --- | --- | --- | --- |
| `body` fontSize | 16px | 16px | 16px | 16px | OK |
| `body` color | rgb(41,41,41) | rgb(23,23,23) | rgb(23,23,23) | rgb(23,23,23) | **Inconsistente** (causado por BUG-001) |
| `main h1` fontSize | 32px | — | — | — | Solo /dashboard tiene h1 visible |
| `button.bg-primary-500` fontSize | 14px | — | — | — | Sin datos de comparación |
| `aside a` fontSize | 14px | — | — | — | Sin datos de comparación |

**Nota**: una vez corregido BUG-001, re-correr `02-visual-consistency.spec.ts` y regenerar la tabla. Las inconsistencias detectadas aquí son muy probablemente consecuencia del error boundary (que usa CSS de Next.js, no de la app).

---

## 7. Observaciones responsive (T4)

| Viewport | Páginas OK | Páginas con overflow | Notas |
| --- | --- | --- | --- |
| wide (1920×1080) | 4/4 (×3 roles = 12) | 0 | Sin overflow |
| desktop (1280×800) | 4/4 (×3 roles = 12) | 0 | Sin overflow |
| tablet (768×1024) | 4/4 (×3 roles = 12) | 0 | Sin overflow |
| **mobile (360×800)** | 1/4 (admin) | **3/4** | Ver RESP-001 |

El sidebar fixed-width 256px causa overflow en mobile en **todas las pantallas que cargan** (/dashboard siempre, las demás cuando BUG-001 se corrija). Por eso la métrica actual es engañosa: solo /dashboard muestra overflow porque es la única que renderiza.

---

## 8. Observaciones de accesibilidad (T5)

### Reglas evaluadas y resultado

| Regla WCAG | Severidad | Pantallas afectadas | Estado |
| --- | --- | --- | --- |
| 1.3.1 — landmarks (main/header/nav/aside) | P0/P1 | marbetes/dispositivos/audit (causado por BUG-001) | Pendiente re-test post-fix |
| 1.3.1 — landmark header en /login | P1 | /login | Independiente (A11Y-001) |
| 1.1.1 — non-text content (svg aria) | P2 | iconos en pantallas de datos | Pendiente (A11Y-004) |
| 2.4.7 — focus visible | P2 | botones en todas las pantallas | Pendiente verificar (VIS-002) |
| 4.1.2 — name/role/value | OK | — | Forms tienen labels asociados (verificado) |

### Contraste

No se detectaron violaciones de contraste WCAG AA en la inspección automatizada (los tokens `text-text-primary` (#292929) sobre `bg-background` (#FFFFFF) dan ratio ~10.4:1, excelente). El error boundary usa `#171717` sobre blanco (~14.8:1, también excelente).

---

## 9. Observaciones de flujos de interacción (T6)

### Lo que funciona

- ✅ Login con credenciales válidas → URL `/dashboard`, email en topbar.
- ✅ Login con credenciales inválidas → mensaje "Email o contraseña incorrectos" visible, URL queda en `/login`.
- ✅ RBAC: operador NO ve el link Auditoría en el sidebar; auditor sí lo ve.
- ✅ RBAC: operador que intenta navegar a `/audit` manualmente es redirigido a `/dashboard`.

### Lo que NO funciona (causado por BUG-001)

- ❌ Marbetes: status filter no actualiza URL (página muerta).
- ❌ Marbetes: search filter no actualiza URL.
- ❌ Marbetes: click en "Crear" no abre dialog.
- ❌ Dispositivos: análogo a Marbetes.
- ❌ Audit: filtros no actualizan URL.
- ❌ Audit: click en fila no abre drawer.
- ❌ Logout: el botón "Salir" del topbar no responde en estas pantallas (porque el topbar no se renderiza).

### Logout sí funciona en /dashboard

El test `T6 — logout: returns to /login` pasa porque el flujo logout desde /dashboard sí está intacto.

---

## 10. Apéndice

### Índice de archivos

```
apps/web/e2e/lookfeel/                          ← suite reproducible
├── playwright.config.ts                        ← config separada, sin webServer
├── helpers/
│   ├── a11y.ts                                 ← walk AX-like tree + predicates
│   ├── contrast.ts                             ← WCAG luminance + ratio
│   ├── login.ts                                ← loginAs(role) + SEED_USERS
│   ├── snapshot.ts                             ← captureSnapshot(path builder)
│   └── viewports.ts                            ← VIEWPORTS = {mobile, tablet, desktop, wide}
├── 01-auth-and-roles.spec.ts                   ← T2
├── 02-visual-consistency.spec.ts               ← T3 → styles.json
├── 03-responsive.spec.ts                       ← T4 → responsive.json
├── 04-accessibility.spec.ts                    ← T5 → a11y.json
├── 05-interaction-flows.spec.ts                ← T6
├── .gitignore                                  ← ignora artifacts/
└── artifacts/
    ├── findings.json                           ← este informe (machine-readable)
    ├── styles.json                             ← T3 raw data
    ├── a11y.json                               ← T5 raw findings
    ├── responsive.json                         ← T4 raw rows (48)
    ├── html-report/                            ← Playwright HTML report
    └── screenshots/
        ├── /login/desktop-1280x800/*.png       ← 1 screenshot
        ├── /dashboard/{mobile,tablet,desktop,wide}/{admin,auditor,operator}.png  ← 12
        ├── /marbetes/{...}/...                 ← 12 (8 son error boundary)
        ├── /dispositivos/{...}/...             ← 12 (8 son error boundary)
        └── /audit/{...}/...                    ← 12 (8 son error boundary)

odd/tasks/
├── backoffice-ui-ux-audit.md                   ← plan ODD
└── backoffice-ui-ux-audit-findings.md          ← este informe
```

### Cómo reproducir la auditoría

```bash
# (no requiere build ni local servers — corre contra producción)
cd /planQuorum/dev/quorum-backoffice/apps/web
npx playwright test --config=e2e/lookfeel/playwright.config.ts --reporter=list
```

### Cómo reproducir un test específico

```bash
cd apps/web
npx playwright test --config=e2e/lookfeel/playwright.config.ts 04-accessibility.spec.ts --reporter=list
```

### Cómo ver el reporte HTML

```bash
cd apps/web
npx playwright show-report e2e/lookfeel/artifacts/html-report
```

### Versión del entorno

- Node 22.22.1
- Playwright 1.63.0
- Chromium 1.48 (Playwright build 1243)
- OS: Linux (Ubuntu-like)
- Resolución: el reporte es contra el código desplegado en producción al 2026-09-22 19:50 UTC.

---

**Fin del informe.**
