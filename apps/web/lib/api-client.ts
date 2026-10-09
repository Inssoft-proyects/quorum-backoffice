/**
 * API client for the backoffice.
 *
 * Two flavours:
 *   - Callers in the browser omit the `cookie` arg; the browser handles
 *     the session cookie automatically via `credentials: 'include'`.
 *   - Server components / route handlers / layouts pass a cookie string
 *     (built from next/headers) that we forward as the `cookie` header,
 *     since the browser cookie store is not available in the Node runtime.
 *
 * The base URL comes from NEXT_PUBLIC_API_URL (default http://127.0.0.1:3100).
 */

import type { z } from 'zod';
import {
  BulkCreateMarbetesRequest,
  BulkXlsxCreateRequest,
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListAuditFilter,
  ListMarbetesFilter,
  ListMatriculasFilter,
  RevealMarbeteRequest,
  UnassignMarbeteRequest,
  UpdateMarbeteRequest,
  type AssignMarbetesRequest,
  type AssignMarbetesResponse,
  type AuditEntry,
  type BulkCreateMarbetesResponse,
  type BulkXlsxCreateResponse,
  type CreateDispositivoRequest,
  type DeleteDispositivoRequest,
  type DispositivoDetailResponse,
  type ListAuditResponse,
  type ListDispositivosFilter,
  type ListDispositivosResponse,
  type ListMarbetesResponse,
  type ListMatriculasResponse,
  type LoginRequest,
  type MarbeteCountersResponse,
  type MarbeteDetailResponse,
  type MatriculasCountersResponse,
  type MeResponse,
  type MfaAuthenticateRequest,
  type MfaAuthenticateResponse,
  type OtpGrantStatusResponse,
  type RevealMarbeteResponse,
  type SyncMatriculasResponse,
  type UpdateDispositivoRequest,
} from '@quorum-backoffice/shared';

/**
 * Student detail shape returned by GET /api/v1/students?canvasUserId=...
 * (apps/api/src/services/students-service.ts). Mirrored locally so the web
 * package does not depend on the api package; the API is the source of
 * truth and the integration tests assert the round-trip.
 */
export interface StudentDetailResponse {
  id: number;
  canvasUserId: number;
  fullName: string;
  email: string;
  isActive: boolean;
}

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3100';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorEnvelope | null = null;
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(
    body?.code ?? 'unknown',
    body?.message ?? res.statusText,
    res.status,
    body?.details,
  );
}

function buildHeaders(cookie?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (cookie) headers['cookie'] = cookie;
  return headers;
}

