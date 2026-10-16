# Flujos de trabajo MFA — revisados y cerrados

Documento de referencia para ejecutar los flujos de **autenticación MFA** y de
**acceso a videoconferencia** de la suite Quorum. Describe, para cada flujo:

1. qué se necesita para iniciar y seguirlo,
2. a qué **endpoint** se llama (método, payload, respuesta),
3. qué **token** de secrets se requiere (y a quién pedirlo).

Los scripts que automatizan estos flujos están en `apps/api/scripts/` y ya están
probados de punta a punta contra el entorno real (sin mocks).

---

## 1. Requisitos generales (para iniciar cualquier flujo)

- **Acceso de red** a los hosts. Desde la dev-box se usan port-forwards; en otro
  entorno se usan las URLs públicas:

  | Servicio | URL local (port-forward) | URL pública |
  |---|---|---|
  | API Backoffice | `http://127.0.0.1:4100` | `https://backoffice.quorum.asistentepro.mx` |
  | Servicio OTP | `http://127.0.0.1:4200` | `https://otp.quorum.asistentepro.mx` |
  | Proxy Jitsi (videoconferencia) | — | `https://quorum.inecuni.com` |

- **Herramientas** instaladas (los scripts las verifican): `curl`, `openssl`,
  `python3` y `kubectl`.
- **Tokens HMAC** (sección 2). **Contacta al área de desarrollo para obtenerlos.**
- **Datos de fixture** (sección 3) para el ejemplo válido.

---

## 2. Secretos / tokens (NO se publican aquí)

Los tokens HMAC viven en el Secret de Kubernetes
`quorum-backoffice/quorum-backoffice-api-secret` y **no se incluyen en este
documento**. Si un flujo los requiere, **ponte en contacto con el área de
desarrollo** para que te los proporcione por un canal seguro (nunca en chat,
tickets o correo).

| Token | Uso | Dónde vive |
|---|---|---|
| `OTP_SERVICE_TOKEN` | Firmar `POST /v1/otps` (emitir el OTP de acceso) | Secret `quorum-backoffice-api-secret`, clave `OTP_SERVICE_TOKEN` |
| `BACKOFFICE_SERVICE_TOKENS` | Firmar `POST /api/v1/mfa/get-subject` (S2S) | Secret `quorum-backoffice-api-secret`, clave `BACKOFFICE_SERVICE_TOKENS`, formato `canvas:<secret>` |

> Los scripts `mfa-*.sh` leen estos secretos **automáticamente** vía `kubectl`;
> no necesitas exportarlos a mano. La firma es
> `HMAC-SHA256(secret, "<ts>.<cuerpo-json-exacto>")` en hex, con cabecera
> `Authorization: HMAC <name> <ts> <sig>`.

---

## 3. Datos de fixture (ejemplo válido de punta a punta)

| Campo | Valor |
|---|---|
| Matrícula SIS | `TOPGR4` |
| Subject (`canvas_user_id`) | `13` |
| Marbete | `VALIDO-2609982468` |
| Serial del dispositivo | `f401e1afcfd09b16` |
| Room (videoconferencia) | `sesion-de-prueba` (o `Curso-de-prueba`) |

---

## 4. Flujo 1 — Inicio de sesión desde la App móvil

**Script:** `apps/api/scripts/mfa-mobile-login.sh`

**Resumen:** resolver la identidad del alumno → emitir un OTP de acceso →
autenticarlo y obtener su `session_id`.

### 4.1 Pasos y endpoints

| # | Endpoint | Auth | Request (payload) | Response (salida) |
|---|---|---|---|---|
| 1 | `POST {BACKOFFICE}/api/v1/mfa/get-subject` | 🔑 HMAC S2S (`BACKOFFICE_SERVICE_TOKENS`) | `{"marbete_code":"…","serial_number":"…"}` | `{"canvas_user_id":13,"matricula":"TOPGR4"}` |
| 2 | `POST {OTP}/v1/otps` | 🔑 HMAC (`OTP_SERVICE_TOKEN`) | `{"subject":"13","scope":"mfa.access"}` | `{"id":"…","token":"K7QM3X","subject":"13","scope":"mfa.access","expires_at":"…",…}` |
| 3 | `POST {BACKOFFICE}/api/v1/mfa/authenticate` | 🟢 (el flujo ES la autenticación) | `{"marbete_code":"…","serial_number":"…","otp":"K7QM3X"}` | `{"canvas_user_id":13,"student_name":null,"student_email":null,"matricula":"TOPGR4","role":"student","session_id":"…","expires_at":"…"}` |

> **Nota del paso 1:** hoy `get-subject` **aún no está desplegado** (PR #19 sin
> mergear). El script lo omite por defecto usando `SUBJECT=13` y solo lo resuelve
> si se indica `USE_GET_SUBJECT=1`.

