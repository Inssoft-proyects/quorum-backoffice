/**
 * maquette-server.ts — minimal static HTTP server for the maquette HTML.
 *
 * The reference canon lives at
 *   diseno/maqueta_Inec/Inec/inventario-credenciales.html
 * plus its `css/` and `js/` siblings. The HTML loads CSS/JS via
 * relative paths, so the server must serve the parent `Inec/` directory
 * at the document root and bind to 127.0.0.1 (Playwright runs against
 * loopback). The server is intentionally dependency-free — we use the
 * Node `http` stdlib so the Playwright runner never has to install a
 * heavy `npx serve`-style dependency.
 *
 * Lifecycle: `start()` returns the bound base URL plus a stop handle;
 * the harness starts it once per test run (via Playwright fixtures or
 * globalSetup) and tears it down after the run. Concurrent test files
 * share the server (it is read-only + idempotent).
 *
 * The server only listens on 127.0.0.1 — it never accepts external
 * traffic and it never writes outside its own process state.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export interface MaquetteServerHandle {
  /** The base URL the server is listening on, e.g. http://127.0.0.1:3200. */
  baseUrl: string;
  /** Stops the server and releases the port. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Resolve the maquette directory.
 *
 * The harness runs from `apps/web` (Playwright's CWD), but the
 * maquette lives two directories up under `diseno/maqueta_Inec/Inec/`.
 * We resolve against `process.cwd()` and against `import.meta.url` to
 * cover both `playwright test` invocations and direct `node` runs.
 */
export function resolveMaquetteDir(): string {
  const candidates: string[] = [];
  const cwd = process.cwd();
  candidates.push(path.resolve(cwd, '../../diseno/maqueta_Inec/Inec'));
  candidates.push(path.resolve(cwd, '../diseno/maqueta_Inec/Inec'));
  // Fallback: __dirname-relative for `node helpers/maquette-server.js`.
  if (typeof __dirname === 'string') {
    candidates.push(
      path.resolve(__dirname, '../../../../diseno/maqueta_Inec/Inec'),
    );
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'inventario-credenciales.html'))) {
      return dir;
    }
  }
  throw new Error(
    `Could not locate maquette directory. Tried: ${candidates.join(', ')}`,
  );
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Resolve a URL pathname against the maquette root.
 *
 * The HTML references `css/tokens.css` and `js/credential-inventory.js`
 * relative to itself; we always serve from the `Inec/` directory.
 * Path traversal is forbidden: any request with `..` segments or an
 * absolute path is rejected with 400.
 */
function safeResolve(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded).replace(/^[\\/]+/, '');
  if (normalized.includes('..')) return null;
  const abs = path.join(root, normalized);
  if (!abs.startsWith(root)) return null;
  return abs;
}

/**
 * Start the maquette static server. Returns a handle whose `baseUrl` is
 * the loopback URL the test can navigate to, and whose `stop()` releases
 * the port. The default port is 3200 (a free port that does not collide
 * with the Playwright webServer on 3100, the OTP service on 4200, or the
 * API on 4100); pass `MAQUETTE_PORT` to override.
 *
 * The server only listens once; concurrent callers share the same handle.
 */
export async function startMaquetteServer(
  options: { port?: number; host?: string; rootDir?: string } = {},
): Promise<MaquetteServerHandle> {
  const rootDir = options.rootDir ?? resolveMaquetteDir();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? Number(process.env['MAQUETTE_PORT'] ?? 3200);

  if (!fs.existsSync(path.join(rootDir, 'inventario-credenciales.html'))) {
    throw new Error(`maquette HTML not found under ${rootDir}`);
  }

  const server = http.createServer((req, res) => {
    try {
      if (!req.url) {
        send(res, 400, 'bad request', 'text/plain');
        return;
      }
      const parsed = url.parse(req.url);
      const pathname = parsed.pathname ?? '/';
      const target = safeResolve(rootDir, pathname === '/' ? '/inventario-credenciales.html' : pathname);
      if (!target) {
        send(res, 400, 'bad path', 'text/plain');
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        send(res, 404, `not found: ${pathname}`, 'text/plain');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const mime = MIME[ext] ?? 'application/octet-stream';
      const body = fs.readFileSync(target);
      send(res, 200, body, mime);
    } catch (err) {
      send(res, 500, `error: ${(err as Error).message}`, 'text/plain');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let stopped = false;
  return {
    baseUrl: `http://${host}:${port}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}