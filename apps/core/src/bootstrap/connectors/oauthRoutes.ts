/**
 * registerConnectorOAuthRoutes — OAuth dispatch table + public OAuth callback routes.
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts (the OAUTH_DISPATCH_TABLE block,
 * the ads callback routes, and the generic /oauth/callback/:type route). PUBLIC routes — the
 * state nonce / HMAC is the auth. Behavior is byte-for-byte identical to the prior inline code.
 */
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { AuditWriter } from '@brain/audit';

import { registerOAuthDispatch } from '../../modules/connector/catalog/dispatch.js';
import { HandleOAuthCallbackCommand, HmacValidationError, StateNonceError, ShopDomainError } from '../../modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.js';
import { registerMetaCallbackRoute } from '../../modules/connector/sources/advertising/meta/interfaces/http/metaConnectorRoutes.js';
import { registerGoogleAdsCallbackRoute } from '../../modules/connector/sources/advertising/google/interfaces/http/googleAdsConnectorRoutes.js';
import type { PgConnectorInstanceRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { PgConnectorSyncStatusRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import type { EmitEvent } from '../../infrastructure/events/M1EventPublisher.js';

import type { ConnectorContextConfig, SharedOAuthCommands } from './shared.js';

export interface RegisterConnectorOAuthRoutesDeps {
  config: ConnectorContextConfig;
  connectorRepo: PgConnectorInstanceRepository;
  syncStatusRepo: PgConnectorSyncStatusRepository;
  connectorSecretsManager: ISecretsManager;
  oauthStateStore: IOAuthStateStore;
  auditWriter: AuditWriter;
  emitEvent: EmitEvent;
  oauthCommands: SharedOAuthCommands;
}

export function registerConnectorOAuthRoutes(app: FastifyInstance, deps: RegisterConnectorOAuthRoutesDeps): void {
  const { config, connectorRepo, syncStatusRepo, connectorSecretsManager, oauthStateStore, auditWriter, emitEvent } = deps;
  const { initiateOAuth, initiateMetaOAuth, handleMetaCallback, initiateGoogleAdsOAuth, handleGoogleAdsCallback } = deps.oauthCommands;

  const handleCallback = new HandleOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
  );

  // Audit hook for a successful ads OAuth connect (brandId is state-derived — D-1).
  const auditAdConnected =
    (connectorType: 'meta' | 'google_ads') =>
    async (brandId: string, connectorInstanceId: string): Promise<void> => {
      await auditWriter.append({
        brand_id: brandId,
        actor_id: null,
        actor_role: 'system',
        action: 'connector.connected',
        entity_type: 'connector_instance',
        entity_id: connectorInstanceId,
        payload: { connector_type: connectorType },
        // NO secret_ref, NO token in payload (I-S02 / I-S09)
      });
    };

  // ── OAUTH_DISPATCH_TABLE registration (A3 — ADR-CM-3) ─────────────────────
  registerOAuthDispatch('shopify', {
    initiate: async ({ brandId, shopDomain, callbackUrl, clientId }) => {
      if (!shopDomain) {
        throw Object.assign(new Error('shop_domain is required for shopify OAuth'), {
          code: 'MISSING_SHOP_DOMAIN',
          statusCode: 400,
        });
      }
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl, clientId });
      return { oauth_url: result.installUrl };
    },
  });

  registerOAuthDispatch('meta', {
    initiate: async ({ brandId, clientId }) => {
      const result = await initiateMetaOAuth.execute({
        brandId,
        callbackUrl: config.metaCallbackUrl,
        clientId,
      });
      return { oauth_url: result.installUrl };
    },
  });
  registerOAuthDispatch('google_ads', {
    initiate: async ({ brandId, clientId }) => {
      const result = await initiateGoogleAdsOAuth.execute({
        brandId,
        callbackUrl: config.googleAdsCallbackUrl,
        clientId,
      });
      return { oauth_url: result.installUrl };
    },
  });

  // ── Ads OAuth callback routes (PUBLIC — state nonce is the auth, ADR-AD-2) ──
  registerMetaCallbackRoute(app, {
    initiateOAuth: initiateMetaOAuth,
    handleCallback: handleMetaCallback,
    getBrandId: () => {
      throw new Error('getBrandId is not used on the public callback route');
    },
    callbackUrl: config.metaCallbackUrl,
    appBaseUrl: config.appBaseUrl,
    onConnected: auditAdConnected('meta'),
  });
  registerGoogleAdsCallbackRoute(app, {
    initiateOAuth: initiateGoogleAdsOAuth,
    handleCallback: handleGoogleAdsCallback,
    getBrandId: () => {
      throw new Error('getBrandId is not used on the public callback route');
    },
    callbackUrl: config.googleAdsCallbackUrl,
    appBaseUrl: config.appBaseUrl,
    onConnected: auditAdConnected('google_ads'),
  });

  // ── Generic OAuth callback (ADR-CM-3 / D-1) — PUBLIC (HMAC is the auth, NN-4) ──
  app.get('/api/v1/oauth/callback/:type', async (req: FastifyRequest<{ Params: { type: string } }>, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const requestId = (req.id as string) ?? randomUUID();
    const connectorType = req.params.type;
    const state = typeof query['state'] === 'string' ? query['state'] : 'unknown';
    const idempotencyKey = `${connectorType}-oauth-${state}`;

    try {
      let result: { connectorInstanceId: string; shopDomain: string; status: string };
      if (connectorType === 'shopify') {
        const cbResult = await handleCallback.execute({ query, idempotencyKey });
        result = {
          connectorInstanceId: cbResult.connectorInstanceId,
          shopDomain: cbResult.shopDomain,
          status: cbResult.status,
        };
        await auditWriter.append({
          brand_id: cbResult.brandId,
          actor_id: null,
          actor_role: 'system',
          action: 'connector.connected',
          entity_type: 'connector_instance',
          entity_id: result.connectorInstanceId,
          payload: { connector_type: connectorType },
          // NO secret_ref, NO token in payload (I-S02/I-S09)
        });
      } else {
        return reply.redirect(`${config.appBaseUrl}/settings/connectors?connect_error=unknown_connector`);
      }

      req.log?.info({ requestId, connectorType, connectorInstanceId: result.connectorInstanceId }, 'oauth callback success');
      return reply.redirect(`${config.appBaseUrl}/settings/connectors?connected=${encodeURIComponent(connectorType)}`);
    } catch (err) {
      let code = 'unexpected';
      if (err instanceof HmacValidationError) code = 'auth_failed';
      else if (err instanceof StateNonceError) code = 'state_invalid';
      else if (err instanceof ShopDomainError) code = 'shop_invalid';
      else req.log?.error({ requestId, err }, 'oauth callback unexpected error');
      return reply.redirect(`${config.appBaseUrl}/settings/connectors?connect_error=${code}`);
    }
  });
}
