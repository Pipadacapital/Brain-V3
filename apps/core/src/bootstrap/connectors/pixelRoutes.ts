/**
 * registerConnectorPixelRoutes — pixel read (analyst+) and write (manager+) routes.
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts (HIGH-MOUNT-01 pixel block).
 * Guards, response shapes, and side effects are byte-for-byte identical to the prior inline
 * registration.
 */
import { type FastifyInstance, type FastifyRequest, type preHandlerAsyncHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';

import { registerPixelInstallerRoutes, buildDefaultSnippet, isValidIngestHost } from '../../modules/connector/pixel/interfaces/http/pixelRoutes.js';
import { PixelInstallerRegistry } from '../../modules/connector/pixel/application/install/PixelInstaller.js';
import { ShopifyPixelInstaller } from '../../modules/connector/sources/storefront/shopify/application/install/ShopifyPixelInstaller.js';
import { WooCommercePixelInstaller } from '../../modules/connector/sources/storefront/woocommerce/application/install/WooCommercePixelInstaller.js';
import { InstallWooCommercePixelCommand } from '../../modules/connector/sources/storefront/woocommerce/application/commands/InstallWooCommercePixelCommand.js';
import { GetOrCreatePixelInstallationCommand } from '../../modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import { VerifyPixelCommand, PixelInstallationNotFoundError } from '../../modules/connector/pixel/application/commands/VerifyPixelCommand.js';
import { GetPixelHealthQuery } from '../../modules/connector/pixel/application/queries/GetPixelHealthQuery.js';
import type { PgPixelInstallationRepository } from '../../modules/connector/pixel/infrastructure/repositories/PgPixelInstallationRepository.js';
import type { PgPixelStatusRepository } from '../../modules/connector/pixel/infrastructure/repositories/PgPixelStatusRepository.js';
import { InstallPixelCommand, InstallPixelError } from '../../modules/connector/sources/storefront/shopify/application/commands/InstallPixelCommand.js';
import { UninstallPixelCommand, UninstallPixelError } from '../../modules/connector/sources/storefront/shopify/application/commands/UninstallPixelCommand.js';
import { ShopifyAdminClient } from '../../modules/connector/sources/storefront/shopify/infrastructure/api/ShopifyAdminClient.js';
import type { PgConnectorInstanceRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import { requireRole } from '../../modules/workspace-access/internal/security/rbac.js';
import type { EmitEvent } from '../../infrastructure/events/M1EventPublisher.js';

import { getBrandId, type ConnectorContextConfig } from './shared.js';

export interface RegisterConnectorPixelRoutesDeps {
  config: ConnectorContextConfig;
  connectorRepo: PgConnectorInstanceRepository;
  connectorSecretsManager: ISecretsManager;
  pixelInstallationRepo: PgPixelInstallationRepository;
  pixelStatusRepo: PgPixelStatusRepository;
  getOrCreateInstallation: GetOrCreatePixelInstallationCommand;
  emitEvent: EmitEvent;
  sessionPreHandler: preHandlerAsyncHookHandler;
}

export function registerConnectorPixelRoutes(app: FastifyInstance, deps: RegisterConnectorPixelRoutesDeps): void {
  const { config, connectorRepo, connectorSecretsManager, pixelInstallationRepo, pixelStatusRepo, getOrCreateInstallation, emitEvent, sessionPreHandler } = deps;

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
