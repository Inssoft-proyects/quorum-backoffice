import { createMarbete, getStudentByCanvasId, updateMarbete } from '@/lib/api-client';

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

function captureFetch(
  status: number,
  responseBody: unknown,
): { handle: { read(): CapturedRequest } } {
  const holder: { current: CapturedRequest | null } = { current: null };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    holder.current = {
      method: init?.method ?? '',
      headers,
      body: String(init?.body ?? ''),
      url: typeof input === 'string' ? input : input.toString(),
    };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    handle: {
      read(): CapturedRequest {
        if (!holder.current) throw new Error('fetch was not called');
        return holder.current;
      },
    },
  };
}

const detailResponseBody = {
  id: 1,
  publicUid: 'm-X',
  maskedCode: '1***X',
  status: 'active',
  assignedStudentId: null,
  assignedAt: null,
  createdAt: '',
  createdBy: 'x',
  deletedAt: null,
  deletionReason: null,
  student: null,
};

describe('marbetes write wrappers (WU8b2)', () => {
  it('createMarbete sends POST + x-otp-code + canvasUserId body', async () => {
    const { handle } = captureFetch(201, detailResponseBody);
    await createMarbete({ code: 'WITH-CODE-1', canvasUserId: 80001 }, '123456');
    const req = handle.read();
    expect(req.method).toBe('POST');
    expect(req.headers['x-otp-code']).toBe('123456');
    expect(req.url).toMatch(/api\/v1\/marbetes$/);
    const parsed = JSON.parse(req.body) as { code: string; canvasUserId: number };
    expect(parsed.code).toBe('WITH-CODE-1');
    expect(parsed.canvasUserId).toBe(80001);
  });

  it('updateMarbete sends PATCH + x-otp-code + null canvasUserId to unassign', async () => {
    const { handle } = captureFetch(200, detailResponseBody);
    await updateMarbete(1, { canvasUserId: null }, '123456');
    const req = handle.read();
    expect(req.method).toBe('PATCH');
    expect(req.headers['x-otp-code']).toBe('123456');
    expect(req.url).toMatch(/api\/v1\/marbetes\/1$/);
    const parsed = JSON.parse(req.body) as { canvasUserId: null };
    expect(parsed.canvasUserId).toBeNull();
  });

  it('getStudentByCanvasId returns student on 200, throws ApiError on 404', async () => {
    captureFetch(200, {
      id: 1,
      canvasUserId: 80001,
      fullName: 'Ada',
      email: 'a@b.c',
      isActive: true,
    });
    await expect(getStudentByCanvasId(80001)).resolves.toEqual({
      id: 1,
      canvasUserId: 80001,
      fullName: 'Ada',
      email: 'a@b.c',
      isActive: true,
    });

    captureFetch(404, { code: 'not_found', message: 'no' });
    await expect(getStudentByCanvasId(99999)).rejects.toMatchObject({ status: 404 });
  });
});