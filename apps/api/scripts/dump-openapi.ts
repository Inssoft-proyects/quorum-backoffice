/**
 * openapi:dump — write the generated OpenAPI 3 document to
 * `apps/api/docs/openapi/mfa.openapi.generated.yaml` so it can
 * be diffed against the hand-authored
 * `apps/api/docs/openapi/mfa.openapi.yaml`.
 *
 * Run via:
 *   npm run openapi:dump --workspace @quorum-backoffice/api
 *
 * The output path is intentionally kept separate from the
 * hand-authored YAML so the drift check is explicit: a
 * reviewer can `diff` the two files and decide whether the
 * drift is acceptable. The static spec stays the source of
 * truth for production deployment until issue #9 closes
 * (the hand-authored spec is then retired in favor of the
 * generated one).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  API_PORT: '3099',
  API_HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:65535/test',
  REDIS_URL: 'redis://127.0.0.1:65535',
  OTP_SERVICE_URL: 'http://127.0.0.1:65535',
  OTP_SERVICE_TOKEN: 'test-otp-token-1234567890',
  CANVAS_PORTAL_API_URL: 'http://127.0.0.1:65535',
  CANVAS_PORTAL_API_TOKEN: 'test-canvas-token-1234567890',
  SESSION_SECRET: 'a'.repeat(64),
  SESSION_TTL_SECONDS: '3600',
};

async function main(): Promise<void> {
  const app = await buildApp({ config: TEST_ENV });
  try {
    await app.ready();
    // `app.swagger()` returns the OpenAPI 3 document; @fastify/swagger
    // also serves the YAML at `/docs/yaml` and the JSON at
    // `/docs/json`. We pull the object directly to keep the script
    // dependency-free.
    const doc = (
      app as unknown as { swagger: () => Record<string, unknown> }
    ).swagger();
    // Hand-roll a minimal YAML writer so the script doesn't pull in
    // a YAML serializer. The output is human-diffable and the
    // hand-authored `mfa.openapi.yaml` is itself minimal.
    const yaml = toYaml(doc as unknown as YamlValue);
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const outPath = path.resolve(__dirname, '..', 'docs', 'openapi', 'mfa.openapi.generated.yaml');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, yaml, 'utf8');
    // eslint-disable-next-line no-console
    console.warn(`wrote ${outPath} (${yaml.length} bytes)`);
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// Tiny YAML serializer (subset good enough for OpenAPI 3.1 docs)
// ---------------------------------------------------------------------------
//
// Supports the types that come out of `app.swagger()`: objects, arrays,
// strings, numbers, booleans, null. Strings are emitted as block scalars
// (no JSON-style escaping needed; the openapi doc is our own output so
// the chars are predictable). This avoids pulling in `js-yaml` for a
// one-off dump script.

type YamlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | YamlValue[]
  | { [k: string]: YamlValue };

function toYaml(value: YamlValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value === '') return '""';
    // Quote if the value contains characters that have YAML meaning
    // (`#`, `:`, leading `-`, leading `?`, etc.). Otherwise emit raw.
    if (/[:#\-?\n\t,&*!|>'"%@`{}\[\]"]/.test(value) || /^\s|\s$/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines: string[] = [];
    for (const item of value) {
      const inner = toYaml(item, indent + 1);
      if (typeof item === 'object' && item !== null) {
        lines.push(`${pad}- ${inner.startsWith('  ') ? '' : ''}${inner.replace(/^  /, '')}`);
      } else {
        lines.push(`${pad}- ${inner}`);
      }
    }
    return '\n' + lines.join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as { [k: string]: YamlValue });
    if (entries.length === 0) return '{}';
    const lines: string[] = [];
    for (const [k, v] of entries) {
      if (v === undefined) continue;
      if (typeof v === 'object' && v !== null) {
        const inner = toYaml(v, indent + 1);
        // Empty object / array shortcut
        if (inner === '{}' || inner === '[]' || inner === 'null') {
          lines.push(`${pad}${k}: ${inner}`);
        } else {
          lines.push(`${pad}${k}:`);
          lines.push(inner);
        }
      } else {
        lines.push(`${pad}${k}: ${toYaml(v, indent + 1)}`);
      }
    }
    return lines.join('\n');
  }
  return 'null';
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('openapi:dump failed:', err);
  process.exit(1);
});
