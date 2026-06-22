/**
 * UninstallPixelCommand — the production pixel-removal path: delete the Brain ScriptTag(s) from the
 * brand's connected Shopify storefront via the Admin API and clear pixel_installation install state.
 *
 * The inverse of InstallPixelCommand. Idempotent: removing when nothing is installed succeeds with
 * removed=0 (alreadyAbsent=true). Best-effort per tag — a 404 (already gone) is treated as success by
 * the client. SECURITY: the Shopify token (from secretRef) is used only for the API call, never logged.
 */
import type { ISecretsManager } from '@brain/connector-secrets';
import { log } from '../../../../../../../log.js';
import { ShopifyAdminClient, ShopifyApiError } from '../../infrastructure/api/ShopifyAdminClient.js';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { IPixelInstallationRepository } from '../../../../../pixel/domain/repositories/IPixelInstallationRepository.js';

/** Stable error codes the route maps to HTTP + user-facing copy. */
export type UninstallPixelErrorCode =
  | 'STOREFRONT_NOT_CONNECTED'
  | 'RECONNECT_REQUIRED'
  | 'RECONNECT_REQUIRED_SCOPE';

export class UninstallPixelError extends Error {
  constructor(public readonly code: UninstallPixelErrorCode, message: string) {
    super(message);
    this.name = 'UninstallPixelError';
  }
}

export interface UninstallPixelInput {
  brandId: string;
}

export interface UninstallPixelResult {
  removed: number;
  /** True when there was nothing to remove (no Brain ScriptTag present). */
  alreadyAbsent: boolean;
}

export class UninstallPixelCommand {
  constructor(
    private readonly connectorInstanceRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly pixelInstallationRepo: IPixelInstallationRepository,
    /** Injectable for tests; defaults to the real Admin client. */
    private readonly makeClient: (shopDomain: string, token: string) => ShopifyAdminClient = (d, t) =>
      new ShopifyAdminClient(d, t),
  ) {}

  async execute(input: UninstallPixelInput): Promise<UninstallPixelResult> {
    const { brandId } = input;

    // 1. The brand must have a CONNECTED Shopify storefront (the pixel was injected onto it).
    const conn = await this.connectorInstanceRepo.findByBrandAndProvider(brandId, 'shopify');
    if (!conn || conn.status !== 'connected') {
      throw new UninstallPixelError(
        'STOREFRONT_NOT_CONNECTED',
        'Connect a Shopify storefront before removing the pixel.',
      );
    }

    // 2. Resolve the OAuth token (never logged).
    const token = await this.secretsManager.getShopifyToken(conn.secretRef);
    if (!token) {
      throw new UninstallPixelError(
        'RECONNECT_REQUIRED',
        'Shopify token missing — reconnect the storefront and try again.',
      );
    }

    // 3. Delete every Brain-owned ScriptTag (those pointing at our pixel asset). Idempotent.
    const client = this.makeClient(conn.shopDomain, token);
    let removed = 0;
    try {
      const brainTags = (await client.listScriptTags()).filter((s) => s.src.includes('/pixel.js'));
      for (const tag of brainTags) {
        await client.deleteScriptTag(tag.id);
        removed += 1;
      }
    } catch (err) {
      if (err instanceof ShopifyApiError && (err.status === 403 || err.status === 401)) {
        throw new UninstallPixelError(
          'RECONNECT_REQUIRED_SCOPE',
          'Reconnect Shopify to grant pixel permission (write_script_tags), then retry.',
        );
      }
      throw err;
    }

    // 4. Clear the install markers so the UI reflects "not installed" (idempotent, RLS-scoped).
    await this.pixelInstallationRepo.clearAutoInstall(brandId);

    log.info(
      `[UninstallPixelCommand] pixel removed brand=${brandId} provider=shopify_script_tag ` +
        `removed=${removed} shop=${conn.shopDomain}`,
    );
    return { removed, alreadyAbsent: removed === 0 };
  }
}
