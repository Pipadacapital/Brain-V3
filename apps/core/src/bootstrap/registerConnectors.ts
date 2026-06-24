/**
 * registerConnectors (CQ-2) — the connector + pixel bounded-context registrar.
 *
 * EXTRACTED VERBATIM from apps/core/src/main.ts (the HIGH-MOUNT-01 block). This is a
 * behavior-preserving move: every route path/method/response-shape/auth-guard/brand-scope
 * and all business behavior is identical to the prior inline registration. main.ts now
 * builds the global primitives (pools, services, secrets, producer) and calls this with a
 * deps bag; this file owns the per-context command wiring + route registration.
 *
 * Guards (unchanged):
 *   - Reads (GET connectors, GET status, pixel reads):     analyst+
 *   - Writes (connect, disconnect, pixel install/verify):  manager+ (+ requireVerifiedEmail on connect)
 *   - Sync:                                                 manager+
 *   - Backfill:                                             brand_admin+
 *   - OAuth callbacks + webhooks:                           PUBLIC (state nonce / HMAC is the auth)
 */

import { type FastifyRequest, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { beginRlsTxn } from '@brain/db';
import type { DbPool } from '@brain/db';
import type pg from 'pg';
import type { AuditWriter } from '@brain/audit';
import type { BackfillJobProgress } from '@brain/contracts';

import { PgBackfillJobRepository } from '../modules/connector/backfill/infrastructure/PgBackfillJobRepository.js';
import { RequestConnectorBackfillCommand } from '../modules/connector/backfill/application/commands/RequestConnectorBackfillCommand.js';
import { PgSyncRequestRepository } from '../modules/connector/sync/infrastructure/PgSyncRequestRepository.js';
import { RequestConnectorSyncCommand } from '../modules/connector/sync/application/commands/RequestConnectorSyncCommand.js';
import { registerAllWebhookRoutes } from '../modules/connector/webhooks/platform/registerWebhookRoutes.js';
import { registerRazorpayConnectorRoutes } from '../modules/connector/sources/payment/razorpay/interfaces/http/razorpayConnectorRoutes.js';
import { RotateWebhookSecretCommand } from '../modules/connector/sources/payment/razorpay/application/commands/RotateWebhookSecretCommand.js';
import { registerDevShopifySyncRoutes } from '../modules/connector/sources/storefront/shopify/interfaces/http/devShopifySyncRoutes.js';
import { registerPixelInstallerRoutes, buildDefaultSnippet, isValidIngestHost } from '../modules/connector/pixel/interfaces/http/pixelRoutes.js';
import { PixelInstallerRegistry } from '../modules/connector/pixel/application/install/PixelInstaller.js';
import { ShopifyPixelInstaller } from '../modules/connector/sources/storefront/shopify/application/install/ShopifyPixelInstaller.js';
import { WooCommercePixelInstaller } from '../modules/connector/sources/storefront/woocommerce/application/install/WooCommercePixelInstaller.js';
import { InstallWooCommercePixelCommand } from '../modules/connector/sources/storefront/woocommerce/application/commands/InstallWooCommercePixelCommand.js';
import { getDefinition, isConnectable, CONNECTOR_CATALOG } from '../modules/connector/catalog/index.js';
import { registerOAuthDispatch, getOAuthDispatch } from '../modules/connector/catalog/dispatch.js';
import { InitiateOAuthCommand } from '../modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.js';
import { ConnectorInstance as ConnectorInstanceEntity } from '@brain/connector-core';
import {
  HandleOAuthCallbackCommand,
  HmacValidationError,
  StateNonceError,
  ShopDomainError,
} from '../modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.js';
import {
  DisconnectCommand,
  ConnectorNotFoundError,
} from '../modules/connector/sources/storefront/shopify/application/commands/DisconnectCommand.js';
import { GetConnectorStatusQuery } from '../modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.js';
import { InitiateMetaOAuthCommand } from '../modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.js';
import { HandleMetaOAuthCallbackCommand } from '../modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import {
  registerMetaInstallRoute,
  registerMetaCallbackRoute,
} from '../modules/connector/sources/advertising/meta/interfaces/http/metaConnectorRoutes.js';
import { InitiateGoogleAdsOAuthCommand } from '../modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.js';
import { HandleGoogleAdsOAuthCallbackCommand } from '../modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.js';
import {
  registerGoogleAdsInstallRoute,
  registerGoogleAdsCallbackRoute,
} from '../modules/connector/sources/advertising/google/interfaces/http/googleAdsConnectorRoutes.js';
import type { PgConnectorInstanceRepository } from '../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { PgConnectorSyncStatusRepository } from '../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { GetOrCreatePixelInstallationCommand } from '../modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import {
  VerifyPixelCommand,
  PixelInstallationNotFoundError,
} from '../modules/connector/pixel/application/commands/VerifyPixelCommand.js';
import { GetPixelHealthQuery } from '../modules/connector/pixel/application/queries/GetPixelHealthQuery.js';
import type { PgPixelInstallationRepository } from '../modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.js';
import type { PgPixelStatusRepository } from '../modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.js';
import { InstallPixelCommand, InstallPixelError } from '../modules/connector/sources/storefront/shopify/application/commands/InstallPixelCommand.js';
import { UninstallPixelCommand, UninstallPixelError } from '../modules/connector/sources/storefront/shopify/application/commands/UninstallPixelCommand.js';
import { ShopifyAdminClient } from '../modules/connector/sources/storefront/shopify/infrastructure/api/ShopifyAdminClient.js';

