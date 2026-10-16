# MFA shared-device allowlist

Feature: quitar el vínculo dispositivo→alumno en los 3 flujos MFA; el dispositivo queda como lista blanca de equipos aprobados (activo + no revocado), sin aportar identidad.
Repo: `quorum-backoffice` · Rama: `main` · Estado: autorizado (2026-10-16), plan en revisión.

## Specs

Los `S#` citan textualmente al operador; no agregan requisitos no pedidos.

- **S1** — "el marbete_code permite tener la identidad y el OTP la identidad fuerte, el dispositivo sólo aporta una confirmación y no una identidad".
- **S2** — "en un salón de clases los alumnos tienen asignados cada uno un marbete y pueden generar (a través de su propia aplicación móvil) su OTP".
- **S3** — "cada alumno, cada clase podrá tomar del estante un dispositivo que puede ser diferente cada vez".
- **S4** — "lo que sí es necesario asegurar que sólo pueden usar los dispositivos que están registrados para el salón de clases, así no podrían usar un dispositivo personal".
- **S5** — "no es necesario asociar ninguno de los dispositivos a algún alumno. Como cualquier alumno puede usar cualquiera de los dispositivos que estén aprobados, puede acceder."
- **S6** — "es innecesario que exista el campo assigned_student_id, porque no lo asociaremos los dispositivos a los estudiantes".

Contrato derivado (evidencia de código, no requisito nuevo):

- Chequeo de dispositivo en los 3 flujos → `status = 'active' AND revoked_at IS NULL` ("registrado y aprobado").
- Dispositivo no registrado/personal → `deny.device_unknown` (sin cambios; ya lo devuelve `findDeviceBySerialNumber` al no hallar fila).
- El OTP conserva `subject = String(canvas_user_id)` y `scope = mfa.access` (la identidad no cambia).
- `deny.device_not_bound_to_student` deja de emitirse; se **depreca** (el literal queda en el enum Zod, no se elimina en esta fase).
- Columna `dispositivos.assigned_student_id` queda **presente pero ignorada** en esta fase (sin `ALTER TABLE`, reversible); su eliminación es una fase 2 separada.
- Interpretación elegida: **pool único compartido** (un dispositivo registrado sirve en cualquier clase). La separación por salón (Interpretación B) no se implementa; si se requiere, es una feature aparte con su propio modelo `aulas` + `device.classroom_id`.

## Tasks

| ID | S# | Tarea | Ruta | Commit |
|----|----|-------|------|--------|
| T1 | S1, S5 | `mfa-get-subject-service.ts`: chequeo de dispositivo pasa a `status='active' AND revoked_at IS NULL` (quitar `assigned_student_id === null` y la comparación `!== student.id`) | inline | work-unit |
| T2 | S1, S5 | `mfa-authenticate-service.ts`: mismo cambio (paso 4 del flujo) | inline | work-unit |
| T3 | S1, S4, S5 | `access-decision-service.ts` + `pg-dispositivos.ts`: sustituir `findActiveOwnerBySerialAndCanvasId` (JOIN sobre `assigned_student_id`) por `isApprovedDevice(serial)`; el `canvas_user_id` se conserva como `subject` del OTP | inline | work-unit |
| T4 | S1–S6 | Tests unit + integración (RED→GREEN): (a) activo + no asignado → allow; (b) revocado → `deny.device_unknown`; (c) serial desconocido → `deny.device_unknown`; (d) el OTP sigue ligado a `canvas_user_id` (identidad preservada) | inline | work-unit |
| T5 | S2, S6 | Docs + OpenAPI: deprecar `deny.device_not_bound_to_student`, nota de columna ignorada, actualizar `docs/mfa-flujos.md` + `RUNBOOK.md` | inline | work-unit |
| T6 | S1–S6 | Verificación independiente (alto riesgo: seguridad + contrato consumido por el ecosistema) | `gentle-ai-verify` | — |
| T7 | S1–S6 | Commit de unidad de trabajo (Conventional Commit) | — | pendiente de autorización |

## Log

- **L1** (petición original, textual): "Estoy probando un endpoint de join, sin embargo, al solicitar este endpoint me indica que el dispositivo no existe, aunque sí aparece en la interfaz web que tenemos. Genera el curl de lo siguiente para que pruebe a mano y averigua por qué no podría funcionar: POST https://backoffice.inecuni.com/api/v1/mfa/get-subject { marbete_code: VALIDO-2609982468, serial_number: 18e80552ef2efef9 }".
- **L2** (2026-10-16, diagnóstico): el serial `18e80552ef2efef9` (id=1009, creado por `admin` vía web, `assigned_student_id = NULL`) da `deny.device_unknown`; el serial `f401e1afcfd09b16` (id=3, `created_by=synthetic-seed`, `assigned_student_id = 8`) da 200 `{canvas_user_id:13,matricula:TOPGR4}`. La web solo registra inventario (CRUD); no expone el endpoint de asignación (`POST /api/v1/dispositivos/:id/assign`).
- **L3** (2026-10-16, decisión del operador): "no es necesario asociar ninguno de los dispositivos a algún alumno. Como cualquier alumno puede usar cualquiera de los dispositivos que estén aprobados, puede acceder. De lo anterior, podría confirmar que es innecesario que exista el campo assigned_student_id, porque no lo asociaremos los dispositivos a los estudiantes".
- **L4** (2026-10-16, caso de uso, textual): "en un salón de clases los alumnos tienen asignados cada uno un marbete y pueden generar (a través de su propia aplicación móvil) su OTP. Sin embargo, cada alumno, cada clase podrá tomar del estante un dispositivo que puede ser diferente cada vez. Lo que sí es necesario asegurar que sólo pueden usar los dispositivos que están registrados para el salón de clases, así no podrían usar un dispositivo personal".
- **L5** (2026-10-16, decisión de diseño): modelo de identidad confirmado — marbete = identidad, OTP = identidad fuerte, dispositivo = autorización (lista blanca). Interpretación A (pool único compartido) elegida; el dispositivo se valida solo por `status='active' AND revoked_at IS NULL`. Esta decisión **supersede** el vínculo 1:1 decidido en `odd/tasks/canvas-jitsi-device-binding.md` (B1–B2).
- **L6** (2026-10-16, autorización): "Excelente, por favor, sí procede con el plan en ODD, gracias".
