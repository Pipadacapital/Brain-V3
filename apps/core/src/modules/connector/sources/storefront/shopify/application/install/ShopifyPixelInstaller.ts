/**
 * ShopifyPixelInstaller — registers Shopify in the storefront-agnostic PixelInstallerRegistry by
 * adapting the existing InstallPixelCommand / UninstallPixelCommand (which are untouched). Maps the
 * Shopify-specific checkout Web-Pixel status into the uniform outcome's `meta.webPixel`.
 */
import type {
  PixelInstaller,
  PixelInstallInput,
  PixelInstallOutcome,
  PixelUninstallInput,
  PixelUninstallOutcome,
} from '../../../../../pixel/application/install/PixelInstaller.js';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { InstallPixelCommand } from '../commands/InstallPixelCommand.js';
import type { UninstallPixelCommand } from '../commands/UninstallPixelCommand.js';

export class ShopifyPixelInstaller implements PixelInstaller {
  readonly provider = 'shopify';
  readonly displayName = 'Shopify';

  constructor(
    private readonly installCmd: InstallPixelCommand,
    private readonly uninstallCmd: UninstallPixelCommand,
    private readonly connectorRepo: IConnectorInstanceRepository,
  ) {}

  async isAvailable(brandId: string): Promise<boolean> {
    const conn = await this.connectorRepo.findByBrandAndProvider(brandId, 'shopify');
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
      meta: { webPixel: r.webPixel },
    };
  }

  async uninstall(input: PixelUninstallInput): Promise<PixelUninstallOutcome> {
    const r = await this.uninstallCmd.execute(input);
    return { removed: r.removed > 0, provider: this.provider, alreadyAbsent: r.alreadyAbsent };
  }
}