import { requireRole } from '../modules/workspace-access/internal/security/rbac.js';
import { requireVerifiedEmail } from '../modules/workspace-access/internal/security/email-verified.guard.js';
import type { AuthenticatedRequest } from '../modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import type { AuthService } from '../modules/workspace-access/internal/application/auth.service.js';
import { validateSessionPreHandler } from '../modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import type { Neo4jIdentityReader } from '../modules/identity/internal/infrastructure/neo4j-identity-reader.js';
import type { EmitEvent } from '../infrastructure/events/M1EventPublisher.js';

/** Config slice the connector context needs (subset of main's config). */
export interface ConnectorContextConfig {
  nodeEnv: string;
  appBaseUrl: string;
  shopifyCallbackUrl: string;
  metaCallbackUrl: string;
  googleAdsCallbackUrl: string;
  pixelIngestBaseUrl: string;
  kafkaEnv: string;
}

export interface RegisterConnectorsDeps {
  config: ConnectorContextConfig;
  pool: DbPool;
  rawPgPool: pg.Pool;
  redis: import('ioredis').Redis;
  authService: AuthService;
  auditWriter: AuditWriter;
  connectorRepo: PgConnectorInstanceRepository;
  syncStatusRepo: PgConnectorSyncStatusRepository;
  connectorSecretsManager: ISecretsManager;
  oauthStateStore: IOAuthStateStore;
  webhookProducer: Producer;
  liveTopic: string;
  getWebhookSaltHex: (brandId: string) => Promise<string>;
  identityReader: Neo4jIdentityReader;
  // Pixel provisioning (constructed in main BEFORE BrandService — ADR-4).
  pixelInstallationRepo: PgPixelInstallationRepository;
  pixelStatusRepo: PgPixelStatusRepository;
  getOrCreateInstallation: GetOrCreatePixelInstallationCommand;
  /** Real M1 domain-event publisher (EV-2). */
  emitEvent: EmitEvent;
}

