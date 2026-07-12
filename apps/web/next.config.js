/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace TS packages ship raw source (main: src/index.ts) and re-export with explicit
  // `.js` ESM specifiers (NodeNext) while the files on disk are `.ts`. Without this,
  // `next build` (webpack) fails to resolve those `.js` specifiers (notably @brain/pixel-sdk's
  // barrel). `next dev` tolerated it; the production build did not. transpilePackages
  // transpiles the source; extensionAlias maps `.js` → the `.ts` source.
  transpilePackages: ['@brain/pixel-sdk', '@brain/money', '@brain/contracts', '@brain/connector-core'],
  webpack: (config, { dev }) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    // Dev only: git worktrees live under <repo>/worktrees/ (per the repo layout — all
    // Brain code under one folder). Each worktree has its own node_modules, so the file
    // watcher would try to watch them all → "EMFILE: too many open files" → the dev
    // server 404s every route. Exclude worktrees/ (and node_modules/.git) from the watcher.
    if (dev) {
      const ignored = ['**/node_modules/**', '**/.git/**', '**/worktrees/**'];
      const existing = config.watchOptions?.ignored;
      config.watchOptions = {
        ...config.watchOptions,
        ignored: Array.isArray(existing) ? [...existing, ...ignored] : ignored,
      };
    }
    return config;
  },
  // Web app talks ONLY to the frontend-api BFF (ADR-011).
  // BFF base URL is environment-specific; in dev, it proxies to apps/core.
  //
  // intentional: BFF_BASE_URL / CORE_API_URL are read raw here (not via
  // @brain/config's loadWebConfig). They ARE the typed source-of-record in
  // packages/config/src/web.ts (WebEnvSchema, same names + defaults), but this
  // file is plain CommonJS evaluated by Node before Next's workspace-transpile
  // pipeline, and @brain/config ships raw ESM TypeScript (main = src/index.ts)
  // which Node cannot import here. Defaults below match WebEnvSchema exactly.
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
