#!/usr/bin/env node
/**
 * otp-probe.mjs — mint then verify an OTP against the local quorum-otp provider.
 *
 * Bundle of the `quorum-otp-triage` skill. Proves the scope binding:
 *   - same-scope verify  -> 200 {valid:true} (control)
 *   - cross-scope verify -> 409 (strict scope binding) or 200 (bypass enabled)
 *
 * Usage: node otp-probe.mjs [mintScope] [verifyScope] [subject]
 * Defaults: mintScope=self, verifyScope=login, subject=probe_<random>.
 *
 * Credentials are read from /root/qgm-otp.env via `sudo grep` and never echoed.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.env.OTP_BASE_URL ?? 'http://127.0.0.1:4200';
const ENV_PATH = process.env.OTP_ENV_PATH ?? '/root/qgm-otp.env';

function creds() {
  const raw = execFileSync('sudo', ['grep', '-E', '^OTP_SERVICE_(NAME|TOKEN)=', ENV_PATH], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const map = Object.fromEntries(
    raw
      .trim()
      .split('\n')
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  if (!map.OTP_SERVICE_NAME || !map.OTP_SERVICE_TOKEN) {
    throw new Error(`${ENV_PATH} is missing OTP_SERVICE_NAME or OTP_SERVICE_TOKEN`);
  }
  return map;
}

function authHeader(name, secret, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `HMAC ${name} ${ts} ${sig}`;
}

async function post(path, body, c) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader(c.OTP_SERVICE_NAME, c.OTP_SERVICE_TOKEN, raw),
    },
    body: raw,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const mintScope = process.argv[2] ?? 'self';
const verifyScope = process.argv[3] ?? 'login';
const subject = process.argv[4] ?? `probe_${randomBytes(3).toString('hex')}`;
const c = creds();

const issue = await post('/v1/otps', { subject, scope: mintScope }, c);
console.log(`mint   subject=${subject} scope=${mintScope} -> ${issue.status}`);
if (issue.status !== 201) {
  console.error(JSON.stringify(issue.json));
  process.exit(2);
}

const same = await post('/v1/otps/verify', { subject, scope: mintScope, token: issue.json.token }, c);
console.log(`verify same-scope  (${mintScope}) -> ${same.status} ${JSON.stringify(same.json)}`);

const issue2 = await post('/v1/otps', { subject, scope: mintScope }, c);
const cross = await post('/v1/otps/verify', { subject, scope: verifyScope, token: issue2.json.token }, c);
console.log(`verify cross-scope (${verifyScope}) -> ${cross.status} ${JSON.stringify(cross.json)}`);

const ok = same.status === 200 && (cross.status === 200 || cross.status === 409);
console.log(
  ok
    ? 'PROBE OK (cross-scope 409 = strict scope binding; 200 = bypass enabled)'
    : 'PROBE UNEXPECTED',
);
process.exit(ok ? 0 : 1);
