/**
 * registerConnectorReadRoutes — connector read routes (analyst+).
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts (the analyst+ read scope:
 * GET /api/v1/connectors and GET /api/v1/connectors/:id/status). Behavior, guards, and
 * response shapes are byte-for-byte identical to the prior inline registration.
 */
import { type FastifyInstance, type FastifyRequest, type preHandlerAsyncHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';

import { isAdPlatformProvider } from '@brain/connector-core';
import { loadCoreConfig } from '@brain/config';

import { CONNECTOR_CATALOG } from '../../modules/connector/catalog/index.js';
import type { ConnectorDefinition } from '../../modules/connector/catalog/registry.js';
import { GetConnectorStatusQuery } from '../../modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.js';
import type { PgConnectorInstanceRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { PgConnectorSyncStatusRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import { requireRole } from '../../modules/workspace-access/internal/security/rbac.js';

import { getBrandId } from './shared.js';

export interface RegisterConnectorReadRoutesDeps {
  connectorRepo: PgConnectorInstanceRepository;
  syncStatusRepo: PgConnectorSyncStatusRepository;
  sessionPreHandler: preHandlerAsyncHookHandler;
}

/**
 * A connector receives inbound webhooks if the catalog declares a routing header
 * or mints/accepts a `webhook_secret`. Its delivery URL + routing header are NOT
 * secret, so we surface them on every read (not just the one-time connect
 * response) — otherwise a merchant who didn't copy the URL at connect time could
 * never retrieve it. The `webhook_secret` (X-Api-Key) is minted once and stays
 * secret; only the URL/header are echoed here.
 */
function connectorHasWebhook(def: ConnectorDefinition): boolean {
  const cc = def.credentialConnect;
  return Boolean(
    cc?.webhookRoutingHeader ||
      cc?.generatedSecretFields?.includes('webhook_secret') ||
      def.authFields?.some((f) => f.key === 'webhook_secret'),
  );
}

export function registerConnectorReadRoutes(app: FastifyInstance, deps: RegisterConnectorReadRoutesDeps): void {
  const { connectorRepo, syncStatusRepo, sessionPreHandler } = deps;

  const getConnectorStatus = new GetConnectorStatusQuery(connectorRepo, syncStatusRepo);

  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('analyst'));

    scope.get('/api/v1/connectors', async (req, reply) => {
      const brandId = getBrandId(req);
      const requestId = (req.id as string) ?? randomUUID();
      const instances = await connectorRepo.findAllByBrand(brandId);
      const webhookBase = loadCoreConfig().BRAIN_WEBHOOK_BASE_URL.replace(/\/+$/, '');

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
            // 0106: ad-account activation. is_active = this is the chosen ingesting account.
            // requires_activation = an ad platform whose account has not been picked yet (the UI
            // shows a "select an account" prompt + Activate controls).
            activated_at: inst.activatedAt ? inst.activatedAt.toISOString() : null,
            is_active: isAdPlatformProvider(inst.provider) ? inst.isActive : true,
            requires_activation: isAdPlatformProvider(inst.provider) && !inst.isActive,
          };
        };

        return {
          id: def.id,
          category: def.category,
          display_name: def.displayName,
          description: def.description,
          connect_method: def.connectMethod as 'oauth' | 'credential' | 'coming_soon',
          available: def.availability === 'available',
          // The declarative credential/auth fields the marketplace form renders (single SoR — the
          // catalog). secret fields render as masked password inputs and are never echoed back.
          auth_fields: (def.authFields ?? []).map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            secret: f.secret,
            optional: f.optional ?? false,
            hint: f.hint ?? null,
          })),
          instance: firstInstance ? toInstanceShape(firstInstance) : null,
          instances: activeInstances.map(toInstanceShape),
          // Always-visible webhook target for webhook connectors (the URL is not
          // a secret; the X-Api-Key is shown only once at connect). routing_header
          // name is the catalog value; its value per account is the instance's
          // account_key (already on each instance above).
          webhook: connectorHasWebhook(def)
            ? {
                url: `${webhookBase}/api/v1/webhooks/${def.id}`,
                routing_header_name: def.credentialConnect?.webhookRoutingHeader ?? null,
              }
            : null,
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
}
