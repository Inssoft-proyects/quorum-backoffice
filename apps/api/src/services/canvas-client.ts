/**
 * HTTP client for the Canvas LMS portal-api integration.
 *
 *   GET {CANVAS_PORTAL_API_URL}/v1/students?search=... → CanvasStudentListResponse
 *
 * Uses fetch + service token (HMAC). Timeouts at 5s. Failures map to AppError.
 *
 * In WU3b the integration is read-only: it hydrates the students_cache
 * (via the repository) before returning, so subsequent MarbetesService
 * reads stay inside our DB.
 */
import { AppError } from '../lib/errors';
import type { CanvasStudentListResponse, CanvasStudent } from '@quorum-backoffice/shared';

interface CanvasClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CanvasClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.serviceToken = opts.serviceToken;
    this.fetchImpl =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input as RequestInfo, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async listStudents(params: { search?: string; limit?: number; offset?: number }): Promise<CanvasStudentListResponse> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));

    const url = `${this.baseUrl}/v1/students${qs.size ? `?${qs.toString()}` : ''}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          accept: 'application/json',
        },
        signal: ac.signal,
      });
      if (!r.ok) {
        throw AppError.serviceUnavailable(`canvas_api_${r.status}`, { url });
      }
      const body = (await r.json()) as CanvasStudentListResponse;
      if (!body || !Array.isArray(body.items)) {
        throw AppError.serviceUnavailable('canvas_api_invalid_response', { url });
      }
      return body;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw AppError.serviceUnavailable('canvas_api_timeout', { url, timeoutMs: this.timeoutMs });
      }
      if (err instanceof AppError) throw err;
      throw AppError.serviceUnavailable('canvas_api_error', { url, message: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience: hydrate students_cache by id or search, return canonical rows. */
  async hydrateStudentById(canvasId: number): Promise<CanvasStudent | null> {
    const r = await this.listStudents({ search: String(canvasId), limit: 5 });
    return r.items.find((s) => s.canvas_user_id === canvasId) ?? null;
  }
}
