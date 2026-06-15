/** @type {import('next').NextConfig} */
const nextConfig = {
  // Web app talks ONLY to the frontend-api BFF (ADR-011).
  // BFF base URL is environment-specific; in dev, it proxies to apps/core.
  async rewrites() {
    return [
      {
        source: '/api/bff/:path*',
        destination: `${process.env.BFF_BASE_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
    ];
  },
  // Strict mode for catching side effects in dev
  reactStrictMode: true,
};

module.exports = nextConfig;
