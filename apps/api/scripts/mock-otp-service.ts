/**
 * Mock OTP service for local Playwright runs.
 *
 * Listens on :18080 and responds to the quorum-otp endpoints the backoffice
 * uses. Issues a deterministic code `123456` so tests can paste it into
 * the OtpInput; verify accepts that code (and rejects anything else).
 *
 * Run via: tsx apps/api/scripts/mock-otp-service.ts (development only).
 */
import http from 'node:http';

const PORT = Number(process.env['MOCK_OTP_PORT'] ?? 18080);
const CODE = '123456';

const issued = new Set<string>();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += String(c)));
  req.on('end', () => {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ')) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/otps') {
      const parsed = JSON.parse(body) as { subject: string; scope: string };
      issued.add(`${parsed.scope}:${parsed.subject}`);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'mock-otp-id',
          token: CODE,
          subject: parsed.subject,
          scope: parsed.scope,
          ttl_seconds: 300,
          attempts_remaining: 5,
          prefix: CODE.slice(0, 3),
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/otps/verify') {
      const parsed = JSON.parse(body) as { subject: string; scope: string; code: string };
      const ok = parsed.code === CODE && issued.has(`${parsed.scope}:${parsed.subject}`);
      if (ok) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'mock-otp-id' }));
      } else {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid' }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-otp] listening on :${PORT}, code=${CODE}`);
});