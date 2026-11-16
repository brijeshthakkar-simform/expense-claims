import type { NextConfig } from 'next';

// Build-time values only: headers() is evaluated during `next build`.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  // Docker runs the standalone server. Vercel ignores it, and a Turbopack build there can crash.
  output: process.env.VERCEL ? undefined : 'standalone',
  // Vercel rejects request bodies over 4.5 MB (413), so its build caps receipts at 4 MiB. `env`
  // inlines the value like a NEXT_PUBLIC_* variable; one set explicitly wins.
  env:
    process.env.VERCEL && !process.env.NEXT_PUBLIC_RECEIPT_MAX_BYTES
      ? { NEXT_PUBLIC_RECEIPT_MAX_BYTES: String(4 * 1024 * 1024) }
      : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  // Every screen is per-user and authorization-scoped, so nothing is safe to cache (D-01).
  cacheComponents: false,
  reactCompiler: false, // D-50
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default nextConfig;
