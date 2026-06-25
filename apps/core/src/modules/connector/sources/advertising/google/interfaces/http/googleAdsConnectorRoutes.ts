/**
 * googleAdsConnectorRoutes — Fastify route handlers for the Google Ads OAuth connect flow.
 *
 * feat-ad-connectors Track 1. Mirrors metaConnectorRoutes:
 *   GET /api/v1/connectors/google_ads/install   → returns oauth_url + sets state nonce (manager+)
 *   GET /api/v1/connectors/google_ads/callback   → public; state-nonce auth; NO brandId from query
 *
 * The callback is PUBLIC (Google-called) — the state nonce IS the auth (ADR-AD-2).
 * NN-2 / I-S09: no token ever appears in a response or log.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { InitiateGoogleAdsOAuthCommand } from '../../application/commands/InitiateGoogleAdsOAuthCommand.js';
import {
  HandleGoogleAdsOAuthCallbackCommand,
  GoogleAdsStateNonceError,
  GoogleAdsOAuthError,
} from '../../application/commands/HandleGoogleAdsOAuthCallbackCommand.js';

export interface GoogleAdsConnectorRouteDeps {
  initiateOAuth: InitiateGoogleAdsOAuthCommand;
  handleCallback: HandleGoogleAdsOAuthCallbackCommand;
  getBrandId: (req: FastifyRequest) => string;
  callbackUrl: string;
  appBaseUrl: string;
  onConnected?: (brandId: string, connectorInstanceId: string) => Promise<void>;
}

export function registerGoogleAdsInstallRoute(
  fastify: FastifyInstance,
  deps: GoogleAdsConnectorRouteDeps,
): void {
  fastify.get(
    '/api/v1/connectors/google_ads/install',
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

export function registerGoogleAdsCallbackRoute(
  fastify: FastifyInstance,
  deps: GoogleAdsConnectorRouteDeps,
): void {
  fastify.get(
    '/api/v1/connectors/google_ads/callback',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, string | string[] | undefined>;
      const requestId = (req.id as string) ?? randomUUID();
      const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
      const idempotencyKey = `google_ads-oauth-${state}`;

      try {
        const result = await deps.handleCallback.execute({ query, idempotencyKey });
        if (deps.onConnected) {
          await deps.onConnected(result.brandId, result.connectorInstanceId);
        }
        req.log?.info(
          { requestId, connectorInstanceId: result.connectorInstanceId },
          'google_ads oauth callback success',
        );
        return reply.redirect(
          `${deps.appBaseUrl}/settings/connectors?connected=${encodeURIComponent('google_ads')}`,
        );
      } catch (err) {
        let code = 'unexpected';
        if (err instanceof GoogleAdsStateNonceError) code = 'state_invalid';
        else if (err instanceof GoogleAdsOAuthError) code = 'oauth_failed';
        else req.log?.error({ requestId, err }, 'google_ads oauth callback unexpected error');
        return reply.redirect(`${deps.appBaseUrl}/settings/connectors?connect_error=${code}`);
      }
    },
  );
}