export function registerConnectors(app: FastifyInstance, deps: RegisterConnectorsDeps): void {
  const {
    config,
    pool,
    rawPgPool,
    authService,
    auditWriter,
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    oauthStateStore,
    webhookProducer,
    liveTopic,
    getWebhookSaltHex,
    identityReader,
    pixelInstallationRepo,
    pixelStatusRepo,
    getOrCreateInstallation,
    emitEvent,
  } = deps;
  const nodeEnv = config.nodeEnv;

  // ── HIGH-MOUNT-01: Mount connector + pixel routes with guards wired HERE ────
  // (See main.ts history for the full rationale; behavior is unchanged.)

  const initiateOAuth = new InitiateOAuthCommand(connectorSecretsManager, oauthStateStore);
  const handleCallback = new HandleOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
  );
  const disconnectCommand = new DisconnectCommand(
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    emitEvent,
  );
  const getConnectorStatus = new GetConnectorStatusQuery(connectorRepo, syncStatusRepo);

  // ── Generic webhook pipeline (all 4 providers) — PUBLIC routes, HMAC-protected ──
  registerAllWebhookRoutes(app, {
    secretsManager: connectorSecretsManager,
    rawPgPool,
    producer: webhookProducer,
    liveTopic,
    getSaltHex: getWebhookSaltHex,
    redis: deps.redis,
    identityReader, // Epic 3 / ADR-0004: GDPR redact resolves + erases via the Neo4j identity SoR
  });

  app.log.info({ topic: liveTopic }, '[core] All webhook receivers registered via generic pipeline (Shopify/Razorpay/Shopflo/WooCommerce)');

  // DEV-ONLY: validate-sync spike — mounted only outside production (I-S09).
  if (nodeEnv !== 'production') {
    registerDevShopifySyncRoutes(app, connectorSecretsManager);
    app.log.warn('[dev] /api/v1/dev/shopify/validate-sync mounted (NODE_ENV != production)');
  }

  // ── Advertising OAuth connectors (feat-ad-connectors Track 1) ──────────────
  const setAdAccountId = async (
    brandId: string,
    connectorInstanceId: string,
    adAccountId: string,
  ): Promise<void> => {
    const client = await rawPgPool.connect();
    try {
      await beginRlsTxn(client, { correlationId: 'connector:set-ad-account', brandId });
      await client.query(
        `UPDATE connector_instance SET ad_account_id = $1 WHERE id = $2 AND brand_id = $3`,
        [adAccountId, connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const initiateMetaOAuth = new InitiateMetaOAuthCommand(oauthStateStore);
  const handleMetaCallback = new HandleMetaOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    setAdAccountId,
  );
  const initiateGoogleAdsOAuth = new InitiateGoogleAdsOAuthCommand(oauthStateStore);
  const handleGoogleAdsCallback = new HandleGoogleAdsOAuthCallbackCommand(
    connectorSecretsManager,
    oauthStateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    setAdAccountId,
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

  // Shared session preHandler for connector/pixel routes (NN-3).
  const sessionPreHandler = validateSessionPreHandler(authService);

  // Helper to extract brand_id from the authenticated request.
  function getBrandId(req: Parameters<typeof sessionPreHandler>[0]): string {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth?.brandId) {
      throw Object.assign(new Error('No brand context in JWT'), { statusCode: 400, code: 'NO_BRAND_CONTEXT' });
    }
    return auth.brandId;
  }

  // ── OAUTH_DISPATCH_TABLE registration (A3 — ADR-CM-3) ─────────────────────
  registerOAuthDispatch('shopify', {
    initiate: async ({ brandId, shopDomain, callbackUrl }) => {
      if (!shopDomain) {
        throw Object.assign(new Error('shop_domain is required for shopify OAuth'), {
          code: 'MISSING_SHOP_DOMAIN',
          statusCode: 400,
        });
      }
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl });
      return { oauth_url: result.installUrl };
    },
  });

  registerOAuthDispatch('meta', {
    initiate: async ({ brandId }) => {
      const result = await initiateMetaOAuth.execute({
        brandId,
        callbackUrl: config.metaCallbackUrl,
      });
      return { oauth_url: result.installUrl };
    },
  });
  registerOAuthDispatch('google_ads', {
    initiate: async ({ brandId }) => {
      const result = await initiateGoogleAdsOAuth.execute({
        brandId,
        callbackUrl: config.googleAdsCallbackUrl,
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

  // ── Connector read routes (analyst+) ────────────────────────────────────────
  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    scope.get('/api/v1/connectors', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const instances = await connectorRepo.findAllByBrand(brandId);

      const activeByProvider = new Map<string, typeof instances>();
      for (const inst of instances) {
        if (inst.status === 'disconnected') continue;
        const list = activeByProvider.get(inst.provider) ?? [];
        list.push(inst);
        activeByProvider.set(inst.provider, list);
      }

      const tiles = CONNECTOR_CATALOG.map((def) => {
        const activeInstances = activeByProvider.get(def.id) ?? [];
        const firstInstance = activeInstances[0] ?? null;

        const toInstanceShape = (inst: typeof instances[0]) => {
          // account_label = the human name for this account's sub-card (Meta ad-account name,
          // Google Ads descriptive name, …), stored in provider_config at connect time. Falls
          // back to null so the UI shows the raw account_key when no name was captured.
          const cfg = (inst.providerConfig ?? {}) as Record<string, unknown>;
          const accountLabel =
            (cfg['ad_account_name'] as string | undefined) ??
            (cfg['account_name'] as string | undefined) ??
            null;
          return {
            id: inst.id,
            status: inst.status,
            health_state: inst.healthState,
            safety_rating: inst.safetyRating,
            shop_domain: inst.shopDomain || null,
            connected_at: inst.connectedAt.toISOString(),
            account_key: inst.accountKey,
            account_label: accountLabel,
          };
        };

        return {
          id: def.id,
          category: def.category,
          display_name: def.displayName,
          description: def.description,
          connect_method: def.connectMethod as 'oauth' | 'credential' | 'coming_soon',
          available: def.availability === 'available',
          instance: firstInstance ? toInstanceShape(firstInstance) : null,
          instances: activeInstances.map(toInstanceShape),
        };
      });

      return reply.code(200).send({ request_id: requestId, data: { tiles } });
    });

    scope.get('/api/v1/connectors/:id/status', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const id = req.params.id;

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!isUuid) {
        const status = await getConnectorStatus.execute(brandId);
        return reply.code(200).send({ request_id: requestId, data: status.shopify });
      }

      const view = await getConnectorStatus.executeForConnector(id, brandId);
      if (!view) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      return reply.code(200).send({
        request_id: requestId,
        data: {
          id: view.connectorInstanceId,
          provider: view.provider,
          status: view.status,
          sync_state: view.syncState,
          last_sync_at: view.lastSyncAt,
          last_error: view.lastError,
        },
      });
    });
  });

  // ── Connector write routes (manager+) ────────────────────────────────────────
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

      if (def.connectMethod === 'oauth') {
        const dispatch = getOAuthDispatch(connectorType);
        if (!dispatch) {
          return reply.code(422).send({ request_id: requestId, error: { code: 'CONNECTOR_NOT_AVAILABLE', message: `OAuth not configured for ${connectorType}` } });
        }
        try {
          const { oauth_url } = await dispatch.initiate({
            brandId,
            shopDomain: body.shop_domain,
            callbackUrl: config.shopifyCallbackUrl,
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
            return reply.code(503).send({ request_id: requestId, error: { code: 'OAUTH_NOT_CONFIGURED', message: (err as Error).message } });
          }
          throw err;
        }
      }

      if (def.connectMethod === 'credential') {
        const credentials = body.credentials;
        if (!credentials || Object.keys(credentials).length === 0) {
          return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_CREDENTIALS', message: 'credentials are required for credential connectors' } });
        }

        // ── Razorpay credential connector (C2 / ADR-RZ-8) ─────────────────
        if (connectorType === 'razorpay') {
          const keyId = credentials['key_id'];
          const keySecret = credentials['key_secret'];
          const webhookSecret = credentials['webhook_secret'];
          const razorpayAccountId = credentials['razorpay_account_id'];

          if (!keyId || !keySecret || !webhookSecret || !razorpayAccountId) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_RAZORPAY_CREDENTIALS',
                message: 'razorpay connector requires: key_id, key_secret, webhook_secret, razorpay_account_id',
              },
            });
          }

          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'razorpay', subKey: razorpayAccountId },
            { key_id: keyId, key_secret: keySecret, webhook_secret: webhookSecret },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'razorpay',
            shopDomain: '',
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
            accountKey: razorpayAccountId,
            providerConfig: { razorpay_account_id: razorpayAccountId },
          });
          await connectorRepo.save(instance);

          const rzClient = await rawPgPool.connect();
          try {
            await beginRlsTxn(rzClient, { correlationId: requestId, brandId });
            await rzClient.query(
              `UPDATE connector_instance SET razorpay_account_id = $1 WHERE id = $2 AND brand_id = $3`,
              [razorpayAccountId, connectorInstanceId, brandId],
            );
            await rzClient.query('COMMIT');
          } catch (rzErr) {
            await rzClient.query('ROLLBACK').catch(() => undefined);
            throw rzErr;
          } finally {
            rzClient.release();
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'razorpay' },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // ── Shopflo credential connector (Track B) ────────────────────────
        if (connectorType === 'shopflo') {
          const apiToken = credentials['api_token'];
          const merchantId = credentials['merchant_id'];
          const webhookSecret = credentials['webhook_secret'];

          if (!apiToken || !merchantId || !webhookSecret) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_SHOPFLO_CREDENTIALS',
                message: 'shopflo connector requires: api_token, merchant_id, webhook_secret',
              },
            });
          }

          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'shopflo', subKey: merchantId },
            { api_token: apiToken, merchant_id: merchantId, webhook_secret: webhookSecret },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'shopflo',
            shopDomain: '',
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
            accountKey: merchantId,
            providerConfig: { shopflo_merchant_id: merchantId },
          });
          await connectorRepo.save(instance);

          const sfClient = await rawPgPool.connect();
          try {
            await beginRlsTxn(sfClient, { correlationId: requestId, brandId });
            await sfClient.query(
              `UPDATE connector_instance SET shopflo_merchant_id = $1 WHERE id = $2 AND brand_id = $3`,
              [merchantId, connectorInstanceId, brandId],
            );
            await sfClient.query('COMMIT');
          } catch (sfErr) {
            await sfClient.query('ROLLBACK').catch(() => undefined);
            throw sfErr;
          } finally {
            sfClient.release();
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'shopflo' },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // ── GoKwik credential connector (Track B) ─────────────────────────
        if (connectorType === 'gokwik') {
          const appid = credentials['appid'];
          const appsecret = credentials['appsecret'];

          if (!appid || !appsecret) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_GOKWIK_CREDENTIALS',
                message: 'gokwik connector requires: appid, appsecret',
              },
            });
          }

          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'gokwik', subKey: appid },
            { appid, appsecret },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'gokwik',
            shopDomain: '',
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
            accountKey: appid,
            providerConfig: { gokwik_appid: appid },
          });
          await connectorRepo.save(instance);

          const gkClient = await rawPgPool.connect();
          try {
            await beginRlsTxn(gkClient, { correlationId: requestId, brandId });
            await gkClient.query(
              `UPDATE connector_instance SET gokwik_appid = $1 WHERE id = $2 AND brand_id = $3`,
              [appid, connectorInstanceId, brandId],
            );
            await gkClient.query('COMMIT');
          } catch (gkErr) {
            await gkClient.query('ROLLBACK').catch(() => undefined);
            throw gkErr;
          } finally {
            gkClient.release();
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'gokwik' },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // ── Shiprocket credential connector (logistics) ──────────────────
        if (connectorType === 'shiprocket') {
          const email = credentials['email'];
          const password = credentials['password'];
          const channelId = credentials['channel_id'] ?? null;

          if (!email || !password) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_SHIPROCKET_CREDENTIALS',
                message: 'shiprocket connector requires: email, password',
              },
            });
          }

          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'shiprocket', subKey: channelId ?? email },
            { email, password },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const shiprocketAccountKey = channelId ?? email;
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'shiprocket',
            shopDomain: '',
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
            accountKey: shiprocketAccountKey,
            providerConfig: channelId ? { shiprocket_channel_id: channelId } : {},
          });
          await connectorRepo.save(instance);

          if (channelId) {
            const srClient = await rawPgPool.connect();
            try {
              await beginRlsTxn(srClient, { correlationId: requestId, brandId });
              await srClient.query(
                `UPDATE connector_instance SET shiprocket_channel_id = $1 WHERE id = $2 AND brand_id = $3`,
                [channelId, connectorInstanceId, brandId],
              );
              await srClient.query('COMMIT');
            } catch (srErr) {
              await srClient.query('ROLLBACK').catch(() => undefined);
              throw srErr;
            } finally {
              srClient.release();
            }
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'shiprocket' },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // ── WooCommerce credential connector (storefront) ─────────────────
        if (connectorType === 'woocommerce') {
          const consumerKey = credentials['consumer_key'];
          const consumerSecret = credentials['consumer_secret'];
          const siteUrl = credentials['site_url'];
          const webhookSecret = credentials['webhook_secret'];

          if (!consumerKey || !consumerSecret || !siteUrl) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_WOOCOMMERCE_CREDENTIALS',
                message: 'woocommerce connector requires: consumer_key, consumer_secret, site_url',
              },
            });
          }

          const { arn } = await connectorSecretsManager.storeSecret(
            brandId,
            { connectorType: 'woocommerce', subKey: siteUrl },
            webhookSecret
              ? { consumer_key: consumerKey, consumer_secret: consumerSecret, webhook_secret: webhookSecret }
              : { consumer_key: consumerKey, consumer_secret: consumerSecret },
          );

          const now = new Date();
          const connectorInstanceId = randomUUID();
          const instance = ConnectorInstanceEntity.create({
            id: connectorInstanceId,
            brandId,
            provider: 'woocommerce',
            shopDomain: siteUrl,
            secretRef: arn,
            status: 'connected',
            healthState: 'Healthy',
            safetyRating: 'safe',
            connectedAt: now,
            disconnectedAt: null,
            createdAt: now,
            updatedAt: now,
            accountKey: siteUrl,
            providerConfig: { woocommerce_site_url: siteUrl },
          });
          await connectorRepo.save(instance);

          const wcClient = await rawPgPool.connect();
          try {
            await beginRlsTxn(wcClient, { correlationId: requestId, brandId });
            await wcClient.query(
              `UPDATE connector_instance SET woocommerce_site_url = $1 WHERE id = $2 AND brand_id = $3`,
              [siteUrl, connectorInstanceId, brandId],
            );
            await wcClient.query('COMMIT');
          } catch (wcErr) {
            await wcClient.query('ROLLBACK').catch(() => undefined);
            throw wcErr;
          } finally {
            wcClient.release();
          }

          await auditWriter.append({
            brand_id: brandId,
            actor_id: auth?.userId ?? null,
            actor_role: auth?.role ?? 'unknown',
            action: 'connector.connected',
            entity_type: 'connector_instance',
            entity_id: connectorInstanceId,
            payload: { connector_type: 'woocommerce' },
          });
          return reply.code(200).send({
            request_id: requestId,
            data: { kind: 'credential', connected: true, connector_instance_id: connectorInstanceId },
          });
        }

        // Generic credential connector path
        const { arn } = await connectorSecretsManager.storeSecret(brandId, { connectorType }, credentials);
        const now = new Date();
        const instance = ConnectorInstanceEntity.create({
          id: randomUUID(),
          brandId,
          provider: connectorType,
          shopDomain: '',
          secretRef: arn,
          status: 'connected',
          healthState: 'Healthy',
          safetyRating: 'safe',
          connectedAt: now,
          disconnectedAt: null,
          createdAt: now,
          updatedAt: now,
          accountKey: '__default__',
          providerConfig: {},
        });
        await connectorRepo.save(instance);
        await auditWriter.append({
          brand_id: brandId,
          actor_id: auth?.userId ?? null,
          actor_role: auth?.role ?? 'unknown',
          action: 'connector.connected',
          entity_type: 'connector_instance',
          entity_id: instance.id,
          payload: { connector_type: connectorType },
        });
        return reply.code(200).send({ request_id: requestId, data: { kind: 'credential', connected: true } });
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
      const result = await initiateOAuth.execute({ brandId, shopDomain, callbackUrl: config.shopifyCallbackUrl });
      return reply.code(200).send({ request_id: (req.id as string) ?? randomUUID(), data: { install_url: result.installUrl } });
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

  // ── Backfill + sync routes (manager+ scope; backfill re-tightened to brand_admin+) ──
  const backfillJobRepo = new PgBackfillJobRepository(pool);
  const syncRequestRepo = new PgSyncRequestRepository(pool);
  const requestConnectorSync = new RequestConnectorSyncCommand(
    connectorRepo,
    connectorSecretsManager,
    syncRequestRepo,
    auditWriter,
  );
  // CQ-3: extracted RequestConnectorBackfillCommand (mirrors RequestConnectorSyncCommand).
  const requestConnectorBackfill = new RequestConnectorBackfillCommand(
    connectorRepo,
    connectorSecretsManager,
    backfillJobRepo,
    auditWriter,
  );

  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));

    // POST /api/v1/connectors/:id/sync — "Sync now" (feat-connector-sync-now)
    scope.post('/api/v1/connectors/:id/sync', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await requestConnectorSync.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode = result.code === 'CONNECTOR_NOT_FOUND' ? 404 : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(202).send({
        request_id: requestId,
        data: {
          connector_instance_id: result.connectorInstanceId,
          status: result.status,
          requested_at: result.requestedAt,
        },
      });
    });

    // B1 — Backfill trigger (ADR-BF-3). Re-tighten to brand_admin+ (Manager → 403).
    // CQ-3: thin route → RequestConnectorBackfillCommand.execute().
    scope.post<{ Params: { id: string } }>('/api/v1/connectors/:id/backfill', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await requestConnectorBackfill.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode = result.code === 'CONNECTOR_NOT_FOUND' ? 404 : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(202).send({
        request_id: requestId,
        data: { job_id: result.jobId, status: result.status },
      });
    });

    // B2 — Progress API (ADR-BF-4)
    scope.get<{ Params: { id: string } }>('/api/v1/connectors/:id/jobs', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;

      const connectorInstance = await connectorRepo.findById(connectorInstanceId, brandId);
      if (!connectorInstance) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      const job = await backfillJobRepo.findLatestForConnector(connectorInstanceId, brandId, requestId);
      if (!job) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'NO_BACKFILL_JOB', message: 'No backfill job found for this connector.' },
        });
      }

      const recordsProcessed = parseInt(job.records_processed, 10);
      const estimatedTotal = job.estimated_total !== null ? parseInt(job.estimated_total, 10) : null;
      const percent =
        estimatedTotal !== null && estimatedTotal > 0
          ? Math.min(100, Math.round((recordsProcessed / estimatedTotal) * 100))
          : null;

      const progress: BackfillJobProgress = {
        job_id: job.id,
        status: job.status,
        records_processed: recordsProcessed,
        estimated_total: estimatedTotal,
        percent,
        cursor_date: job.cursor_date ?? null,
        achieved_depth_label: job.achieved_depth_label ?? null,
        failure_reason: job.failure_reason ?? null,
        started_at: job.started_at ?? null,
        completed_at: job.completed_at ?? null,
      };

      return reply.code(200).send({
        request_id: requestId,
        data: progress,
      });
    });
  });

  // ── Pixel routes (HIGH-MOUNT-01) ───────────────────────────────────────────
  const shopifyScriptTagCheck = async (
    brandId: string,
  ): Promise<{ present: boolean; src: string | null } | null> => {
    const conn = await connectorRepo.findByBrandAndProvider(brandId, 'shopify');
    if (!conn || conn.status !== 'connected') return null;
    const token = await connectorSecretsManager.getShopifyToken(conn.secretRef);
    if (!token) return null;
    try {
      const client = new ShopifyAdminClient(conn.shopDomain, token);
      const brainTags = (await client.listScriptTags()).filter((s) => s.src.includes('/pixel.js'));
      return { present: brainTags.length > 0, src: brainTags[0]?.src ?? null };
    } catch {
      return null;
    }
  };

  const verifyPixel = new VerifyPixelCommand(
    pixelInstallationRepo,
    pixelStatusRepo,
    emitEvent,
    shopifyScriptTagCheck,
  );
  const getPixelHealth = new GetPixelHealthQuery(pixelInstallationRepo, pixelStatusRepo);

  const installPixel = new InstallPixelCommand(
    connectorRepo,
    connectorSecretsManager,
    getOrCreateInstallation,
    pixelInstallationRepo,
    pixelStatusRepo,
    config.pixelIngestBaseUrl,
  );
  const uninstallPixel = new UninstallPixelCommand(
    connectorRepo,
    connectorSecretsManager,
    pixelInstallationRepo,
  );

  const installWooCommercePixel = new InstallWooCommercePixelCommand(
    connectorRepo,
    connectorSecretsManager,
    getOrCreateInstallation,
    pixelInstallationRepo,
    pixelStatusRepo,
    config.pixelIngestBaseUrl,
  );

  const pixelInstallerRegistry = new PixelInstallerRegistry()
    .register(new ShopifyPixelInstaller(installPixel, uninstallPixel, connectorRepo))
    .register(new WooCommercePixelInstaller(installWooCommercePixel, connectorRepo));

  // Pixel read routes (analyst+)
  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    scope.get('/api/v1/pixel/installation', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const existing = await pixelInstallationRepo.findByBrandId(brandId);
      if (!existing) {
        return reply.code(200).send({ request_id: requestId, data: { installed: false } });
      }
      const snippet = buildDefaultSnippet(existing.installToken, brandId, config.pixelIngestBaseUrl, existing.customIngestHost);
      return reply.code(200).send({
        request_id: requestId,
        data: {
          installed: true,
          installation_id: existing.id,
          install_token: existing.installToken,
          target_host: existing.targetHost,
          custom_ingest_host: existing.customIngestHost,
          snippet_html: snippet,
          is_new: false,
        },
      });
    });

    scope.get('/api/v1/pixel/health', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const health = await getPixelHealth.execute(brandId);
      return reply.code(200).send({ request_id: requestId, data: health });
    });
  });

  // Pixel write routes (manager+)
  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));

    scope.post('/api/v1/pixel/installation', async (req: FastifyRequest<{ Body: { target_host?: string } }>, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      const targetHost = (req.body?.target_host ?? '').trim();
      if (!targetHost) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'MISSING_TARGET_HOST', message: 'target_host is required' } });
      }
      const result = await getOrCreateInstallation.execute({ brandId, targetHost, idempotencyKey });
      const snippet = buildDefaultSnippet(result.installToken, brandId, config.pixelIngestBaseUrl);
      return reply.code(result.isNew ? 201 : 200).send({
        request_id: requestId,
        data: { installed: true, installation_id: result.installationId, install_token: result.installToken, target_host: result.targetHost, snippet_html: snippet, is_new: result.isNew },
      });
    });

    scope.patch('/api/v1/pixel/ingest-host', async (req: FastifyRequest<{ Body: { custom_ingest_host?: string | null } }>, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const raw = req.body?.custom_ingest_host;
      const host = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
      if (host !== null && host !== '' && !isValidIngestHost(host)) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_INGEST_HOST', message: 'custom_ingest_host must be a bare hostname (e.g. events.brand.com) or null to clear.' } });
      }
      const updated = await pixelInstallationRepo.setCustomIngestHost(brandId, host === '' ? null : host);
      if (!updated) {
        return reply.code(404).send({ request_id: requestId, error: { code: 'PIXEL_NOT_INSTALLED', message: 'No pixel installation for this brand. Provision the pixel first.' } });
      }
      const snippet = buildDefaultSnippet(updated.installToken, brandId, config.pixelIngestBaseUrl, updated.customIngestHost);
      return reply.code(200).send({
        request_id: requestId,
        data: { installed: true, installation_id: updated.id, install_token: updated.installToken, target_host: updated.targetHost, custom_ingest_host: updated.customIngestHost, snippet_html: snippet, is_new: false },
      });
    });

    scope.post('/api/v1/pixel/verify', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
      try {
        const result = await verifyPixel.execute({ brandId, idempotencyKey });
        return reply.code(200).send({ request_id: requestId, data: { verified: result.verified, state: result.state, message: result.message } });
      } catch (err) {
        if (err instanceof PixelInstallationNotFoundError) {
          return reply.code(404).send({ request_id: requestId, error: { code: 'PIXEL_NOT_INSTALLED', message: (err as Error).message } });
        }
        throw err;
      }
    });

    scope.post('/api/v1/pixel/install/shopify', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? randomUUID();
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
            web_pixel: result.webPixel,
          },
        });
      } catch (err) {
        if (err instanceof InstallPixelError) {
          return reply.code(409).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    });

    scope.post('/api/v1/pixel/uninstall/shopify', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      try {
        const result = await uninstallPixel.execute({ brandId });
        return reply.code(200).send({
          request_id: requestId,
          data: { removed: result.removed, already_absent: result.alreadyAbsent },
        });
      } catch (err) {
        if (err instanceof UninstallPixelError) {
          return reply.code(409).send({ request_id: requestId, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    });

    registerPixelInstallerRoutes(scope, { registry: pixelInstallerRegistry, getBrandId });
  });
}
