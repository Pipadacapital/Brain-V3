/**
 * WooCommercePixelInstaller — registers WooCommerce in the storefront-agnostic PixelInstallerRegistry
 * by adapting InstallWooCommercePixelCommand. Maps the plugin version into `meta.pluginVersion`.
 *
 * Adding this storefront required NO change to the Shopify installer, the registry, the generic
 * route, or the UI — it just registers itself (the extensibility contract in PixelInstaller.ts).
 */
import type {
  PixelInstaller,
  PixelInstallInput,
  PixelInstallOutcome,
} from '../../../../../pixel/application/install/PixelInstaller.js';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { InstallWooCommercePixelCommand } from '../commands/InstallWooCommercePixelCommand.js';

export class WooCommercePixelInstaller implements PixelInstaller {
  readonly provider = 'woocommerce';
  readonly displayName = 'WooCommerce';

  constructor(
    private readonly installCmd: InstallWooCommercePixelCommand,
    private readonly connectorRepo: IConnectorInstanceRepository,
  ) {}

  async isAvailable(brandId: string): Promise<boolean> {
    const conn = await this.connectorRepo.findByBrandAndProvider(brandId, 'woocommerce');
    return !!conn && conn.status === 'connected';
  }

  async install(input: PixelInstallInput): Promise<PixelInstallOutcome> {
    const r = await this.installCmd.execute(input);
    return {
      installed: r.installed,
      provider: this.provider,
      ref: r.ref,
      installToken: r.installToken,
      src: r.src,
      alreadyPresent: r.alreadyPresent,
      meta: { pluginVersion: r.pluginVersion },
    };
  }
}
