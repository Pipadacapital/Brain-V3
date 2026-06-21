/**
 * InstallPixelCommand — the production pixel-install path: auto-inject the Brain pixel onto the
 * brand's connected Shopify storefront via the Admin API and flip pixel_installation.installed_at.
 * No manual snippet paste.
 *
 * Mechanism (feat-pixel-production-install): ScriptTag API now (online-store coverage, verifiable
 * with the existing OAuth token + write_script_tags scope). The Web Pixels API path (checkout +
 * storefront coverage) is laid in ShopifyAdminClient.webPixelCreate + extensions/brain-web-pixel,
 * activated once the app's web-pixel extension is deployed.
 *
 * Idempotent: if a Brain ScriptTag already points at our pixel asset, reuse it (no duplicate).
 * SECURITY: the Shopify token (from secretRef) is used only for the API call, never logged (I-S09).
 */
import type { ISecretsManager } from '@brain/connector-secrets';
import { log } from '../../../../../../../log.js';
import { ShopifyAdminClient, ShopifyApiError } from '../../infrastructure/api/ShopifyAdminClient.js';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { GetOrCreatePixelInstallationCommand } from '../../../../../pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import type { IPixelInstallationRepository } from '../../../../../pixel/domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../../../../pixel/domain/repositories/IPixelStatusRepository.js';

/** Stable error codes the route maps to HTTP + user-facing copy. */
export type InstallPixelErrorCode =
  | 'STOREFRONT_NOT_CONNECTED'
  | 'RECONNECT_REQUIRED'
  | 'RECONNECT_REQUIRED_SCOPE';

export class InstallPixelError extends Error {
  constructor(public readonly code: InstallPixelErrorCode, message: string) {
    super(message);
    this.name = 'InstallPixelError';
  }
}

export interface InstallPixelInput {
  brandId: string;
  idempotencyKey: string;
}

export interface InstallPixelResult {
  installed: true;
  provider: 'shopify_script_tag';
  /** Shopify ScriptTag id (provider-side handle). */
  ref: string;
  installToken: string;
  /** The injected pixel src (no secrets). */
  src: string;
  /** True when a Brain ScriptTag was already present (idempotent re-run). */
  alreadyPresent: boolean;
}

export class InstallPixelCommand {
  constructor(
    private readonly connectorInstanceRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly getOrCreateInstallation: GetOrCreatePixelInstallationCommand,
    private readonly pixelInstallationRepo: IPixelInstallationRepository,
    private readonly pixelStatusRepo: IPixelStatusRepository,
    private readonly ingestBaseUrl: string,
    /** Injectable for tests; defaults to the real Admin client. */
    private readonly makeClient: (shopDomain: string, token: string) => ShopifyAdminClient = (d, t) =>
      new ShopifyAdminClient(d, t),
  ) {}

  async execute(input: InstallPixelInput): Promise<InstallPixelResult> {
    const { brandId, idempotencyKey } = input;

    // 1. The brand must have a CONNECTED Shopify storefront (the pixel injects onto it).
    const conn = await this.connectorInstanceRepo.findByBrandAndProvider(brandId, 'shopify');
    if (!conn || conn.status !== 'connected') {
      throw new InstallPixelError(
        'STOREFRONT_NOT_CONNECTED',
        'Connect a Shopify storefront before auto-installing the pixel.',
      );
    }

    // 2. Resolve the OAuth token (I-S09: never logged).
    const token = await this.secretsManager.getShopifyToken(conn.secretRef);
    if (!token) {
      throw new InstallPixelError(
        'RECONNECT_REQUIRED',
        'Shopify token missing — reconnect the storefront and try again.',
      );
    }

    // 3. Ensure the pixel installation exists → install_token (idempotent on brand_id).
    const inst = await this.getOrCreateInstallation.execute({
      brandId,
      targetHost: conn.shopDomain,
      idempotencyKey,
    });

    // 4. Per-brand tokenized src — the ScriptTag-injected asset self-configures from the query
    //    string (no window.__brain available when injected by a ScriptTag).
    const src = `${this.ingestBaseUrl}/pixel.js?t=${inst.installToken}&b=${brandId}`;

    // 5/6. Idempotency: reuse an existing Brain ScriptTag if present; else create one.
    const client = this.makeClient(conn.shopDomain, token);
    let ref: string;
    let alreadyPresent = false;
    try {
      const existing = (await client.listScriptTags()).find((s) => s.src.includes('/pixel.js'));
      if (existing) {
        ref = String(existing.id);
        alreadyPresent = true;
      } else {
        const created = await client.createScriptTag(src);
        ref = String(created.id);
      }
    } catch (err) {
      if (err instanceof ShopifyApiError && (err.status === 403 || err.status === 401)) {
        throw new InstallPixelError(
          'RECONNECT_REQUIRED_SCOPE',
          'Reconnect Shopify to grant pixel-install permission (write_script_tags), then retry.',
        );
      }
      throw err;
    }

    // 7. Flip installed_at + record the provider handle (idempotent — keeps original install time).
    await this.pixelInstallationRepo.markAutoInstalled(brandId, 'shopify_script_tag', ref);

    // 8. We verifiably placed the pixel → mark the status verified/connected for the UI.
    const status = await this.pixelStatusRepo.findByInstallationId(inst.installationId, brandId);
    if (status) await this.pixelStatusRepo.update(status.markVerified());

    log.info(
      `[InstallPixelCommand] pixel auto-installed brand=${brandId} provider=shopify_script_tag ` +
        `ref=${ref} alreadyPresent=${alreadyPresent} shop=${conn.shopDomain}`,
    );
    return { installed: true, provider: 'shopify_script_tag', ref, installToken: inst.installToken, src, alreadyPresent };
  }
}
