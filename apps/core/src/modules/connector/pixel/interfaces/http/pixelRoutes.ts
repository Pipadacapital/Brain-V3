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

/** Default snippet builder — used by the routes. Can be swapped in tests. */
export function buildDefaultSnippet(
  installToken: string,
  brandId: string,
  ingestBaseUrl: string,
): string {
  return `<!-- Brain Pixel (M1 verification tag) -->
<script>
  window.__brain = { install_token: '${installToken}', brand_id: '${brandId}' };
</script>
<script src="${ingestBaseUrl}/pixel.js" defer></script>`;
}
