/**
 * pixelRoutes — the storefront-agnostic pixel installer routes + snippet builders.
 *
 * The core installation/verify/health endpoints are registered by the bootstrapper
 * (bootstrap/connectors/pixelRoutes.ts); this file provides the extensible installer
 * surface (registerPixelInstallerRoutes) and the shared snippet/hostname helpers.
 *
 * Access control: validateSession + rbacGuard preHandlers are wired at mount time
 * by the module bootstrapper. Route handlers assume brandId is available via getBrandId.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PixelInstallerRegistry } from '../../application/install/PixelInstaller.js';
import { buildWooCommercePluginZip, WC_PLUGIN_SLUG, pluginSourceHash } from '../../../sources/storefront/woocommerce/infrastructure/WooCommercePixelPlugin.js';

/** True iff `err` is a typed install error carrying a stable string `.code` (→ HTTP 409 precondition). */
function isCodedInstallError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

/**
 * registerPixelInstallerRoutes — the storefront-agnostic install surface, mounted inside the same
 * RBAC-gated scope as the legacy /install/shopify route. This is the EXTENSIBLE path the product
 * follows: the merchant connects a storefront first, then Brain offers exactly the install option(s)
 * for the storefront(s) that are connected (driven by each installer's isAvailable). Adding a new
 * storefront = register one PixelInstaller — these routes, and every existing installer, are untouched.
 *
 *   GET    /api/v1/pixel/installers              → install options for this brand (+ availability)
 *   POST   /api/v1/pixel/install/:provider       → run the installer for the connected storefront
 *   DELETE /api/v1/pixel/install/:provider       → remove (when the installer supports it)
 *   GET    /api/v1/pixel/woocommerce/plugin.zip  → the ready-to-upload Brain Pixel WP plugin (no secrets)
 */
export function registerPixelInstallerRoutes(
  fastify: FastifyInstance,
  deps: { registry: PixelInstallerRegistry; getBrandId: (req: FastifyRequest) => string },
): void {
  const { registry, getBrandId } = deps;

  fastify.get('/api/v1/pixel/installers', async (req: FastifyRequest, reply: FastifyReply) => {
    const brandId = getBrandId(req);
    const requestId = (req.id as string) ?? crypto.randomUUID();
    const installers = await registry.describeForBrand(brandId);
    return reply.code(200).send({ request_id: requestId, data: { installers } });
  });

  fastify.post(
    '/api/v1/pixel/install/:provider',
    async (req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? crypto.randomUUID();
      const provider = req.params.provider;
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? crypto.randomUUID();

      const installer = registry.get(provider);
      if (!installer) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'UNKNOWN_PROVIDER', message: `No pixel installer for provider "${provider}".` },
        });
      }
      try {
        const r = await installer.install({ brandId, idempotencyKey });
        return reply.code(200).send({
          request_id: requestId,
          data: {
            installed: r.installed,
            provider: r.provider,
            ref: r.ref,
            install_token: r.installToken,
            src: r.src,
            already_present: r.alreadyPresent,
            meta: r.meta ?? {},
          },
        });
      } catch (err) {
        if (isCodedInstallError(err)) {
          return reply.code(409).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  fastify.delete(
    '/api/v1/pixel/install/:provider',
    async (req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? crypto.randomUUID();
      const installer = registry.get(req.params.provider);
      if (!installer || !installer.uninstall) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'UNINSTALL_UNSUPPORTED', message: `No programmatic uninstall for "${req.params.provider}".` },
        });
      }
      try {
        const r = await installer.uninstall({ brandId });
        return reply.code(200).send({
          request_id: requestId,
          data: { removed: r.removed, provider: r.provider, already_absent: r.alreadyAbsent },
        });
      } catch (err) {
        if (isCodedInstallError(err)) {
          return reply.code(409).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // The Brain Pixel WordPress plugin — built in-memory from embedded source (always fresh, no secrets).
  fastify.get('/api/v1/pixel/woocommerce/plugin.zip', async (_req: FastifyRequest, reply: FastifyReply) => {
    const zip = buildWooCommercePluginZip();
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${WC_PLUGIN_SLUG}.zip"`)
      .header('ETag', `"${pluginSourceHash()}"`)
      .header('Cache-Control', 'public, max-age=300')
      .code(200)
      .send(zip);
  });
}

/**
 * A safe DNS hostname (label.label[.label]…), lowercase, no scheme/port/path. Used to validate a
 * brand-supplied first-party CNAME ingest host before it is ever interpolated into snippet HTML.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** True iff `host` is a syntactically valid bare hostname (injection-safe for snippet interpolation). */
export function isValidIngestHost(host: string): boolean {
  return HOSTNAME_RE.test(host.toLowerCase());
}

/**
 * Default snippet builder — used by the routes. Can be swapped in tests.
 *
 * When `customIngestHost` is a valid hostname, the snippet serves the SDK AND posts events from that
 * first-party host (https://<host>/pixel.js + window.__brain.ingest_base_url) — the SDK honours
 * ingest_base_url for its /collect target, so a brand's CNAME makes the pixel first-party end-to-end
 * (ITP/ad-blocker resilience). Otherwise it falls back to the default ingest base URL.
 */
export function buildDefaultSnippet(
  installToken: string,
  brandId: string,
  ingestBaseUrl: string,
  customIngestHost?: string | null,
): string {
  if (customIngestHost && isValidIngestHost(customIngestHost)) {
    const base = `https://${customIngestHost.toLowerCase()}`;
    return `<!-- Brain Pixel (first-party) -->
<script>
  window.__brain = { install_token: '${installToken}', brand_id: '${brandId}', ingest_base_url: '${base}' };
</script>
<script src="${base}/pixel.js" defer></script>`;
  }
  return `<!-- Brain Pixel (M1 verification tag) -->
<script>
  window.__brain = { install_token: '${installToken}', brand_id: '${brandId}' };
</script>
<script src="${ingestBaseUrl}/pixel.js" defer></script>`;
}
