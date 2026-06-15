/**
 * shopifyConnectorRoutes — Fastify route handlers for Shopify OAuth + connector endpoints.
 *
 * Endpoints (from §5.1):
 *   GET  /api/v1/connectors                   → list connectors (member)
 *   GET  /api/v1/connectors/shopify/install   → returns install URL + sets state nonce (manager+)
 *   GET  /api/v1/connectors/shopify/callback  → HMAC-first OAuth callback (public — Shopify-called)
 *   GET  /api/v1/connectors/:id/status        → real sync status (member)
 *   DELETE /api/v1/connectors/:id            → disconnect (manager+)
 *
 * NN-4: callback handler validates HMAC as the ABSOLUTE FIRST operation.
 * The route itself is public (Shopify calls it) but HMAC replaces auth on this route.
 *
 * Access control note: validateSession + rbacGuard are expected to be registered
 * as preHandlers by the module that mounts these routes (Track 1 workspace-access
 * provides these; Track 2 calls them via the shared security module). Stubs are
 * used here; real guards are wired at mount time.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { InitiateOAuthCommand } from '../../application/commands/InitiateOAuthCommand.js';
import type { HandleOAuthCallbackCommand } from '../../application/commands/HandleOAuthCallbackCommand.js';
import type { DisconnectCommand } from '../../application/commands/DisconnectCommand.js';
import type { GetConnectorStatusQuery } from '../../application/queries/GetConnectorStatusQuery.js';
import {
  HmacValidationError,
  StateNonceError,
  ShopDomainError,
} from '../../application/commands/HandleOAuthCallbackCommand.js';
import { ConnectorNotFoundError } from '../../application/commands/DisconnectCommand.js';

export interface ConnectorRouteDeps {
  initiateOAuth: InitiateOAuthCommand;
  handleCallback: HandleOAuthCallbackCommand;
  disconnect: DisconnectCommand;
  getStatus: GetConnectorStatusQuery;
  /** Extracts brand_id from the authenticated JWT/session. Called per-request. */
  getBrandId: (req: FastifyRequest) => string;
  /** Public callback URL for Shopify redirect (C5: must be staging/prod domain). */
  shopifyCallbackUrl: string;
}

export function registerShopifyConnectorRoutes(
  fastify: FastifyInstance,
  deps: ConnectorRouteDeps,
): void {
  const { initiateOAuth, handleCallback, disconnect, getStatus, getBrandId } = deps;

  // ── GET /api/v1/connectors ─────────────────────────────────────────────────
  // Returns all connector statuses. Meta/Google = coming_soon flags only (no backend).
  fastify.get(
    '/api/v1/connectors',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const status = await getStatus.execute(brandId);
      return reply.code(200).send({
        request_id: (req.id as string) ?? crypto.randomUUID(),
        data: status,
      });
    },
  );

  // ── GET /api/v1/connectors/shopify/install ─────────────────────────────────
  // Returns Shopify OAuth install URL + stores state nonce (NN-4).
  // Role: manager+ (wired by rbacGuard preHandler at mount).
  fastify.get(
    '/api/v1/connectors/shopify/install',
    async (req: FastifyRequest<{ Querystring: { shop: string } }>, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const shopDomain = req.query.shop;

      if (!shopDomain) {
        return reply.code(400).send({
          request_id: (req.id as string) ?? crypto.randomUUID(),
          error: { code: 'MISSING_SHOP_PARAM', message: 'shop query parameter is required' },
        });
      }

      const result = await initiateOAuth.execute({
        brandId,
        shopDomain,
        callbackUrl: deps.shopifyCallbackUrl,
      });

      return reply.code(200).send({
        request_id: (req.id as string) ?? crypto.randomUUID(),
        data: { install_url: result.installUrl },
      });
    },
  );

  // ── GET /api/v1/connectors/shopify/callback ────────────────────────────────
  // PUBLIC route — Shopify calls this. HMAC validation is the absolute first op (NN-4).
  // The Idempotency-Key is synthesized from the state nonce (deterministic re-try safe).
  //
  // MED-CALLBACK-01 FIX: brand_id is NO LONGER read from the query string.
  // brandId is derived server-side inside HandleOAuthCallbackCommand by consuming
  // the state nonce record that had brandId bound into it at install time.
  // The query's `state` param is the only lookup key needed here.
  fastify.get(
    '/api/v1/connectors/shopify/callback',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const requestId = (req.id as string) ?? crypto.randomUUID();

      // Synthesize idempotency key from state nonce (deterministic, replay-safe).
      // brand_id is intentionally NOT read from the query — it comes from the
      // server-side state record inside HandleOAuthCallbackCommand (MED-CALLBACK-01).
      const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
      const idempotencyKey = `shopify-oauth-${state}`;

      try {
        const result = await handleCallback.execute({
          query,
          idempotencyKey,
        });

        return reply.code(200).send({
          request_id: requestId,
          data: {
            connector_instance_id: result.connectorInstanceId,
            shop_domain: result.shopDomain,
            status: result.status,
            // secret_ref omitted from API response (I-S09)
          },
        });
      } catch (err) {
        if (err instanceof HmacValidationError) {
          return reply.code(401).send({
            request_id: requestId,
            error: { code: 'HMAC_INVALID', message: 'Request authentication failed' },
          });
        }
        if (err instanceof StateNonceError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'STATE_INVALID', message: 'State parameter is invalid or expired' },
          });
        }
        if (err instanceof ShopDomainError) {
          return reply.code(400).send({
            request_id: requestId,
            error: { code: 'SHOP_DOMAIN_INVALID', message: err.message },
          });
        }
        throw err; // Let Fastify's global error handler deal with unexpected errors
      }
    },
  );

  // ── GET /api/v1/connectors/:id/status ─────────────────────────────────────
  // Real sync status from connector_sync_status (never simulated).
  fastify.get(
    '/api/v1/connectors/:id/status',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const status = await getStatus.execute(brandId);
      return reply.code(200).send({
        request_id: (req.id as string) ?? crypto.randomUUID(),
        data: status.shopify,
      });
    },
  );

  // ── DELETE /api/v1/connectors/:id ─────────────────────────────────────────
  // Disconnect. Role: manager+ (wired by rbacGuard preHandler at mount).
  fastify.delete(
    '/api/v1/connectors/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const brandId = getBrandId(req);
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) ?? crypto.randomUUID();
      const requestId = (req.id as string) ?? crypto.randomUUID();

      try {
        await disconnect.execute({
          connectorInstanceId: req.params.id,
          brandId,
          idempotencyKey,
        });
        return reply.code(200).send({ request_id: requestId, data: { disconnected: true } });
      } catch (err) {
        if (err instanceof ConnectorNotFoundError) {
          return reply.code(404).send({
            request_id: requestId,
            error: { code: 'CONNECTOR_NOT_FOUND', message: err.message },
          });
        }
        throw err;
      }
    },
  );
}
