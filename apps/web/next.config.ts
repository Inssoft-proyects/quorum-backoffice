import type { NextConfig } from 'next';

/**
 * API base resolution.
 *
 * `NEXT_PUBLIC_API_URL` is inlined into the browser bundle at build time.
 * Leaving it unset used to default to `http://127.0.0.1:3100`, which shipped a
 * production bundle that asked the visitor's own machine for the API and was
 * blocked as cross-origin (see docs/interior-components.md). The default is now
 * the empty string: relative requests, i.e. the same origin the page was
 * served from.
 *
 * Production serves web and API under one origin (nginx proxies `/api/`), so a
 * bundle built without the variable works on any domain. An explicit absolute
 * value keeps the previous behaviour for cross-origin deployments.
 *
 * `API_INTERNAL_URL` is server-only: it is the address the Next server uses for
 * its own fetches (server components cannot call a relative URL), and the
 * destination of the local `/api` rewrite. It is read at runtime for the client
 * and at build time for the rewrite destination.
 */
const publicApiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? '';
const internalApiUrl = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:3100';

if (process.env['NODE_ENV'] === 'production' && !publicApiUrl && !process.env['API_INTERNAL_URL']) {
  // Same-origin is a valid topology, but the server-side fallback would point at
  // loopback:3100 inside the pod. Warn loudly instead of failing the build so a
  // local `next build` still works.
  console.warn(
    '[web] Neither NEXT_PUBLIC_API_URL nor API_INTERNAL_URL is set. The browser will call the ' +
      'current origin (correct behind nginx) and server-side fetches will use ' +
      'http://127.0.0.1:3100. Set API_INTERNAL_URL in the deployment to the API service address.',
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  basePath: '/backoffice', // ← NEW (WU13): mount backoffice under /backoffice/
  env: {
    NEXT_PUBLIC_API_URL: publicApiUrl,
  },
  /**
   * Local / standalone proxy for the same-origin browser calls. In production
   * nginx answers `/api/` before the request reaches Next; this rewrite makes
   * `next dev` and the standalone server work without any CORS configuration.
   */
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/api/:path*`,
        basePath: false,
      },
    ];
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
