import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  basePath: '/backoffice', // ← NEW (WU13): mount backoffice under /backoffice/
  env: {
    NEXT_PUBLIC_API_URL: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3100',
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
