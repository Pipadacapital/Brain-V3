/**
 * registerConnectorWriteRoutes — connector write routes (manager+, +requireVerifiedEmail).
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts (the manager+ write scope:
 * POST /api/v1/connectors, legacy shopify install, ads install routes, razorpay rotation,
 * and generic disconnect). Guards, response shapes, and side effects are byte-for-byte
 * identical to the prior inline registration.
 */
import { type FastifyInstance, type FastifyRequest, type preHandlerAsyncHookHandler } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { beginRlsTxn } from '@brain/db';
import type pg from 'pg';
import type { AuditWriter } from '@brain/audit';

import { RequestConnectorSyncCommand } from '../../modules/connector/sync/application/commands/RequestConnectorSyncCommand.js';
import { registerRazorpayConnectorRoutes } from '../../modules/connector/sources/payment/razorpay/interfaces/http/razorpayConnectorRoutes.js';
import { RotateWebhookSecretCommand } from '../../modules/connector/sources/payment/razorpay/application/commands/RotateWebhookSecretCommand.js';
import { getDefinition, isConnectable } from '../../modules/connector/catalog/index.js';
import { planCredentialConnect, provisionGeneratedSecrets } from '../../modules/connector/credential-schema.js';
import { getOAuthDispatch } from '../../modules/connector/catalog/dispatch.js';
import { storeBrandOAuthAppCreds, resolveBrandOAuthClientId, type OAuthProvider } from '../../modules/connector/oauth-app-creds.js';
import { ConnectorInstance as ConnectorInstanceEntity } from '@brain/connector-core';
import {
  ConnectShopifyWithCredentialsCommand,
  InvalidShopDomainError,
  ShopifyCredentialsInvalidError,
} from '../../modules/connector/sources/storefront/shopify/application/commands/ConnectShopifyWithCredentialsCommand.js';
import { StorefrontExclusivityError } from '../../modules/connector/sources/storefront/storefront-exclusivity.js';
import {
  ConnectMetaWithSystemUserTokenCommand,
  MetaSystemUserTokenInvalidError,
  MetaAdAccountAccessError,
} from '../../modules/connector/sources/advertising/meta/application/commands/ConnectMetaWithSystemUserTokenCommand.js';
import { DisconnectCommand, ConnectorNotFoundError } from '../../modules/connector/sources/storefront/shopify/application/commands/DisconnectCommand.js';
import {
  HandleGa4ConnectCommand,
  Ga4InvalidPropertyIdError,
  Ga4ServiceAccountKeyInvalidError,
  Ga4CredentialsInvalidError,
} from '../../modules/connector/sources/analytics/ga4/application/commands/HandleGa4ConnectCommand.js';
import { registerMetaInstallRoute } from '../../modules/connector/sources/advertising/meta/interfaces/http/metaConnectorRoutes.js';
import { registerGoogleAdsInstallRoute } from '../../modules/connector/sources/advertising/google/interfaces/http/googleAdsConnectorRoutes.js';
import type { PgConnectorInstanceRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { PgConnectorSyncStatusRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import { requireRole } from '../../modules/workspace-access/internal/security/rbac.js';
import { requireVerifiedEmail } from '../../modules/workspace-access/internal/security/email-verified.guard.js';
import type { AuthService } from '../../modules/workspace-access/internal/application/auth.service.js';
import type { EmitEvent } from '../../infrastructure/events/M1EventPublisher.js';

import { getBrandId, type ConnectorContextConfig, type SharedOAuthCommands } from './shared.js';

export interface RegisterConnectorWriteRoutesDeps {
  config: ConnectorContextConfig;
  rawPgPool: pg.Pool;
  connectorRepo: PgConnectorInstanceRepository;
  syncStatusRepo: PgConnectorSyncStatusRepository;
  connectorSecretsManager: ISecretsManager;
  emitEvent: EmitEvent;
  auditWriter: AuditWriter;
  authService: AuthService;
  sessionPreHandler: preHandlerAsyncHookHandler;
  oauthCommands: SharedOAuthCommands;
}

export function registerConnectorWriteRoutes(app: FastifyInstance, deps: RegisterConnectorWriteRoutesDeps): void {
  const { config, rawPgPool, connectorRepo, syncStatusRepo, connectorSecretsManager, emitEvent, auditWriter, authService, sessionPreHandler } = deps;
  const { initiateOAuth, initiateMetaOAuth, handleMetaCallback, initiateGoogleAdsOAuth, handleGoogleAdsCallback } = deps.oauthCommands;

  const disconnectCommand = new DisconnectCommand(
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    emitEvent,
  );

  // Public origin webhooks are delivered to (same host that receives the OAuth callbacks).
  let webhookOrigin = config.appBaseUrl;
  try {
    webhookOrigin = new URL(config.shopifyCallbackUrl).origin;
  } catch {
    /* fall back to appBaseUrl */
  }

  // Generic per-brand Shopify connect (custom-app credentials → client-credentials grant).
  const connectShopifyWithCredentials = new ConnectShopifyWithCredentialsCommand(
    connectorSecretsManager,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    process.env['APP_ENV'] ?? config.nodeEnv,
    webhookOrigin,
  );

  // Meta: generic per-brand system-user-token connect (credential path on the OAuth tile).
  // The brand pastes a NEVER-EXPIRING system-user token (Meta Business Settings) + optionally
  // the ad account id — no browser OAuth redirect, no ~60-day token death. Mirrors the wiring
  // in registerConnectors.ts (setAdAccountId is the same brand-scoped column UPDATE).
  const connectMetaWithSystemUserToken = new ConnectMetaWithSystemUserTokenCommand(
    connectorSecretsManager,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    async (accBrandId, connectorInstanceId, adAccountId) => {
      const client = await rawPgPool.connect();
      try {
        await beginRlsTxn(client, { correlationId: 'connector:set-ad-account', brandId: accBrandId });
        await client.query(
          `UPDATE connector_instance SET ad_account_id = $1 WHERE id = $2 AND brand_id = $3`,
          [adAccountId, connectorInstanceId, accBrandId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // Generic per-brand GA4 connect (service-account JSON key → JWT-bearer grant).
  // The property id is mirrored into connector_instance.ad_account_id — the generic repull
  // contract (ingestion-backfill/ga4-repull enumerate on that column). Same RLS write pattern
  // as the generic credential path's instanceColumnUpdate below.
  const connectGa4WithServiceAccount = new HandleGa4ConnectCommand(
    connectorSecretsManager,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    async (gaBrandId, connectorInstanceId, adAccountId) => {
      const colClient = await rawPgPool.connect();
      try {
        await beginRlsTxn(colClient, { correlationId: 'connector:ga4-set-property', brandId: gaBrandId });
        await colClient.query(
          `UPDATE connector_instance SET ad_account_id = $1 WHERE id = $2 AND brand_id = $3`,
          [adAccountId, connectorInstanceId, gaBrandId],
        );
        await colClient.query('COMMIT');
      } catch (colErr) {
        await colClient.query('ROLLBACK').catch(() => undefined);
        throw colErr;
      } finally {
        colClient.release();
      }
    },
  );

  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));
    scope.addHook('preHandler', requireVerifiedEmail(authService));

    scope.post('/api/v1/connectors', async (req: FastifyRequest<{ Body: { type?: string; shop_domain?: string; credentials?: Record<string, string> } }>, reply) => {
      const brandId = getBrandId(req);
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;
      const requestId = (req.id as string) ?? randomUUID();
      const body = req.body ?? {};
      const connectorType = body.type;

      if (!connectorType) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_CONNECTOR_TYPE', message: 'type is required' } });
      }

      const def = getDefinition(connectorType);
      if (!def) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'UNKNOWN_CONNECTOR_TYPE', message: `Unknown connector type: ${connectorType}` } });
      }

      if (!isConnectable(def)) {
        return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `${def.displayName} is not yet available for connection.` } });
      }

      // ── Meta: system-user token connect (credential dispatch on the OAuth tile) ──
      // RECOMMENDED path: when the connect body carries an access_token, connect with it
      // directly (validated via /me + optional ad-account fetch) — the token never expires,
      // so the connection never dies on the ~60-day OAuth token expiry. No access_token →
      // fall through to the browser OAuth redirect below (back-compat, BYO-app supported).
      if (connectorType === 'meta') {
        const metaCreds = body.credentials ?? {};
        const systemUserToken = (metaCreds['access_token'] ?? '').trim();
        if (systemUserToken) {
          try {
            const result = await connectMetaWithSystemUserToken.execute({
              brandId,
              accessToken: systemUserToken,
              ...(metaCreds['ad_account_id']?.trim()
                ? { adAccountId: metaCreds['ad_account_id'].trim() }
                : {}),
              idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? requestId,
            });
            await auditWriter.append({
              brand_id: brandId,
              actor_id: auth?.userId ?? null,
              actor_role: auth?.role ?? 'unknown',
              action: 'connector.connected',
              entity_type: 'connector_instance',
              entity_id: result.connectorInstanceId,
              // NEVER the token — only the connect metadata (I-S09).
              payload: {
                connector_type: 'meta',
                auth_method: 'system_user_token',
                ad_account_ids: result.adAccountIds,
              },
            });
            return reply.code(200).send({
              request_id: requestId,
              data: {
                kind: 'credential',
                connected: true,
                connector_instance_id: result.connectorInstanceId,
              },
            });
          } catch (err) {
            if (err instanceof MetaSystemUserTokenInvalidError || err instanceof MetaAdAccountAccessError) {
              return reply.code(422).send({ request_id: requestId, error: { code: err.code, message: err.message } });
            }
            throw err;
          }
        }
        // no access_token → the browser OAuth redirect below handles the connect.
      }

      if (def.connectMethod === 'oauth') {
        const dispatch = getOAuthDispatch(connectorType);
        if (!dispatch) {
          return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `OAuth not configured for ${connectorType}` } });
        }
        try {
          // Per-brand BYO-app creds (Shopify/Meta/Google): if the connect body carries client_id +
          // client_secret, store them for this brand (Secrets Manager); the client_secret is used at
          // the callback. Then resolve the client_id for the authorize URL — the brand's own app, else
          // the env app (back-compat). client_secret NEVER goes on connector_instance (NN-2) or a log.
          const provider = connectorType as OAuthProvider;
          const appCreds = body.credentials;
          if (appCreds?.['client_id'] && appCreds?.['client_secret']) {
            await storeBrandOAuthAppCreds(connectorSecretsManager, provider, brandId, {
              clientId: appCreds['client_id'],
              clientSecret: appCreds['client_secret'],
              // google_ads BYO-app: the brand's own developer token rides the same app bundle
              // (resolved at callback + persisted into each per-account bundle for the repull).
              ...(appCreds['developer_token'] ? { developerToken: appCreds['developer_token'] } : {}),
            });
          }
          const clientId = await resolveBrandOAuthClientId(connectorSecretsManager, provider, brandId);
          const { oauth_url } = await dispatch.initiate({
            brandId,
            shopDomain: body.shop_domain,
            callbackUrl: config.shopifyCallbackUrl,
            clientId,
          });
          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: `${connectorType}:${brandId}`,
            payload: { connector_type: connectorType, phase: 'oauth_initiated' },
          });
          return reply.code(200).send({ request_id: requestId, data: { kind: 'oauth', oauth_url } });
        } catch (err) {
          if ((err as { code?: string }).code === 'MISSING_SHOP_DOMAIN') {
            return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_SHOP_DOMAIN', message: (err as Error).message } });
          }
          if ((err as { code?: string }).code === 'OAUTH_NOT_CONFIGURED') {
            return reply.code(503).send({ request_id: requestId, error: { code: 'OAUTH_NOT_CONFIGURED', message: "This connector isn't configured yet. Add your app credentials and try again." } });
          }
          throw err;
        }
      }

      // ── Shopify: generic per-brand connect (custom-app credentials) ─────────────
      // The brand enters its OWN custom app's Client ID + Client Secret + store URL; the server
      // does the client-credentials exchange (24h token; refresh cron re-exchanges) — no browser
      // OAuth redirect. ENV-GATED FALLBACK: when Brain's shared app is configured
      // (SHOPIFY_CLIENT_ID) AND the brand supplied no credentials, fall back to the
      // authorization-code OAuth redirect (the pre-existing shared-app flow).
      if (connectorType === 'shopify' && def.connectMethod === 'credential') {
        const creds = body.credentials ?? {};
        const clientId = (creds['client_id'] ?? '').trim();
        const clientSecret = (creds['client_secret'] ?? '').trim();
        const shopDomainRaw = ((creds['shop_domain'] ?? body.shop_domain) ?? '').trim();

        if (!clientId || !clientSecret) {
          // Fallback is gated on the ENV (shared Brain) app ONLY — a brand's previously stored
          // custom-app client_id must not be pushed through the authorization-code redirect
          // (admin custom apps have no OAuth redirect configured; they use client-credentials).
          const envClientId = process.env['SHOPIFY_CLIENT_ID'] ?? '';
          const dispatch = getOAuthDispatch('shopify');
          if (envClientId && dispatch) {
            // Shared-app OAuth fallback — identical to the historic oauth branch.
            try {
              const { oauth_url } = await dispatch.initiate({
                brandId,
                shopDomain: shopDomainRaw || undefined,
                callbackUrl: config.shopifyCallbackUrl,
                clientId: envClientId,
              });
              await auditWriter.append({
                brand_id: brandId,
                actor_id: auth?.userId ?? null,
                actor_role: auth?.role ?? 'unknown',
                action: 'connector.connected',
                entity_type: 'connector_instance',
                entity_id: `shopify:${brandId}`,
                payload: { connector_type: 'shopify', phase: 'oauth_initiated' },
              });
              return reply.code(200).send({ request_id: requestId, data: { kind: 'oauth', oauth_url } });
            } catch (err) {
              if ((err as { code?: string }).code === 'MISSING_SHOP_DOMAIN') {
                return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_SHOP_DOMAIN', message: (err as Error).message } });
              }
              throw err;
            }
          }
          return reply.code(400).send({
            request_id: requestId,
            error: {
              code: 'MISSING_SHOPIFY_CREDENTIALS',
              message: 'shopify connector requires: shop_domain, client_id, client_secret',
            },
          });
        }

        try {
          const result = await connectShopifyWithCredentials.execute({
            brandId,
            shopDomain: shopDomainRaw,
            clientId,
            clientSecret,
            idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? requestId,
          });
          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: result.connectorInstanceId,
            // NEVER the credentials — only the connect metadata (I-S09).
            payload: { connector_type: 'shopify', auth_method: 'client_credentials', shop_domain: result.shopDomain },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: {
              kind: 'credential',
              connected: true,
              connector_instance_id: result.connectorInstanceId,
              // Registered automatically via the Admin API — surfaced for reference/display.
              webhook: { url: result.webhookUrl, api_key: null, routing_header: null },
            },
          });
        } catch (err) {
          if (err instanceof InvalidShopDomainError) {
            return reply.code(400).send({ request_id: requestId, error: { code: err.code, message: err.message } });
          }
          if (err instanceof ShopifyCredentialsInvalidError) {
            return reply.code(422).send({ request_id: requestId, error: { code: err.code, message: err.message } });
          }
          if (err instanceof StorefrontExclusivityError) {
            return reply.code(409).send({ request_id: requestId, error: { code: err.code, message: err.message } });
          }
          throw err;
        }
      }

      // ── GA4: bespoke credential connect (service-account JWT-bearer) ────────────
      // The brand pastes its GCP service-account JSON key + numeric property id (+ optional
      // reporting currency). The command validates via a cheap runReport BEFORE persisting
      // anything, stores the SA bundle per-brand (Secrets Manager), and mirrors the property
      // id into ad_account_id (generic repull contract). No OAuth redirect, no shared env app.
      if (connectorType === 'ga4' && def.connectMethod === 'credential') {
        const creds = body.credentials ?? {};
        const propertyId = (creds['property_id'] ?? '').trim();
        const serviceAccountJson = (creds['service_account_json'] ?? '').trim();
        const currencyCode = (creds['currency_code'] ?? '').trim();

        if (!propertyId || !serviceAccountJson) {
          return reply.code(400).send({
            request_id: requestId,
            error: {
              code: 'MISSING_GA4_CREDENTIALS',
              message: 'ga4 connector requires: property_id, service_account_json',
            },
          });
        }

        try {
          const result = await connectGa4WithServiceAccount.execute({
            brandId,
            propertyId,
            serviceAccountJson,
            ...(currencyCode ? { currencyCode } : {}),
            idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? requestId,
          });
          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: result.connectorInstanceId,
            // NEVER the key — only the connect metadata (I-S09).
            payload: { connector_type: 'ga4', auth_method: 'service_account', property_id: result.propertyId },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: {
              kind: 'credential',
              connected: true,
              connector_instance_id: result.connectorInstanceId,
            },
          });
        } catch (err) {
          if (err instanceof Ga4InvalidPropertyIdError || err instanceof Ga4ServiceAccountKeyInvalidError) {
            return reply.code(400).send({ request_id: requestId, error: { code: err.code, message: err.message } });
          }
          if (err instanceof Ga4CredentialsInvalidError) {
            return reply.code(422).send({ request_id: requestId, error: { code: err.code, message: err.message } });
          }
          throw err;
        }
      }

      if (def.connectMethod === 'credential') {
        const credentials = body.credentials;
        if (!credentials || Object.keys(credentials).length === 0) {
          return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_CREDENTIALS', message: 'credentials are required for credential connectors' } });
        }

        // ── Generic credential connector (schema-driven, ADR-CM unified path) ─────────
        // Validation, the Secrets Manager bundle, the provider_config routing identifier, and the
        // dedicated column are ALL declared in the catalog (def.authFields + def.credentialConnect).
        // There is NO connector-specific code here — adding a credential connector is a catalog edit.
        // See modules/connector/credential-schema.ts → planCredentialConnect.
        const spec = def.credentialConnect;
        if (!spec || !def.authFields) {
          return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `${def.displayName} is not configured for credential connect.` } });
        }

        const plan = planCredentialConnect(def.authFields, spec, credentials);
        if (plan.missingRequired.length > 0) {
          const required = def.authFields.filter((f) => !f.optional).map((f) => f.key);
          return reply.code(400).send({
            request_id: requestId,
            error: {
              code: `MISSING_${connectorType.toUpperCase()}_CREDENTIALS`,
              message: `${connectorType} connector requires: ${required.join(', ')}`,
            },
          });
        }

        // SR-2: mint any connect-time generated secrets (e.g. Shiprocket's webhook_secret — the
        // X-Api-Key the merchant pastes into their dashboard). Brain generates it, stores it in the
        // bundle (where the webhook strategy verifies against it), and returns it ONCE below. Pure
        // planCredentialConnect stays deterministic; generation is layered on here.
        const { bundle: secretBundle, generated } = provisionGeneratedSecrets(
          plan.secretBundle,
          spec,
          () => randomBytes(24).toString('hex'),
        );

        // ── Shopflo extension: per-instance signature posture marker ──────────────────────────────
        // Shopflo's dashboard may not let the merchant configure Brain's MINTED webhook_secret, which
        // would leave the HMAC-gated webhook lane permanently-401. Record the secret's provenance in
        // the bundle (non-secret marker): 'minted' ⇒ ShopfloWebhookStrategy runs verify-if-present
        // (unsigned deliveries accepted with a posture warning; signed ones still strictly verified);
        // 'merchant' (they pasted their own Shopflo-configured secret) ⇒ strict fail-closed verify.
        if (connectorType === 'shopflo') {
          secretBundle['webhook_secret_origin'] = generated['webhook_secret'] ? 'minted' : 'merchant';
        }

        let arn: string;
        try {
          ({ arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType, subKey: plan.accountKey },
            secretBundle,
          ));
        } catch {
          return reply.code(503).send({ request_id: requestId, error: { code: 'SECRETS_UNAVAILABLE', message: 'Could not securely store credentials right now — please retry.' } });
        }

        const now = new Date();
        const connectorInstanceId = randomUUID();
        const instance = ConnectorInstanceEntity.create({
          id: connectorInstanceId,
          brandId,
          provider: connectorType,
          shopDomain: plan.shopDomain,
          secretRef: arn,
          status: 'connected',
          healthState: 'Healthy',
          safetyRating: 'safe',
          connectedAt: now,
          disconnectedAt: null,
          createdAt: now,
          updatedAt: now,
          accountKey: plan.accountKey,
          providerConfig: plan.providerConfig,
        });
        await connectorRepo.save(instance);

        // Mirror the routing identifier into its dedicated column (webhook/repull lookup key). The
        // column name is a static catalog value, guarded by SAFE_IDENTIFIER in planCredentialConnect.
        if (plan.instanceColumnUpdate) {
          const { column, value } = plan.instanceColumnUpdate;
          const colClient = await rawPgPool.connect();
          try {
            await beginRlsTxn(colClient, { correlationId: requestId, brandId });
            await colClient.query(
              `UPDATE connector_instance SET ${column} = $1 WHERE id = $2 AND brand_id = $3`,
              [value, connectorInstanceId, brandId],
            );
            await colClient.query('COMMIT');
          } catch (colErr) {
            await colClient.query('ROLLBACK').catch(() => undefined);
            throw colErr;
          } finally {
            colClient.release();
          }
        }

        await auditWriter.append({
          brand_id: brandId,
          actor_id: auth?.userId ?? null,
          actor_role: auth?.role ?? 'unknown',
          action: 'connector.connected',
          entity_type: 'connector_instance',
          entity_id: connectorInstanceId,
          // NEVER log the minted secret — only that one was provisioned (key names, not values).
          payload: { connector_type: connectorType, generated_secret_fields: Object.keys(generated) },
        });

        // SR-2: when a webhook token was minted, surface the per-tenant webhook URL + the token + the
        // routing header so the connect UI can show the merchant exactly what to paste into the provider
        // dashboard. The token is returned ONCE (it is write-only in the bundle thereafter). The webhook
        // origin is the public core API host (same host that receives the OAuth callbacks).
        let webhook: {
          url: string;
          api_key: string | null;
          routing_header: { name: string; value: string } | null;
        } | null = null;
        if (generated['webhook_secret']) {
          let origin = config.appBaseUrl;
          try {
            origin = new URL(config.shopifyCallbackUrl).origin;
          } catch {
            /* fall back to appBaseUrl */
          }
          webhook = {
            url: `${origin}/api/v1/webhooks/${connectorType}`,
            api_key: generated['webhook_secret'],
            routing_header: spec.webhookRoutingHeader
              ? { name: spec.webhookRoutingHeader, value: plan.accountKey }
              : null,
          };
        }

        return reply.code(200).send({
          request_id: requestId,
          data: {
            kind: 'credential',
            connected: true,
            connector_instance_id: connectorInstanceId,
            ...(webhook ? { webhook } : {}),
          },
        });
      }

      return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: 'Connector type not available' } });
    });

    // Legacy Shopify install path (kept for back-compat; routes through same initiateOAuth)
    scope.get('/api/v1/connectors/shopify/install', async (req: FastifyRequest<{ Querystring: { shop: string } }>, reply) => {
      const brandId = getBrandId(req);
      const shopDomain = req.query.shop;
      if (!shopDomain) {
        return reply.code(400).send({ request_id: (req.id as string) ?? randomUUID(), error: { code: 'MISSING_SHOP_PARAM', message: 'shop query parameter is required' } });
      }
      try {
        const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl: config.shopifyCallbackUrl });
        return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: { install_url: result.installUrl } });
      } catch (err) {
        if ((err as { code?: string }).code === 'OAUTH_NOT_CONFIGURED') {
          return reply.code(503).send({ request_id: (req.id as string) ?? randomUUID(), error: { code: 'OAUTH_NOT_CONFIGURED', message: "This connector isn't configured yet. Add your app credentials and try again." } });
        }
        throw err;
      }
    });

    // ── Ads install routes (manager+ — feat-ad-connectors Track 1) ──────────
    registerMetaInstallRoute(scope, {
      initiateOAuth: initiateMetaOAuth,
      handleCallback: handleMetaCallback,
      getBrandId: (req) => getBrandId(req as Parameters<typeof getBrandId>[0]),
      callbackUrl: config.metaCallbackUrl,
      appBaseUrl: config.appBaseUrl,
    });
    registerGoogleAdsInstallRoute(scope, {
      initiateOAuth: initiateGoogleAdsOAuth,
      handleCallback: handleGoogleAdsCallback,
      getBrandId: (req) => getBrandId(req as Parameters<typeof getBrandId>[0]),
      callbackUrl: config.googleAdsCallbackUrl,
      appBaseUrl: config.appBaseUrl,
    });

    // ── Razorpay webhook-secret rotation (C2 / ADR-RZ-8 — owner/admin only) ───
    const rotateWebhookSecretCmd = new RotateWebhookSecretCommand(
      connectorSecretsManager,
      connectorRepo,
    );
    registerRazorpayConnectorRoutes(scope, {
      rotateWebhookSecret: rotateWebhookSecretCmd,
      getBrandId: (req) => getBrandId(req as Parameters<typeof getBrandId>[0]),
      onRotated: async (brandId, connectorInstanceId) => {
        await auditWriter.append({
          brand_id: brandId,
          actor_id: null,
          actor_role: 'admin',
          action: 'connector.webhook_secret_rotated',
          entity_type: 'connector_instance',
          entity_id: connectorInstanceId,
          payload: { connector_type: 'razorpay' },
        });
      },
    });

    // Generic disconnect (ADR-CM-3 / Sec-C3 / Sec-C4 audit)
    scope.delete('/api/v1/connectors/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const brandId = getBrandId(req);
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      const requestId = (req.id as string) ?? randomUUID();
      try {
        await disconnectCommand.execute({ connectorInstanceId: req.params.id, brandId, idempotencyKey });
        await auditWriter.append({
          brand_id: brandId,
          actor_id: auth?.userId ?? null,
          actor_role: auth?.role ?? 'unknown',
          action: 'connector.disconnected',
          entity_type: 'connector_instance',
          entity_id: req.params.id,
          payload: { connector_instance_id: req.params.id },
        });
        return reply.code(200).send({ request_id: requestId, data: { disconnected: true } });
      } catch (err) {
        if (err instanceof ConnectorNotFoundError) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_FOUND', message: (err as Error).message } });
        }
        throw err;
      }
    });
  });
}
