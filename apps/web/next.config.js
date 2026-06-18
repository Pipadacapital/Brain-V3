/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile workspace TS packages that ship raw source (main: src/index.ts).
  // @brain/pixel-sdk is an ESM package whose barrel re-exports use .js extensions
  // (export … from './capture.js') while the files on disk are .ts — without this,
  // `next build` (webpack) fails: "Module not found: Can't resolve './capture.js'".
  // `next dev` tolerated it; the production build did not.
  transpilePackages: ['@brain/pixel-sdk'],

  // Resolve TS ESM .js-extension imports to their .ts sources (the companion to
  // transpilePackages — transpilePackages alone does NOT fix the .js→.ts resolution).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  // Web app talks ONLY to the frontend-api BFF (ADR-011).
  // BFF base URL is environment-specific; in dev, it proxies to apps/core.
  async rewrites() {
    return [
      {
        source: '/api/bff/:path*',
        destination: `${process.env.BFF_BASE_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
      // Direct core API routes (backfill trigger + progress — not BFF-wrapped).
      // POST /api/v1/connectors/:id/backfill and GET /api/v1/connectors/:id/jobs
      // live on core directly (ADR-BF-3/4); the web app proxies them transparently.
      {
        source: '/api/v1/:path*',
        destination: `${process.env.CORE_API_URL ?? 'http://localhost:3001'}/api/v1/:path*`,
      },
    ];
  },
  // Strict mode for catching side effects in dev
  reactStrictMode: true,
};

module.exports = nextConfig;
