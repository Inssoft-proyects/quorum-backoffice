import { listAuditEntries, getAuditEntry } from '@/lib/api-client';

describe('audit api-client wrappers', () => {
  it('listAuditEntries encodes filter params in querystring', async () => {
    let lastUrl = '';
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      lastUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({ total: 0, limit: 100, offset: 0, items: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await listAuditEntries({
      entityType: 'marbete',
      action: 'marbete.create',
      actorId: 'a@b.com',
      limit: 100,
      offset: 0,
    });
    expect(lastUrl).toMatch(/entityType=marbete/);
    expect(lastUrl).toMatch(/action=marbete/);
    expect(lastUrl).toMatch(/actorId=a/);
  });

  it('getAuditEntry hits /api/v1/audit/:id', async () => {
    let lastUrl = '';
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      lastUrl = typeof input === 'string' ? input : input.toString();
      return new Response(
        JSON.stringify({
          id: 5,
          occurredAt: '',
          actorId: 'x',
          actorEmail: null,
          action: 'marbete.create',
          entityType: 'marbete',
          entityId: 'y',
          beforeJson: null,
          afterJson: null,
          otpId: null,
          ip: null,
          userAgent: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await getAuditEntry(5);
    expect(lastUrl).toMatch(/api\/v1\/audit\/5/);
    expect(result.id).toBe(5);
  });
});