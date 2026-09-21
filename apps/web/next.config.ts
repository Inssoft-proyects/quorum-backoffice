import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://127.0.0.1:3001',
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    dirs: ['app', 'components', 'lib'],
  },
};

export default nextConfig;
