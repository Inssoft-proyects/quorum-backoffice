# Backoffice — el revelado debe verse en la fila

Feature: `backoffice-reveal-row` · Fecha: 2026-10-20 · Rama: `feat/backoffice-ui-canon`

## Specs

- **S1** — «En https://backoffice.inecuni.com/backoffice/asociar sobre las matrículas "Asignados", al solicitar "Revelar" el Marbete completo, hace el flujo y se completa, sin embargo, al terminar, en la tabla no muestra el registro que se solicitó, sigue apareciendo enmascarado con los asteriscos: V\*\*\*69».
- **S2** — «¿Podrías diagnosticarlo y asegurar correcto funcionamiento? Valídalo con Playwright». La fila revelada muestra el código completo y el chip pasa a «Revelado»; el resto de las filas sigue enmascarado; el valor sobrevive al filtro de búsqueda.

## Tasks

| ID  | Spec | Ruta                                                                                                                                 | Commit                                                      |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| T1  | S1   | Estado `revealedCodes` en la página + `MaskedNumber` en la celda de «Asignados»; `onRevealed` guarda el código en vez de descartarlo | `fix(web): show the revealed marbete in the assignment row` |
| T2  | S2   | Stub con `POST /api/v1/marbetes/:id/reveal` y filtro real por `status`; spec `e2e/cosmetic/reveal.spec.ts` con dos casos             | `fix(web): show the revealed marbete in the assignment row` |
| T3  | S2   | Validación en producción con OTP de scope `marbete.reveal`                                                                           | —                                                           |

## Evidence

| Gate       | Comando                                            | Resultado                                                             |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| Tipos      | `cd apps/web && npx tsc --noEmit -p tsconfig.json` | exit 0                                                                |
| Unidad     | `npx jest --config jest.config.cjs`                | 42/42 suites, 271/271 tests                                           |
| Navegador  | `bash scripts/cosmetic-smoke.sh`                   | 17/17 tests (2 nuevos de revelado)                                    |
| Producción | script Playwright con OTP real                     | `REVEAL-OK`: `data-revealed="true"`, código completo, chip «Revelado» |

## Log

- **L1** — «Ahora por favor diagnostiva y ayúdame a resolver un flujo funcional: - En https://backoffice.inecuni.com/backoffice/asociar sonre las matrículas "Asignados", al solicitar "Revelar" el Marbete completo, hace el flujo y se completa, sin embargo, al terminar, en la tabla no muestra el registro que se solicitó, sigue apareciendo enmascarado con los asteriscos:V\*\*\*69 ¿Podrías diagnosticarlo y asegurar correcto funcionamiento? Valídalo con Playwright. Gracias»
- **L2** — Causa raíz (dos defectos, no uno): (a) `onRevealed` recibía `fullCode` y lo descartaba, y el `refetch()` posterior no podía repararlo porque la API enmascara en **toda** lectura de lista (sólo persiste el hash); (b) la celda de «Asignados» estaba dibujada a mano con un `privacy-chip` estático, sin vía para recibir el valor revelado, a diferencia de la tabla de Marbetes que ya usaba `MaskedNumber` con `revealedCodes[m.id]`.
- **L3** — Hallazgo del arnés: el stub cosmético ignoraba `?status=`, así que el panel «Asignados» listaba matrículas sin marbete y escondía el defecto detrás de datos irreales. Ahora filtra por estado como la API real.
- **L4** — Validación en producción (20-oct 08:26): el botón «Revelar» sobre la fila `V***69` devolvió `VALIDO-2609982469`, la celda quedó en `data-revealed="true"` y el chip pasó a «Revelado»; el resto de filas siguió enmascarado. Salida del script: `REVEAL-OK`.
- **L5** — Incidente de entrega (no del código): el release intentó construir **en sitio** en `/opt/quorum-backoffice/apps/web` y el build de Next falló a medio camino, dejando `.next` sin `standalone/` ni `BUILD_ID`. El pod que ya servía desde ese hostPath empezó a reiniciarse (`CrashLoopBackOff`) y el backoffice web quedó inestable entre ~08:06 y ~08:21 (la API nunca se afectó). Se restauró el bundle anterior (`.next.rollback-20261020-080612`) y después se publicó un artefacto construido en el árbol limpio con `API_INTERNAL_URL=http://127.0.0.1:4100`, verificado con las guardas (`server.js`, logo, rewrites a 4100, sin `127.0.0.1:3100`) → `PUBLISH-OK 20261020-082332`, pod `Running`, `BUILD_ID 42w5_zigS36gJ5Jx_UEKd`.
- **L6** — Prevención registrada en `RUNBOOK.md` § Release del bundle web: no construir dentro de `/opt` mientras el pod sirve; publicar siempre un artefacto construido en el worktree (rsync + rollout) y mantener el respaldo previo.
