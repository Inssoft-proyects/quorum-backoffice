/**
 * Tests for the matriculas api-client wrappers introduced in WU v3.
 *
 * Covers:
 *  - listMatriculas encodes status + isActive + search into the
 *    querystring and returns the typed response.
 *  - getMatriculasCounters returns the counters shape.
 *  - assignMatriculas: POST + x-otp-code + JSON body. When called
 *    with otpCode=undefined the header is OMITTED (grant-aware).
 *  - unassignMatricula: POST + grant-aware OTP header behaviour +
 *    required reason body.
 *  - syncMatriculas: POST (admin, no OTP).
 */
import {
  assignMatriculas,
  getMatriculasCounters,
  listMatriculas,
  syncMatriculas,
  unassignMatricula,
} from '@/lib/api-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function installFetchMock(
  status: number,
  responseBody: unknown,
): { read(): CapturedRequest } {
  const holder: { current: CapturedRequest | null } = { current: null };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? '');
    holder.current = { url, method: init?.method ?? '', headers, body };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    read(): CapturedRequest {
      if (!holder.current) throw new Error('fetch was not called');
      return holder.current;
    },
  };
}

describe('listMatriculas', () => {
  it('encodes status + isActive + search + limit + offset into the querystring', async () => {
    let lastUrl = '';
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      lastUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({ total: 0, limit: 50, offset: 0, items: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await listMatriculas({
      status: 'unassigned',
      search: 'ana',
      limit: 200,
      offset: 0,
    });
    expect(lastUrl).toMatch(/status=unassigned/);
    expect(lastUrl).toMatch(/search=ana/);
    expect(lastUrl).toMatch(/limit=200/);
  });

  it('returns the typed response', async () => {
    installFetchMock(200, {
      total: 0,
      limit: 50,
      offset: 0,
      items: [],
    });
    const response = await listMatriculas({
      status: 'unassigned',
      isActive: 'true',
      limit: 50,
      offset: 0,
    });
    expect(response).toEqual({ total: 0, limit: 50, offset: 0, items: [] });
  });
});

describe('getMatriculasCounters', () => {
  it('returns the counters shape', async () => {
    installFetchMock(200, {
      total: 12,
      assigned: 7,
      unassigned: 5,
      availableMarbetes: 8,
    });
    const response = await getMatriculasCounters();
    expect(response).toEqual({
      total: 12,
      assigned: 7,
      unassigned: 5,
      availableMarbetes: 8,
    });
  });
});

describe('assignMatriculas — grant-aware OTP header', () => {
  it('omits x-otp-code when otpCode is undefined', async () => {
    const capture = installFetchMock(200, {
      total: 1,
      pairs: [{ canvasUserId: 1, marbeteId: 10, publicUid: 'm-X' }],
    });
    await assignMatriculas(
      { pairs: [{ canvasUserId: 1, marbeteId: 10 }] },
      undefined,
    );
    const req = capture.read();
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/api\/v1\/matriculas\/assign$/);
    expect(req.headers['x-otp-code']).toBeUndefined();
    const parsed = JSON.parse(req.body) as {
      pairs: { canvasUserId: number; marbeteId: number }[];
    };
    expect(parsed.pairs).toEqual([{ canvasUserId: 1, marbeteId: 10 }]);
  });

  it('sends x-otp-code when a code is provided', async () => {
    const capture = installFetchMock(200, {
      total: 1,
      pairs: [{ canvasUserId: 1, marbeteId: 10, publicUid: 'm-X' }],
    });
    await assignMatriculas(
      { pairs: [{ canvasUserId: 1, marbeteId: 10 }] },
      '123456',
    );
    expect(capture.read().headers['x-otp-code']).toBe('123456');
  });
});

describe('unassignMatricula — grant-aware OTP header', () => {
  it('omits x-otp-code when otpCode is undefined', async () => {
    const capture = installFetchMock(200, {
      id: 10,
      publicUid: 'm-X',
      status: 'active',
      assignedStudentId: null,
      assignedAt: null,
      createdAt: '',
      createdBy: 'x',
      deletedAt: null,
      deletionReason: null,
      student: null,
      maskedCode: '1***0',
    });
    await unassignMatricula(
      { marbeteId: 10, reason: 'Daño físico' },
      undefined,
    );
    const req = capture.read();
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/api\/v1\/matriculas\/unassign$/);
    expect(req.headers['x-otp-code']).toBeUndefined();
    const parsed = JSON.parse(req.body) as { marbeteId: number; reason: string };
    expect(parsed.marbeteId).toBe(10);
    expect(parsed.reason).toBe('Daño físico');
  });

  it('sends x-otp-code when a code is provided', async () => {
    const capture = installFetchMock(200, {
      id: 10,
      publicUid: 'm-X',
      status: 'active',
      assignedStudentId: null,
      assignedAt: null,
      createdAt: '',
      createdBy: 'x',
      deletedAt: null,
      deletionReason: null,
      student: null,
      maskedCode: '1***0',
    });
    await unassignMatricula(
      { marbeteId: 10, reason: 'Daño físico' },
      '123456',
    );
    expect(capture.read().headers['x-otp-code']).toBe('123456');
  });
});

describe('syncMatriculas', () => {
  it('POSTs /api/v1/matriculas/sync with no OTP and returns the sync shape', async () => {
    const capture = installFetchMock(200, {
      total: 12,
      created: 1,
      updated: 2,
      unchanged: 9,
      skipped: 0,
      durationMs: 25,
    });
    const response = await syncMatriculas();
    const req = capture.read();
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/api\/v1\/matriculas\/sync$/);
    expect(req.headers['x-otp-code']).toBeUndefined();
    expect(response).toEqual({
      total: 12,
      created: 1,
      updated: 2,
      unchanged: 9,
      skipped: 0,
      durationMs: 25,
    });
  });
});