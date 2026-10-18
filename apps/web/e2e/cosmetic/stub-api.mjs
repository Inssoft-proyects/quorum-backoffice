/**
 * Deterministic stub of the BackOffice API for the cosmetic browser smoke.
 *
 * The smoke suite must prove the login form, the auth hand-off and the new
 * components work in a real browser WITHOUT touching a real environment:
 * no database, no OTP issuer, no credentials. This server answers the exact
 * shapes the web app reads (see packages/shared/src/dto/*) and, unlike a
 * `page.route` interception, it also serves the Node-side fetches that the
 * Next server components perform.
 *
 * CORS is answered the way production does it: the origin is echoed,
 * credentials are allowed, and the login POST is preceded by a 204
 * preflight. That is what makes the browser accept the session cookie from
 * a different port, and it is also the control for the failure the operator
 * saw (missing/incorrect CORS origin => the browser blocks the POST).
 *
 * Port: STUB_API_PORT (default 3211).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_API_PORT ?? 3211);

const USER = {
  id: 1,
  email: 'admin@quorum.local',
  username: 'admin',
  role: 'admin',
};

const SESSION_COOKIE = 'sid';
/**
 * Only this origin is allowed, the way a production allowlist behaves. A
 * request from any other origin (for example `localhost` while the build
 * points at `127.0.0.1`) gets no CORS headers and the browser blocks it —
 * that is the operator's symptom, reproduced on purpose.
 */
const ALLOWED_ORIGIN = process.env.STUB_ALLOWED_ORIGIN ?? 'http://127.0.0.1:3210';
const SESSION_VALUE = 'cosmetic-smoke-session';
const VALID_OTP = 'ABC123';

const nowIso = new Date('2026-10-18T00:00:00.000Z').toISOString();

function marbete(index) {
  return {
    id: index + 1,
    publicUid: `m-${String(index + 1).padStart(6, '0')}`,
    status: index % 3 === 0 ? 'assigned' : 'active',
    assignedStudentId: index % 3 === 0 ? 100 + index : null,
    assignedAt: index % 3 === 0 ? nowIso : null,
    createdAt: nowIso,
    createdBy: 'admin',
    deletedAt: null,
    deletionReason: null,
    maskedCode: `V***${String(index + 1).padStart(2, '0')}`,
    student:
      index % 3 === 0
        ? {
            id: 100 + index,
            canvasUserId: 9000 + index,
            sisId: `SIS-${index}`,
            fullName: `Estudiante ${index}`,
            email: `estudiante${index}@inecuni.com`,
          }
        : null,
  };
}

const MARBETES = Array.from({ length: 95 }, (_, i) => marbete(i));

const DISPOSITIVOS = [
  {
    id: 1,
    serialNumber: 'SN-AAAA-0001',
    brand: 'Apple',
    model: 'iPad Pro',
    status: 'active',
    createdAt: nowIso,
    createdBy: 'admin',
    revokedAt: null,
    revokedReason: null,
  },
  {
    id: 2,
    serialNumber: 'SN-BBBB-0002',
    brand: 'Samsung',
    model: 'Galaxy Tab',
    status: 'revoked',
    createdAt: nowIso,
    createdBy: 'admin',
    revokedAt: nowIso,
    revokedReason: 'Fin de ciclo',
  },
];

const MATRICULAS = Array.from({ length: 24 }, (_, i) => ({
  canvasUserId: 9000 + i,
  fullName: i % 5 === 0 ? null : `Estudiante ${i}`,
  email: `estudiante${i}@inecuni.com`,
  sisId: `SIS-${String(i).padStart(4, '0')}`,
  isActive: true,
  registeredAt: nowIso,
  marbete:
    i % 3 === 0
      ? {
          id: i + 1,
          publicUid: `m-${String(i + 1).padStart(6, '0')}`,
          maskedCode: `V***${String(i + 1).padStart(2, '0')}`,
          status: 'active',
          assignedAt: nowIso,
          assignedBy: 'admin',
        }
      : null,
}));

const AUDIT = [
  {
    id: 1,
    occurredAt: nowIso,
    actorId: 'admin',
    actorEmail: 'admin@quorum.local',
    action: 'marbete.create',
    entityType: 'marbete',
    entityId: '1',
    beforeJson: null,
    afterJson: { code: 'V***01' },
    otpId: 'otp-1',
    ip: '127.0.0.1',
    userAgent: 'playwright',
  },
];

function cors(req) {
  const origin = req.headers.origin;
  if (!origin) return { vary: 'origin' };
  if (origin !== ALLOWED_ORIGIN) return { vary: 'origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-otp-code',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function send(req, res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...cors(req),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function hasSession(req) {
  return (req.headers.cookie ?? '').includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    res.end();
    return;
  }

  if (path === '/api/v1/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.username || body.otp !== VALID_OTP) {
      send(req, res, 401, {
        code: 'invalid_credentials',
        message: 'invalid username or otp',
      });
      return;
    }
    send(
      req,
      res,
      200,
      { user: USER },
      {
        'set-cookie': `${SESSION_COOKIE}=${SESSION_VALUE}; Path=/; SameSite=Lax; HttpOnly`,
      },
    );
    return;
  }

  if (path === '/api/v1/auth/me' && req.method === 'GET') {
    if (!hasSession(req)) {
      send(req, res, 401, { code: 'unauthorized', message: 'no session' });
      return;
    }
    send(req, res, 200, USER);
    return;
  }

  if (path === '/api/v1/auth/logout' && req.method === 'POST') {
    send(
      req,
      res,
      200,
      {},
      {
        'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
      },
    );
    return;
  }

  // Every /api/v1 read below requires the same session the server components
  // forward, so a missing cookie surfaces as a real auth failure instead of a
  // silently empty page.
  if (path.startsWith('/api/v1/') && !hasSession(req)) {
    send(req, res, 401, { code: 'unauthorized', message: 'no session' });
    return;
  }

  if (path === '/api/v1/marbetes/counters') {
    send(req, res, 200, { ok: 32, ko: 63 });
    return;
  }

  if (path === '/api/v1/marbetes/otp-grant') {
    send(req, res, 200, { active: false, expiresAt: null });
    return;
  }

  if (path === '/api/v1/marbetes') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    send(req, res, 200, {
      total: MARBETES.length,
      limit,
      offset,
      items: MARBETES.slice(offset, offset + limit),
    });
    return;
  }

  if (path === '/api/v1/matriculas/counters') {
    send(req, res, 200, {
      total: MATRICULAS.length,
      assigned: MATRICULAS.filter((m) => m.marbete).length,
      unassigned: MATRICULAS.filter((m) => !m.marbete).length,
      availableMarbetes: 60,
    });
    return;
  }

  if (path === '/api/v1/matriculas') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    send(req, res, 200, {
      total: MATRICULAS.length,
      limit,
      offset,
      items: MATRICULAS.slice(offset, offset + limit),
    });
    return;
  }

  if (path === '/api/v1/dispositivos') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    send(req, res, 200, {
      total: DISPOSITIVOS.length,
      limit,
      offset,
      items: DISPOSITIVOS.slice(offset, offset + limit),
    });
    return;
  }

  if (path === '/api/v1/audit') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    send(req, res, 200, {
      total: AUDIT.length,
      limit,
      offset,
      items: AUDIT.slice(offset, offset + limit),
    });
    return;
  }

  send(req, res, 404, { code: 'not_found', message: `no stub for ${req.method} ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub-api listening on http://127.0.0.1:${PORT}\n`);
});
