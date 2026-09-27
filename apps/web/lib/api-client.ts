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
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListAuditFilter,
  ListMarbetesFilter,
  RevealMarbeteRequest,
  UpdateMarbeteRequest,
  type AuditEntry,
  type BulkCreateMarbetesResponse,
  type CreateDispositivoRequest,
  type DeleteDispositivoRequest,
  type DispositivoDetailResponse,
  type ListAuditResponse,
  type ListDispositivosFilter,
  type ListDispositivosResponse,
  type ListMarbetesResponse,
  type LoginRequest,
  type MarbeteCountersResponse,
  type MarbeteDetailResponse,
  type MeResponse,
  type RevealMarbeteResponse,
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
  return new ApiError(body?.code ?? 'unknown', body?.message ?? res.statusText, res.status);
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
  otpCode: string,
  cookie?: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: buildHeaders(cookie, {
      'content-type': 'application/json',
      'x-otp-code': otpCode,
    }),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiPostWithOtp<T>(
  path: string,
  body: object,
  otpCode: string,
  cookie?: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(cookie, {
      'content-type': 'application/json',
      'x-otp-code': otpCode,
    }),
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<T>;
}

async function apiPatchWithOtp<T>(
  path: string,
  body: object,
  otpCode: string,
  cookie?: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: buildHeaders(cookie, {
      'content-type': 'application/json',
      'x-otp-code': otpCode,
    }),
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
  otpCode: string,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiDeleteWithOtp<MarbeteDetailResponse>(
    `/api/v1/marbetes/${id}`,
    req,
    otpCode,
    cookie,
  );
}

// ---- Marbetes (WU8b2) ----

export async function getStudentByCanvasId(
  canvasUserId: number,
  cookie?: string,
): Promise<StudentDetailResponse> {
  return apiGet<StudentDetailResponse>(
    `/api/v1/students?canvasUserId=${canvasUserId}`,
    cookie,
  );
}

export async function createMarbete(
  req: CreateMarbeteRequest,
  otpCode: string,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiPostWithOtp<MarbeteDetailResponse>('/api/v1/marbetes', req, otpCode, cookie);
}

export async function updateMarbete(
  id: number,
  req: UpdateMarbeteRequest,
  otpCode: string,
  cookie?: string,
): Promise<MarbeteDetailResponse> {
  return apiPatchWithOtp<MarbeteDetailResponse>(
    `/api/v1/marbetes/${id}`,
    req,
    otpCode,
    cookie,
  );
}

export async function revealMarbete(
  id: number,
  req: RevealMarbeteRequest,
  otpCode: string,
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
  return apiPostWithOtp<BulkCreateMarbetesResponse>(
    '/api/v1/marbetes/bulk',
    req,
    otpCode,
    cookie,
  );
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
  return apiPostWithOtp<DispositivoDetailResponse>(
    '/api/v1/dispositivos',
    req,
    otpCode,
    cookie,
  );
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
