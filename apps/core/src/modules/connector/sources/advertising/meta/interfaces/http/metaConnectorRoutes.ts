/**
 * metaConnectorRoutes — Fastify route handlers for the Meta Ads OAuth connect flow.
 *
 * feat-ad-connectors Track 1. Mirrors shopifyConnectorRoutes but for Meta:
 *   GET /api/v1/connectors/meta/install   → returns oauth_url + sets state nonce (manager+)
 *   GET /api/v1/connectors/meta/callback   → public; state-nonce auth; NO brandId from query
 *
 * The install route's guard (manager+) is applied by the mounting scope in main.ts.
 * The callback route is PUBLIC (Meta-called) — the state nonce IS the auth (ADR-AD-2).
 *
 * NN-2 / I-S09: no token ever appears in any response or log. The callback redirects the
 * browser back to the marketplace (good UX) — never returns the token/secret_ref/PII.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { InitiateMetaOAuthCommand } from '../../application/commands/InitiateMetaOAuthCommand.js';
import {
  HandleMetaOAuthCallbackCommand,
  MetaStateNonceError,
  MetaOAuthError,
} from '../../application/commands/HandleMetaOAuthCallbackCommand.js';

export interface MetaConnectorRouteDeps {
  initiateOAuth: InitiateMetaOAuthCommand;
  handleCallback: HandleMetaOAuthCallbackCommand;
  /** Extracts brand_id from the authenticated JWT/session (manager+ enforced by scope). */
  getBrandId: (req: FastifyRequest) => string;
  /** Public callback URL for Meta redirect. */
  callbackUrl: string;
  /** Marketplace UI base URL for the post-callback browser redirect. */
  appBaseUrl: string;
  /** Optional audit hook (connector.connected on success). */
  onConnected?: (brandId: string, connectorInstanceId: string) => Promise<void>;
}

/**
 * Registers the manager+ install route. Mount this inside a scope that applies the
 * session + manager-role preHandlers (mirrors the Shopify install mounting).
 */
export function registerMetaInstallRoute(
  fastify: FastifyInstance,
  deps: MetaConnectorRouteDeps,
): void {
  fastify.get(
    '/api/v1/connectors/meta/install',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = deps.getBrandId(req);
      try {
        const result = await deps.initiateOAuth.execute({
          brandId,
          callbackUrl: deps.callbackUrl,
        });
        return reply.code(200).send({
          request_id: requestId,
          data: { oauth_url: result.installUrl },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'OAUTH_NOT_CONFIGURED') {
          return reply.code(503).send({
            request_id: requestId,
            error: {
              code: 'OAUTH_NOT_CONFIGURED',
              message: "This connector isn't configured yet.",
            },
          });
        }
        throw err;
      }
    },
  );
}

/**
 * Registers the PUBLIC callback route (no session guard — state nonce is the auth).
 * Mount this directly on the app, outside the authenticated scope.
 */
export function registerMetaCallbackRoute(
  fastify: FastifyInstance,
  deps: MetaConnectorRouteDeps,
): void {
  fastify.get(
    '/api/v1/connectors/meta/callback',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const requestId = (req.id as string) ?? randomUUID();
      const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
      // I-ST04: idempotency key does NOT include brand_id (not yet known — D-1).
      const idempotencyKey = `meta-oauth-${state}`;

      try {
        const result = await deps.handleCallback.execute({ query, idempotencyKey });
        if (deps.onConnected) {
          await deps.onConnected(result.brandId, result.connectorInstanceId);
        }
        req.log?.info(
          { requestId, connectorInstanceId: result.connectorInstanceId },
          'meta oauth callback success',
        );
        return reply.redirect(
          `${deps.appBaseUrl}/settings/connectors?connected=${encodeURIComponent('meta')}`,
        );
      } catch (err) {
        let code = 'unexpected';
        if (err instanceof MetaStateNonceError) code = 'state_invalid';
        else if (err instanceof MetaOAuthError) code = 'oauth_failed';
        else req.log?.error({ requestId, err }, 'meta oauth callback unexpected error');
        return reply.redirect(`${deps.appBaseUrl}/settings/connectors?connect_error=${code}`);
      }
    },
  );
}
