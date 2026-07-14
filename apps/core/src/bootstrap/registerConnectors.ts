/**
 * registerConnectors (CQ-2) — the connector + pixel bounded-context registrar.
 *
 * Thin orchestrator. EXTRACTED VERBATIM from apps/core/src/main.ts (the HIGH-MOUNT-01 block),
 * then mechanically split (no behavior change) into focused per-area registrars under
 * ./connectors/*. Every route path/method/response-shape/auth-guard/brand-scope and all
 * business behavior is identical to the prior inline registration. This file:
 *   - builds the cross-cutting primitives (session preHandler, the shared OAuth command bundle,
 *     setAdAccountId), and
 *   - calls each area registrar in the SAME ORDER with the SAME deps.
 *
 * Guards (unchanged):
 *   - Reads (GET connectors, GET status, pixel reads):     analyst+
 *   - Writes (connect, disconnect, pixel install/verify):  manager+ (+ requireVerifiedEmail on connect)
 *   - Sync:                                                 manager+
 *   - Backfill:                                             brand_admin+
 *   - OAuth callbacks + webhooks:                           PUBLIC (state nonce / HMAC is the auth)
 */

import { type FastifyInstance } from 'fastify';
import { beginRlsTxn } from '@brain/db';
import type { DbPool } from '@brain/db';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import type { AuditWriter } from '@brain/audit';

import { registerAllWebhookRoutes } from '../modules/connector/webhooks/platform/registerWebhookRoutes.js';
import { registerDevShopifySyncRoutes } from '../modules/connector/sources/storefront/shopify/interfaces/http/devShopifySyncRoutes.js';
import { InitiateOAuthCommand } from '../modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.js';
import { InitiateMetaOAuthCommand } from '../modules/connector/sources/advertising/meta/application/commands/InitiateMetaOAuthCommand.js';
import { HandleMetaOAuthCallbackCommand } from '../modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import { InitiateGoogleAdsOAuthCommand } from '../modules/connector/sources/advertising/google/application/commands/InitiateGoogleAdsOAuthCommand.js';
import { HandleGoogleAdsOAuthCallbackCommand } from '../modules/connector/sources/advertising/google/application/commands/HandleGoogleAdsOAuthCallbackCommand.js';
import type { PgConnectorInstanceRepository } from '../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { PgConnectorSyncStatusRepository } from '../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { GetOrCreatePixelInstallationCommand } from '../modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import type { PgPixelInstallationRepository } from '../modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.js';
import type { PgPixelStatusRepository } from '../modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.js';

import { validateSessionPreHandler } from '../modules/workspace-access/internal/interfaces/rest/auth.routes.js';
import type { AuthService } from '../modules/workspace-access/internal/application/auth.service.js';
import type { Neo4jIdentityReader } from '../modules/identity/internal/infrastructure/neo4j-identity-reader.js';
import type { EmitEvent } from '../infrastructure/events/M1EventPublisher.js';
import type { ErasureEventPublisher } from '../infrastructure/events/ErasureEventPublisher.js';

import { type ConnectorContextConfig, type SharedOAuthCommands } from './connectors/shared.js';
import { registerConnectorOAuthRoutes } from './connectors/oauthRoutes.js';
import { registerConnectorReadRoutes } from './connectors/readRoutes.js';
import { registerConnectorWriteRoutes } from './connectors/writeRoutes.js';
import { registerConnectorBackfillSyncRoutes } from './connectors/backfillSyncRoutes.js';
import { registerConnectorPixelRoutes } from './connectors/pixelRoutes.js';