function buildQueryString(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function apiGet<T>(path: string, cookie?: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: buildHeaders(cookie),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown, cookie?: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(cookie, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiDeleteWithOtp<T>(
  path: string,
  body: object,
  otpCode: string | undefined,
  cookie?: string,
): Promise<T> {
  const extra: Record<string, string> = { 'content-type': 'application/json' };
  if (otpCode !== undefined) extra['x-otp-code'] = otpCode;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: buildHeaders(cookie, extra),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiPostWithOtp<T>(
  path: string,
  body: object,
  otpCode: string | undefined,
  cookie?: string,
): Promise<T> {
  const extra: Record<string, string> = { 'content-type': 'application/json' };
  if (otpCode !== undefined) extra['x-otp-code'] = otpCode;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(cookie, extra),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiPatchWithOtp<T>(
  path: string,
  body: object,
  otpCode: string | undefined,
  cookie?: string,
): Promise<T> {
  const extra: Record<string, string> = { 'content-type': 'application/json' };
  if (otpCode !== undefined) extra['x-otp-code'] = otpCode;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: buildHeaders(cookie, extra),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

// ---- Auth (single-step username + pre-issued OTP) ----

/**
 * Single-step login: exchange `{ username, otp }` for a session cookie.
 *
 * The OTP is pre-issued by the broader quorum ecosystem; BackOffice
 * verifies it via HMAC under the `quorum-backoffice` service identity
 * and resolves the local account to preserve its role. The
 * `MeResponse.email` field is preserved on the response for existing
 * UI/audit consumers.
 *
 * Throws `ApiError` on transport failures or 5xx. Provider 401/403
 * (i.e. HMAC misconfiguration) surfaces as a 503 with code
 * `service_unavailable` so the UI can show a distinct "El servicio de
 * verificación no está disponible" message — it is NOT the same as
 * the user's OTP being wrong (which is a 401 invalid_credentials).
 */
export async function login(body: LoginRequest, cookie?: string): Promise<MeResponse> {
  const data = await apiPost<{ user: MeResponse }>('/api/v1/auth/login', body, cookie);
  return data.user;
}

// ---- MFA (M1 endpoint, M2 web client) ----

/**
 * Three-factor authentication (marbete code + device serial + dynamic
 * OTP). The endpoint sets the `__Host-mfa_sid` student session
 * cookie as a side effect; the JSON body returns the resolved
 * student identity so the client can render the success screen
 * without a follow-up `GET /api/v1/mfa/session` call.
 *
 * Throws `ApiError` on transport failures or 4xx/5xx. The error
 * `code` carries the `deny.*` taxonomy (401) or `validation_error`
 * (400) or `deny.dependency_fail` (503). The MFA web form maps
 * each of these to a short Spanish message — see
 * `apps/web/app/mfa/mfa-form.tsx`.
 *
 * `credentials: 'include'` is wired into `apiPost` so the browser
 * will keep the Set-Cookie header the server returns.
 */
export async function mfaAuthenticate(
  body: MfaAuthenticateRequest,
  cookie?: string,
): Promise<MfaAuthenticateResponse> {
  return apiPost<MfaAuthenticateResponse>('/api/v1/mfa/authenticate', body, cookie);
}

// ---- MFA (M3 redirect-token — SSO between BackOffice and Canvas) ----

/**
 * `POST /api/v1/mfa/redirect-token` (M3). The MFA web page calls
 * this AFTER a successful `mfaAuthenticate` to mint a one-time
 * token that Canvas exchanges for a Canvas-side session via
 * `POST /api/v1/mfa/consume`.
 *
 * The call is authenticated by the `__Host-mfa_sid` student
 * session cookie the M1 endpoint set — NOT by HMAC service-auth.
 * The browser sends the cookie automatically via
 * `credentials: 'include'`. The body is the validated `next_url`
 * the MFA page will navigate to (with the token appended as a
 * query string).
 *
 * Throws `ApiError` on transport failures or 4xx/5xx. The error
 * `code` carries the documented M3 taxonomy:
 *   - `validation_error`        (400) — body failed Zod validation
 *   - `invalid_request`         (400) — next_url is not a parseable URL
 *   - `unauthorized`            (401) — no active MFA session
 *   - `mfa_session_kind_invalid` (401) — session is a backoffice operator session
 *   - `mfa_redirect_origin_not_allowed` (403) — next_url origin not allowlisted
 *
 * On a 5xx (Redis down) the route returns 500 with code `internal`
 * — the MFA form catches this and falls back to the direct
 * navigation with a warn log.
 */
export interface MfaRedirectTokenRequest {
  next_url: string;
}

export interface MfaRedirectTokenResponse {
  token: string;
  expires_in: number;
}

export async function mfaIssueRedirectToken(
  body: MfaRedirectTokenRequest,
  cookie?: string,
): Promise<MfaRedirectTokenResponse> {
  return apiPost<MfaRedirectTokenResponse>('/api/v1/mfa/redirect-token', body, cookie);
}

export async function logout(cookie?: string): Promise<void> {
  // No body sent; omit content-type so Fastify doesn't try to parse an
  // empty JSON document (which it would reject with 500). The route
  // handler reads only the session cookie.
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(`${API_BASE}/api/v1/auth/logout`, {
    method: 'POST',
    headers,
    credentials: 'include',
  });
  // 200 or 401 both mean "logged out" from the caller's perspective.
  if (res.status !== 200 && res.status !== 401) throw await parseError(res);
}

export async function me(cookie?: string): Promise<MeResponse | null> {
  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
    method: 'GET',
    headers: buildHeaders(cookie),
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status === 401) return null;
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as MeResponse;
}

// ---- Marbetes (WU8a) ----

export async function getMarbeteCounters(cookie?: string): Promise<MarbeteCountersResponse> {
  return apiGet<MarbeteCountersResponse>('/api/v1/marbetes/counters', cookie);
}

/**
 * Read the session actor's current OTP grant window for the marbete
 * scope family. The dialogs (add / revoke) call this on open and use
 * the response to decide whether to hide the OTP input field.
 *
 * `OtpGrantStatusResponse` is the shared DTO contract (see
 * packages/shared/src/dto/marbete.ts). When the grant service is not
 * configured the server returns `{ active: false, expiresAt: null }`,
 * which the dialogs treat as "OTP required" — the safe default.
 */
export async function getMarbeteOtpGrant(cookie?: string): Promise<OtpGrantStatusResponse> {
  return apiGet<OtpGrantStatusResponse>('/api/v1/marbetes/otp-grant', cookie);
}

export async function listMarbetes(
  filter: z.input<typeof ListMarbetesFilter>,
  cookie?: string,
): Promise<ListMarbetesResponse> {
  const qs = buildQueryString({
    status: filter.status,
    assigned: filter.assigned,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  });
  return apiGet<ListMarbetesResponse>(`/api/v1/marbetes${qs}`, cookie);
}

export async function getMarbete(id: number, cookie?: string): Promise<MarbeteDetailResponse> {
  return apiGet<MarbeteDetailResponse>(`/api/v1/marbetes/${id}`, cookie);
}

export async function deleteMarbete(
  id: number,
  req: DeleteMarbeteRequest,
  otpCode: string | undefined,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiDeleteWithOtp<MarbeteDetailResponse>(`/api/v1/marbetes/${id}`, req, otpCode, cookie);
}

// ---- Marbetes (WU8b2) ----

export async function getStudentByCanvasId(
  canvasUserId: number,
  cookie?: string,
): Promise<StudentDetailResponse> {
  return apiGet<StudentDetailResponse>(`/api/v1/students?canvasUserId=${canvasUserId}`, cookie);
}

export async function createMarbete(
  req: CreateMarbeteRequest,
  otpCode: string | undefined,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiPostWithOtp<MarbeteDetailResponse>('/api/v1/marbetes', req, otpCode, cookie);
}

export async function updateMarbete(
  id: number,
  req: UpdateMarbeteRequest,
  otpCode: string | undefined,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiPatchWithOtp<MarbeteDetailResponse>(`/api/v1/marbetes/${id}`, req, otpCode, cookie);
}

export async function revealMarbete(
  id: number,
  req: RevealMarbeteRequest,
  otpCode: string | undefined,
  cookie?: string,
): Promise<RevealMarbeteResponse> {
  return apiPostWithOtp<RevealMarbeteResponse>(
    `/api/v1/marbetes/${id}/reveal`,
    req,
    otpCode,
    cookie,
  );
}

// ---- Marbetes bulk upload (WU #3 / Polish WU v4) ----
//
// Admin-only transactional create of up to 200 marbetes in a single
// call. Per-row outcomes are returned in `successes` / `failures` so
// partial successes are observable; the dialog displays the summary
// before the parent re-fetches via onSaved().
export async function bulkCreateMarbetes(
  req: z.input<typeof BulkCreateMarbetesRequest>,
  otpCode: string,
  cookie?: string,
): Promise<BulkCreateMarbetesResponse> {
  return apiPostWithOtp<BulkCreateMarbetesResponse>('/api/v1/marbetes/bulk', req, otpCode, cookie);
}

// ---- Marbetes bulk upload via .xlsx (T4) ----
//
// Admin-only .xlsx upload to /api/v1/marbetes/bulk-xlsx. Reads the
// browser File as base64 in the browser and ships it via the
// shared `BulkXlsxCreateRequest` shape (`fileName` + `contentBase64`).
// Per-row outcomes share the JSON /bulk shape (successes / failures /
// auditId) plus xlsx-specific metadata: skipped example rows, a
// `categoryCounts` histogram, and a downloadable errors workbook.
// The 20-minute OTP grant window applies exactly like the JSON /bulk
// endpoint — omit `otpCode` when a grant is active.
export async function bulkCreateMarbetesXlsx(
  args: {
    file: File;
    reason?: string;
    otpCode: string | undefined;
    cookie?: string;
  },
): Promise<BulkXlsxCreateResponse> {
  const contentBase64 = await readFileAsBase64(args.file);
  const req: z.input<typeof BulkXlsxCreateRequest> = {
    fileName: args.file.name,
    contentBase64,
    ...(args.reason ? { reason: args.reason } : {}),
  };
  return apiPostWithOtp<BulkXlsxCreateResponse>(
    '/api/v1/marbetes/bulk-xlsx',
    req,
    args.otpCode,
    args.cookie,
  );
}

/**
 * Read a browser File as canonical base64.
 *
 * Uses FileReader.readAsArrayBuffer() (universally available in
 * browsers + jsdom) + manual binary concatenation + btoa() so we
 * don't pull a base64 polyfill into the bundle. btoa() is available
 * in modern browsers, Node 18+, and jsdom (so the api-client test
 * environment exercises the same code path). File.arrayBuffer() is
 * the modern alternative but isn't implemented by jest-environment-
 * jsdom 30, hence the FileReader fallback.
 */
async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await readFileAsArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  // Chunk the concat so very large workbooks (up to 5 MB) don't
  // blow the JS string limit on older engines. 0x8000 = 32 KiB.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Read a File as ArrayBuffer using FileReader. Returns a Promise so
 * the api-client can be `await`ed. Falls back to `file.arrayBuffer()`
 * if FileReader is unavailable (modern Node / future jsdom).
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('file_read_invalid_result'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('file_read_failed'));
    };
    reader.readAsArrayBuffer(file);
  });
}

// ---- Dispositivos (WU9) ----

export async function listDispositivos(
  filter: z.input<typeof ListDispositivosFilter>,
  cookie?: string,
): Promise<ListDispositivosResponse> {
  const qs = buildQueryString({
    status: filter.status,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  });
  return apiGet<ListDispositivosResponse>(`/api/v1/dispositivos${qs}`, cookie);
}

export async function getDispositivo(
  id: number,
  cookie?: string,
): Promise<DispositivoDetailResponse> {
  return apiGet<DispositivoDetailResponse>(`/api/v1/dispositivos/${id}`, cookie);
}

export async function createDispositivo(
  req: CreateDispositivoRequest,
  otpCode: string,
  cookie?: string,
): Promise<DispositivoDetailResponse> {
  return apiPostWithOtp<DispositivoDetailResponse>('/api/v1/dispositivos', req, otpCode, cookie);
}

export async function updateDispositivo(
  id: number,
  req: UpdateDispositivoRequest,
  otpCode: string,
  cookie?: string,
): Promise<DispositivoDetailResponse> {
  return apiPatchWithOtp<DispositivoDetailResponse>(
    `/api/v1/dispositivos/${id}`,
    req,
    otpCode,
    cookie,
  );
}

export async function revokeDispositivo(
  id: number,
  req: DeleteDispositivoRequest,
  otpCode: string,
  cookie?: string,
): Promise<DispositivoDetailResponse> {
  return apiDeleteWithOtp<DispositivoDetailResponse>(
    `/api/v1/dispositivos/${id}`,
    req,
    otpCode,
    cookie,
  );
}

// ---- Matrículas (WU v3 "Asignación de marbetes") ----
//
// Both `assignMatriculas` and `unassignMatricula` are admin + OTP-gated
// destructive writes that follow the same grant-aware convention as
// `createMarbete` / `updateMarbete` / `deleteMarbete`: when an OTP
// grant is active the dialogs call these with `otpCode: undefined`
// so the x-otp-code header is OMITTED and the server consults the
// grant cache; otherwise the dialogs pass a 6-digit code and the
// header IS sent.
export async function listMatriculas(
  filter: z.input<typeof ListMatriculasFilter>,
  cookie?: string,
): Promise<ListMatriculasResponse> {
  const qs = buildQueryString({
    status: filter.status,
    search: filter.search,
    isActive: filter.isActive,
    limit: filter.limit,
    offset: filter.offset,
  });
  return apiGet<ListMatriculasResponse>(`/api/v1/matriculas${qs}`, cookie);
}

export async function getMatriculasCounters(
  cookie?: string,
): Promise<MatriculasCountersResponse> {
  return apiGet<MatriculasCountersResponse>('/api/v1/matriculas/counters', cookie);
}

export async function assignMatriculas(
  req: z.input<typeof AssignMarbetesRequest>,
  otpCode: string | undefined,
  cookie?: string,
): Promise<AssignMarbetesResponse> {
  return apiPostWithOtp<AssignMarbetesResponse>(
    '/api/v1/matriculas/assign',
    req,
    otpCode,
    cookie,
  );
}

export async function unassignMatricula(
  req: z.input<typeof UnassignMarbeteRequest>,
  otpCode: string | undefined,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiPostWithOtp<MarbeteDetailResponse>(
    '/api/v1/matriculas/unassign',
    req,
    otpCode,
    cookie,
  );
}

/**
 * Admin-only Canvas → students_cache sync (POST /api/v1/matriculas/sync).
 *
 * Not OTP-gated and not grant-eligible: a sync is a read-side cache
 * refresh, not a destructive marbete write. The endpoint is wired
 * through the standard `apiPost` so the request body always carries
 * the typed empty payload; this also keeps `credentials: 'include'`
 * consistent with every other admin call.
 */
export async function syncMatriculas(cookie?: string): Promise<SyncMatriculasResponse> {
  return apiPost<SyncMatriculasResponse>('/api/v1/matriculas/sync', {}, cookie);
}

// ---- Audit (WU10) ----

/**
 * Read-only audit log wrapper. Both endpoints are gated to auditor+ by the
 * API (requireRole('auditor')). Caller in the browser omits `cookie`; the
 * server component / route handler forwards the session cookie string.
 */
export async function listAuditEntries(
  filter: z.input<typeof ListAuditFilter>,
  cookie?: string,
): Promise<ListAuditResponse> {
  const qs = buildQueryString({
    entityType: filter.entityType,
    entityId: filter.entityId,
    actorId: filter.actorId,
    action: filter.action,
    since: filter.since,
    until: filter.until,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  });
  return apiGet<ListAuditResponse>(`/api/v1/audit${qs}`, cookie);
}

export async function getAuditEntry(id: number, cookie?: string): Promise<AuditEntry> {
  return apiGet<AuditEntry>(`/api/v1/audit/${id}`, cookie);
}
