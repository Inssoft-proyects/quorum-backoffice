/**
 * Local-only OTP provider for development and Playwright runs.
 *
 * Accepts the API's HMAC contract and a deterministic code (123456).
 * Unlike the real provider, the development code can be reused so a local
 * session and subsequent OTP-protected actions work without an issuer UI.
 *
 * Run via: node --env-file=apps/api/.env node_modules/tsx/dist/cli.mjs
 *          apps/api/scripts/mock-otp-service.ts
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env['MOCK_OTP_PORT'] ?? 18080);
const HOST = '127.0.0.1';
const CODE = '123456';
const SERVICE_NAME = process.env['OTP_SERVICE_NAME'] ?? 'quorum-backoffice';
const SERVICE_TOKEN = process.env['OTP_SERVICE_TOKEN'];

if (!SERVICE_TOKEN) throw new Error('OTP_SERVICE_TOKEN is required');

function send(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function hasValidSignature(header: string | undefined, body: string): boolean {
  if (!header) return false;
  const match = /^HMAC ([\w.-]+) (\d+) ([a-f0-9]{64})$/.exec(header);
  if (!match || match[1] !== SERVICE_NAME) return false;

  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 60) {
    return false;
  }

  const expected = createHmac('sha256', SERVICE_TOKEN!)
    .update(`${match[2]}.${body}`)
    .digest();
  const received = Buffer.from(match[3], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    send(res, 200, { status: 'ok' });
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += String(chunk); });
  req.on('end', () => {
    if (!hasValidSignature(req.headers.authorization, body)) {
      send(res, 401, { error: { code: 'unauthorized' } });
      return;
    }

    let payload: { subject?: unknown; scope?: unknown; token?: unknown };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      send(res, 400, { error: { code: 'invalid_body' } });
      return;
    }
    if (typeof payload.subject !== 'string' || typeof payload.scope !== 'string' ||
        !payload.subject.trim() || !payload.scope.trim()) {
      send(res, 400, { error: { code: 'invalid_body' } });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/otps') {
      send(res, 201, {
        id: 'local-mock-otp',
        token: CODE,
        subject: payload.subject,
        scope: payload.scope,
        ttl_seconds: 300,
        attempts_remaining: 5,
        prefix: CODE.slice(0, 3),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/otps/verify') {
      if (payload.token !== CODE) {
        send(res, 409, { error: { code: 'verify_rejected' } });
        return;
      }
      send(res, 200, {
        valid: true,
        otp_id: 'local-mock-otp',
        consumed_at: new Date().toISOString(),
      });
      return;
    }
    send(res, 404, { error: { code: 'not_found' } });
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-otp] listening on ${HOST}:${PORT}, development code=${CODE}`);
});
