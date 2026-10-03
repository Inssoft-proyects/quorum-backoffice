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
 *
 * G9 follow-up: the portal contract was relaxed. `email` is now
 * OPTIONAL (PII minimisation — portal may return only `email_hash`)
 * and `is_active` is now OPTIONAL (legacy portal builds do not
 * publish per-user enrollment status). The Zod schema in
 * `packages/shared/src/dto/canvas.ts` is the source of truth; we
 * parse every item with `CanvasStudent.safeParse` so a malformed
 * row surfaces as `canvas_api_invalid_response` (503) instead of
 * crashing the sync mid-page.
 */
import { AppError } from '../lib/errors';
import {
  CanvasStudent,
  type CanvasStudent as CanvasStudentT,
  type CanvasStudentListResponse,
} from '@quorum-backoffice/shared';

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
      const body = (await r.json()) as { total?: unknown; items?: unknown };
      if (
        !body ||
        !Array.isArray(body.items) ||
        typeof body.total !== 'number'
      ) {
        throw AppError.serviceUnavailable('canvas_api_invalid_response', { url });
      }
      // Validate every item against the relaxed Zod schema. The
      // schema treats `email`, `is_active`, and `email_hash` as
      // optional, so PII-minimised responses parse cleanly. A
      // missing required field (id / canvas_user_id / full_name)
      // still surfaces as `canvas_api_invalid_response` and never
      // reaches the cache.
      const parsedItems: CanvasStudentT[] = [];
      for (const raw of body.items) {
        const result = CanvasStudent.safeParse(raw);
        if (!result.success) {
          throw AppError.serviceUnavailable('canvas_api_invalid_response', {
            url,
            issues: result.error.issues,
          });
        }
        parsedItems.push(result.data);
      }
      const response: CanvasStudentListResponse = {
        total: body.total,
        items: parsedItems,
      };
      return response;
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
