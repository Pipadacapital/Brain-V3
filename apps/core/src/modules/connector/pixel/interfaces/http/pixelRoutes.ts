/**
 * pixelRoutes — Fastify route handlers for pixel installation endpoints.
 *
 * Endpoints (from §5.1):
 *   GET  /api/v1/pixel/installation  → returns snippet + install_token (member)
 *   POST /api/v1/pixel/verify        → real HTTP HEAD/GET presence check → writes status (manager+)
 *   GET  /api/v1/pixel/health        → returns pixel_status (member)
 *
 * Access control: validateSession + rbacGuard preHandlers are wired at mount time
 * by the module bootstrapper. Route handlers assume brandId is available via getBrandId.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { GetOrCreatePixelInstallationCommand } from '../../application/commands/GetOrCreatePixelInstallationCommand.js';
import type { VerifyPixelCommand } from '../../application/commands/VerifyPixelCommand.js';
import type { GetPixelHealthQuery } from '../../application/queries/GetPixelHealthQuery.js';
import { PixelInstallationNotFoundError } from '../../application/commands/VerifyPixelCommand.js';
import type { PixelInstallation } from '../../domain/entities/PixelInstallation.js';
import {
  InstallPixelError,
  type InstallPixelCommand,
} from '../../../sources/storefront/shopify/application/commands/InstallPixelCommand.js';
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

export interface PixelRouteDeps {
  getOrCreateInstallation: GetOrCreatePixelInstallationCommand;
  verifyPixel: VerifyPixelCommand;
  getHealth: GetPixelHealthQuery;
  getBrandId: (req: FastifyRequest) => string;
  /** Base URL for the pixel ingest endpoint (used in snippet HTML). */
  ingestBaseUrl: string;
  /** Helper to build a PixelInstallation domain entity (for snippet generation). */
  buildSnippet: (installToken: string, brandId: string, ingestBaseUrl: string) => string;
  /** Production install path: auto-inject onto the connected Shopify storefront (optional). */
  installPixel?: InstallPixelCommand;
}

export function registerPixelRoutes(fastify: FastifyInstance, deps: PixelRouteDeps): void {
  const { getOrCreateInstallation, verifyPixel, getHealth, getBrandId } = deps;

  // ── GET /api/v1/pixel/installation ────────────────────────────────────────
  // Returns the pixel snippet and install_token. Creates record on first call (idempotent).
  fastify.get(
    '/api/v1/pixel/installation',
    async (
      req: FastifyRequest<{ Querystring: { target_host?: string } }>,
      reply: FastifyReply,
    ) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? crypto.randomUUID();
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) ?? crypto.randomUUID();

      const targetHost = req.query.target_host ?? '';
      if (!targetHost) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'MISSING_TARGET_HOST', message: 'target_host query parameter is required' },
        });
      }

      const result = await getOrCreateInstallation.execute({
        brandId,
        targetHost,
        idempotencyKey,
      });

      const snippet = deps.buildSnippet(result.installToken, brandId, deps.ingestBaseUrl);

      return reply.code(200).send({
        request_id: requestId,
        data: {
          installation_id: result.installationId,
          install_token: result.installToken,
          target_host: result.targetHost,
          snippet_html: snippet,
          is_new: result.isNew,
        },
      });
    },
  );

  // ── POST /api/v1/pixel/verify ─────────────────────────────────────────────
  // Performs a REAL HTTP check of the target_host for the pixel tag.
  // Writes pixel_status with the actual result (not simulated).
  fastify.post(
    '/api/v1/pixel/verify',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? crypto.randomUUID();
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) ?? crypto.randomUUID();

      try {
        const result = await verifyPixel.execute({ brandId, idempotencyKey });

        return reply.code(200).send({
          request_id: requestId,
          data: {
            verified: result.verified,
            state: result.state,
            message: result.message,
          },
        });
      } catch (err) {
        if (err instanceof PixelInstallationNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'PIXEL_NOT_INSTALLED', message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── POST /api/v1/pixel/install/shopify ────────────────────────────────────
  // Production install path: auto-inject the pixel onto the connected Shopify storefront via the
  // Admin API (ScriptTag) and flip installed_at — no manual paste. Idempotent.
  if (deps.installPixel) {
    const installPixel = deps.installPixel;
    fastify.post(
      '/api/v1/pixel/install/shopify',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const brandId = getBrandId(req);
        const requestId = (req.id as string) ?? crypto.randomUUID();
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) ?? crypto.randomUUID();

        try {
          const result = await installPixel.execute({ brandId, idempotencyKey });
          return reply.code(200).send({
            request_id: requestId,
            data: {
              installed: result.installed,
              provider: result.provider,
              ref: result.ref,
              install_token: result.installToken,
              src: result.src,
              already_present: result.alreadyPresent,
            },
          });
        } catch (err) {
          if (err instanceof InstallPixelError) {
            // STOREFRONT_NOT_CONNECTED → 409 (precondition); reconnect cases → 409 with actionable code.
            return reply.code(409).send({
              request_id: requestId,
              error: { code: err.code, message: err.message },
            });
          }
          throw err;
        }
      },
    );
  }

  // ── GET /api/v1/pixel/health ──────────────────────────────────────────────
  // Returns pixel_status for the dashboard "Data Status" widget (§6.4).
  // Source: Postgres only (pixel_installation + pixel_status). Never StarRocks.
  fastify.get(
    '/api/v1/pixel/health',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? crypto.randomUUID();

      const health = await getHealth.execute(brandId);

      return reply.code(200).send({
        request_id: requestId,
        data: health,
      });
    },
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
