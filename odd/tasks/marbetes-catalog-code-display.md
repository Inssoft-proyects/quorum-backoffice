# Marbetes: catálogo correcto, código ofuscado y flujo de revelado

## Goal

Que `/backoffice/marbetes` muestre exactamente los 10 marbetes reales
(`VALIDO-2609982468` … `VALIDO-2609982477`), con el número ofuscado
(`V***68`), sin columna ID, y que "Revelar marbete" desofusque el número
**en la tabla** con su debida verificación OTP y auditoría.

## Decisions (aprobadas por el operador)

1. Los 10 marbetes correctos/productivos son `VALIDO-2609982468…2477`
   (no `CRD-XXXX`, que era basura obsoleta de 2023–2024).
2. El número de marbete es **dato sensible**: se guarda completo y se
   muestra **ofuscado** (primer char + `***` + 2 últimos → `V***68`).
3. La columna **ID** (numérica, asignada por BD) **no se muestra**.
   "No. Marbete" es la llave del catálogo.
4. Catálogo de scopes OTP pequeño: `login`, `marbete`, `bitacoras`.

## Causa raíz (resumen)

- La tabla guardaba solo `code_hash` + `public_uid` generado `m-XXXX`, por
  lo que ofuscaba `m***1a` en vez del código real.
- El OTP se verificaba con `subject = email` (`admin@quorum.local`) pero
  quorum-otp emite ligado al **username canónico** (`admin`) → rechazo 409.
- `MaskedNumber` tenía la prop `revealed` para desofuscar en la tabla, pero
  nunca estaba cableada.

## Cambios

### Datos (producción `quorum_backoffice`)

- Backup `marbetes_backup_20261009` (20 filas).
- Eliminados los 10 `CRD-*`; `public_uid` = `VALIDO-2609982468…2477`.
- Catálogo final: 10 filas, ofuscadas `V***68…V***77`.

### Código (rama `fix/quorum-ecosystem-remediation-p2`)

- `marbetes-service.ts`: `create`/`bulkCreate` guardan el código como
  `public_uid` (no `m-XXXX`); scopes OTP unificados a `marbete`
  (`OTP_SCOPE`); `verifyOtp(actor, otpCode, grantEligible)`.
- `matriculas-service.ts`: `ASSIGN_GRANT_SCOPES` → `{ 'marbete' }`.
- `auth.ts` / `session-hydrator.ts` / `session.ts` / `auth-service.ts`:
  `MeResponse` expone `username` (nullable).
- `routes/{marbetes,dispositivos,matriculas}.ts`: `actorFromRequest` usa el
  username canónico (trim/lower) con fallback a email; reconciliado el fix
  B7a (`serviceName: app.config.OTP_SERVICE_NAME`).
- `marbetes-table.tsx` / `marbetes-page-client.tsx`: columna ID eliminada;
  `revealedCodes` cableado a `MaskedNumber.revealed` (desofusca en la tabla).
- `add-marbete-dialog.tsx`: acepta código alfanumérico.

### Despliegue

Build in-place en `/opt/quorum-backoffice` (que tiene MFA + página `/mfa`
que la rama no tiene), `kubectl rollout restart` de API y web. Backups:
`apps/api/dist.predeploy-*` y `apps/web/.next.predeploy-*`.

## Verificación

- Typecheck API + web limpios.
- 132 tests unitarios API + 200 web en verde.
- Playwright (producción): antes `V***77`, tras revelar
  `VALIDO-2609982477` **en la celda de la tabla** + banner.

## Pendientes / drift conocido (fuera de este alcance)

- `main`/`master` NO contiene MFA (`mfa-authenticate-service`, `pg-mfa-repo`,
  rutas `/mfa`, migraciones 0015–0020) ni el endpoint de asignación de
  dispositivos; viven en `feat/synthetic-test-data` /
  `feat/canvas-jitsi-device-binding`. Requiere reconciliación aparte.
- `bitacoras` quedó reservado; la pantalla de auditoría es read-only (sin OTP).
- Push/merge a `master` pendiente de decisión del operador.