### 4.2 Cómo ejecutarlo

```bash
cd /planQuorum/dev/quorum-backoffice/apps/api/scripts
./mfa-mobile-login.sh
```

La App móvil usa el campo **`session_id` del body** (no la cookie).

---

## 5. Flujo 2 — Acceso a una videoconferencia

**Script:** `apps/api/scripts/mfa-videoconference-join.sh`

**Resumen:** resolver/identificar al alumno → emitir un OTP de acceso → unirlo a
la sala Jitsi y obtener la `joinUrl` (con JWT de admisión).

### 5.1 Pasos y endpoints

| # | Endpoint | Auth | Request (payload) | Response (salida) |
|---|---|---|---|---|
| 1 | `POST {BACKOFFICE}/api/v1/mfa/get-subject` | 🔑 HMAC S2S | `{"marbete_code":"…","serial_number":"…"}` | `{"canvas_user_id":13,"matricula":"TOPGR4"}` |
| 2 | `POST {OTP}/v1/otps` | 🔑 HMAC (`OTP_SERVICE_TOKEN`) | `{"subject":"13","scope":"mfa.access"}` | `{…,"token":"K7QM3X",…}` |
| 3 | `POST {JOIN}/join` | 🟢 (el OTP es de un solo uso) | `{"room":"sesion-de-prueba","marbete_code":"…","serial_number":"…","otp":"K7QM3X"}` | `{"joinUrl":"https://quorum.inecuni.com/sesion-de-prueba?jwt=…"}` |

### 5.2 Cómo ejecutarlo

```bash
cd /planQuorum/dev/quorum-backoffice/apps/api/scripts
./mfa-videoconference-join.sh                        # room por defecto: Curso-de-prueba
ROOM='sesion-de-prueba' ./mfa-videoconference-join.sh  # sala específica
```

Abre la `joinUrl` resultante en el navegador para entrar a la videoconferencia.

---

## 6. Flujo 3 (subyacente) — Autenticación MFA (marbete + serial + OTP)

**Script:** `apps/api/scripts/mfa-authenticate-smoke.sh`

Es el núcleo común de los dos flujos anteriores: emitir el OTP y autenticarlo.

| # | Endpoint | Auth | Request | Response |
|---|---|---|---|---|
| 1 | `POST {OTP}/v1/otps` | 🔑 HMAC (`OTP_SERVICE_TOKEN`) | `{"subject":"13","scope":"mfa.access"}` | `{…,"token":"K7QM3X",…}` |
| 2 | `POST {BACKOFFICE}/api/v1/mfa/authenticate` | 🟢 | `{"marbete_code":"…","serial_number":"…","otp":"K7QM3X"}` | `{"canvas_user_id":13,…,"matricula":"TOPGR4","role":"student","session_id":"…",…}` |

```bash
cd /planQuorum/dev/quorum-backoffice/apps/api/scripts
./mfa-authenticate-smoke.sh
```

---

## 7. Endpoint nuevo — `POST /api/v1/mfa/get-subject`

Resuelve `marbete + serial` → `canvas_user_id` + matrícula SIS.

- **Estado:** código listo y probado; **pendiente de merge del PR #19**
  (https://github.com/Inssoft-proyects/quorum-backoffice/pull/19). Hasta que no
  se mergee, devuelve `404` en el API desplegado.
- **Auth:** 🔑 HMAC S2S sobre `BACKOFFICE_SERVICE_TOKENS` (caller `canvas`).
- **Request:** `{"marbete_code":"…","serial_number":"…"}`
- **Response (200):** `{"canvas_user_id":13,"matricula":"TOPGR4"}`
- **Denegaciones (401):** `deny.marbete_unknown`, `deny.student_inactive`,
  `deny.device_unknown`, `deny.idp_untrusted`.
  > El dispositivo es un factor de **autorización** (lista blanca de equipos
  > aprobados), no de identidad: basta con que esté `active` y no revocado.
  > No se requiere asociarlo a un alumno (pool compartido de aula).

---

## 8. Resumen de endpoints

| Método | Endpoint | Auth | Propósito |
|---|---|---|---|
| `POST` | `/api/v1/mfa/get-subject` | 🔑 HMAC S2S | marbete + serial → `canvas_user_id` + matrícula |
| `POST` | `/api/v1/mfa/authenticate` | 🟢 | autenticar (marbete + serial + OTP) → sesión estudiante |
| `POST` | `/v1/otps` | 🔑 HMAC | emitir OTP de acceso |
| `POST` | `/join` | 🟢 | unirse a videoconferencia → `joinUrl` |

**Tokens a solicitar al área de desarrollo:** `OTP_SERVICE_TOKEN` y
`BACKOFFICE_SERVICE_TOKENS` (ambos en `quorum-backoffice-api-secret`).
