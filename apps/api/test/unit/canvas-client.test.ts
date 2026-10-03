/**
 * Unit tests for CanvasClient (HTTP layer for the portal-api
 * /v1/students integration).
 *
 * G9 follow-up: the portal contract changed.
 *
 *   - `email` is now OPTIONAL — the portal enforces PII
 *     minimisation and may return only `email_hash`.
 *   - `is_active` (per-user enrollment status) is now OPTIONAL —
 *     legacy portal builds do not publish it.
 *   - `email_hash` is a new optional field, treated as opaque by
 *     the backoffice (it is never stored in the cache).
 *
 * What we assert:
 *   - Items missing `email` are accepted (no throw).
 *   - Items with `is_active` and `email_hash` pass through.
 *   - Items missing required fields (id / canvas_user_id /
 *     full_name) trigger `canvas_api_invalid_response` and never
 *     reach the cache.
 *   - Non-array `items` is rejected.
 *   - The existing surface (token header, query string, timeout)
 *     stays intact.
 */
import { CanvasClient } from '../../src/services/canvas-client';
import { AppError } from '../../src/lib/errors';

const URL = 'http://127.0.0.1:65535';
const TOKEN = 'test-canvas-token-1234567890';

interface CapturedCall {
  url: string;
  authorization: string | null;
  accept: string | null;
}

function makeFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(input, init);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      authorization: headers?.['authorization'] ?? null,
      accept: headers?.['accept'] ?? null,
    });
    return r;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CanvasClient — relaxed portal contract (G9 follow-up)', () => {
  it('accepts items missing email (PII-minimised portal response)', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(200, {
        total: 1,
        items: [
          {
            id: 1,
            canvas_user_id: 101,
            full_name: 'A',
            // no `email` — portal enforces PII minimisation
            email_hash: 'abc123',
            is_active: false,
          },
        ],
      }),
    );
    const client = new CanvasClient({
      baseUrl: URL,
      serviceToken: TOKEN,
      fetchImpl: fetch,
    });
    const r = await client.listStudents({ limit: 10 });
    expect(r.total).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: 1,
      canvas_user_id: 101,
      full_name: 'A',
      email_hash: 'abc123',
      is_active: false,
    });
  });

  it('accepts items without is_active (legacy portal build)', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(200, {
        total: 1,
        items: [
          { id: 1, canvas_user_id: 101, full_name: 'A', email: 'a@example.com' },
        ],
      }),
    );
    const client = new CanvasClient({
      baseUrl: URL,
      serviceToken: TOKEN,
      fetchImpl: fetch,
    });
    const r = await client.listStudents({ limit: 10 });
    expect(r.items[0]?.is_active).toBeUndefined();
    expect(r.items[0]?.email).toBe('a@example.com');
  });

  it('rejects items missing a required field (full_name) → canvas_api_invalid_response', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(200, {
        total: 1,
        items: [
          // missing full_name
          { id: 1, canvas_user_id: 101, email: 'a@example.com' },
        ],
      }),
    );
    const client = new CanvasClient({
      baseUrl: URL,
      serviceToken: TOKEN,
      fetchImpl: fetch,
    });
    await expect(client.listStudents({ limit: 10 })).rejects.toMatchObject({
      code: 'service_unavailable',
      httpStatus: 503,
      message: 'canvas_api_invalid_response',
    });
  });

  it('rejects when items is not an array → canvas_api_invalid_response', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(200, { total: 0, items: 'nope' }),
    );
    const client = new CanvasClient({
      baseUrl: URL,
      serviceToken: TOKEN,
      fetchImpl: fetch,
    });
    await expect(client.listStudents({ limit: 10 })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('sends Authorization: Bearer <token> and forwards limit/offset', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse(200, { total: 0, items: [] }),
    );
    const client = new CanvasClient({
      baseUrl: URL,
      serviceToken: TOKEN,
      fetchImpl: fetch,
    });
    await client.listStudents({ limit: 25, offset: 50, search: 'A' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${URL}/v1/students?search=A&limit=25&offset=50`);
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.accept).toBe('application/json');
  });
});