export type { ConnectorContextConfig } from './connectors/shared.js';

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
  /**
   * AUD-OPS-036 — the RTBF erasure-trigger bridge for Shopify customers/redact. Optional:
   * absent → the redact side-effect still runs the synchronous partial erase but emits no
   * trigger (pre-bridge behavior; existing tests omit it).
   */
  erasureEventPublisher?: ErasureEventPublisher;
  /**
   * SPEC: A.1.4 (WA-09) — per-brand `connector.identity_fields` flag resolver (platform-flags
   * FlagService read, injected from main.ts). OPTIONAL + FAIL-CLOSED: absent → flag OFF → the
   * webhook mappers emit today's envelope byte-identical.
   */
  isIdentityFieldsEnabled?: (brandId: string) => Promise<boolean>;
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

  // Shared session preHandler for connector/pixel routes (NN-3).
  const sessionPreHandler = validateSessionPreHandler(authService);

  // Writes the chosen ad account onto the connector instance after an ads OAuth callback (D-1).
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

  // The OAuth command set shared by the OAuth-routes + connector-write registrars. Built once so
  // both wire the exact same instances (unchanged behavior).
  const oauthCommands: SharedOAuthCommands = {
    initiateOAuth: new InitiateOAuthCommand(connectorSecretsManager, oauthStateStore),
    initiateMetaOAuth: new InitiateMetaOAuthCommand(oauthStateStore),
    handleMetaCallback: new HandleMetaOAuthCallbackCommand(
      connectorSecretsManager,
      oauthStateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
      setAdAccountId,
    ),
    initiateGoogleAdsOAuth: new InitiateGoogleAdsOAuthCommand(oauthStateStore),
    handleGoogleAdsCallback: new HandleGoogleAdsOAuthCallbackCommand(
      connectorSecretsManager,
      oauthStateStore,
      connectorRepo,
      syncStatusRepo,
      emitEvent,
      setAdAccountId,
    ),
  };

  // ── Generic webhook pipeline (all 4 providers) — PUBLIC routes, HMAC-protected ──
  registerAllWebhookRoutes(app, {
    secretsManager: connectorSecretsManager,
    rawPgPool,
    producer: webhookProducer,
    liveTopic,
    getSaltHex: getWebhookSaltHex,
    redis: deps.redis,
    identityReader, // Epic 3 / ADR-0004: GDPR redact resolves + erases via the Neo4j identity SoR
    // AUD-OPS-036: customers/redact also publishes the canonical erasure trigger.
    erasureEventPublisher: deps.erasureEventPublisher,
    // SPEC: A.1.4 (WA-09) — connector.identity_fields flag gate (fail-closed when absent).
    isIdentityFieldsEnabled: deps.isIdentityFieldsEnabled,
  });

  app.log.info({ topic: liveTopic }, '[core] All webhook receivers registered via generic pipeline (Shopify/Razorpay/Shopflo/WooCommerce)');

  // DEV-ONLY: validate-sync spike — mounted only outside production (I-S09).
  if (nodeEnv !== 'production') {
    registerDevShopifySyncRoutes(app, connectorSecretsManager);
    app.log.warn('[dev] /api/v1/dev/shopify/validate-sync mounted (NODE_ENV != production)');
  }

  // ── OAuth dispatch + PUBLIC callback routes (ADR-CM-3 / ADR-AD-2 / D-1) ─────
  registerConnectorOAuthRoutes(app, {
    config,
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    oauthStateStore,
    auditWriter,
    emitEvent,
    oauthCommands,
  });

  // ── Connector read routes (analyst+) ────────────────────────────────────────
  registerConnectorReadRoutes(app, { config, connectorRepo, syncStatusRepo, sessionPreHandler });

  // ── Connector write routes (manager+) ───────────────────────────────────────
  registerConnectorWriteRoutes(app, {
    config,
    rawPgPool,
    connectorRepo,
    syncStatusRepo,
    connectorSecretsManager,
    emitEvent,
    auditWriter,
    authService,
    sessionPreHandler,
    oauthCommands,
  });

  // ── Sync / activate / backfill routes (manager+; backfill re-tightened to brand_admin+) ──
  registerConnectorBackfillSyncRoutes(app, {
    pool,
    connectorRepo,
    connectorSecretsManager,
    auditWriter,
    sessionPreHandler,
  });

  // ── Pixel routes (HIGH-MOUNT-01) ────────────────────────────────────────────
  registerConnectorPixelRoutes(app, {
    config,
    connectorRepo,
    connectorSecretsManager,
    pixelInstallationRepo,
    pixelStatusRepo,
    getOrCreateInstallation,
    emitEvent,
    sessionPreHandler,
  });
}
