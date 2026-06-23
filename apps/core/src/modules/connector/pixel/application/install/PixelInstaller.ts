/**
 * PixelInstaller — the storefront-agnostic pixel-install abstraction.
 *
 * WHY: the SAME served pixel.js runs on every storefront (it hooks generic browser APIs), but the
 * MECHANISM to place it differs per platform — Shopify uses the ScriptTag API, WooCommerce uses a
 * plugin + REST config, a custom store uses a pasted snippet, and future platforms (BigCommerce,
 * Magento, Wix, Squarespace, headless…) each have their own. This strategy + registry lets a new
 * storefront be added as ONE self-contained installer that registers itself — with ZERO changes to
 * existing installers, the generic route, or the UI (which renders from the registry). That is the
 * "add a storefront without touching existing functionality" contract.
 *
 * Every installer returns the SAME PixelInstallOutcome shape; provider-specific extras (Shopify's
 * checkout Web-Pixel status, WooCommerce's plugin version) ride in `meta` so the envelope never
 * needs to grow per provider.
 */

export interface PixelInstallInput {
  brandId: string;
  idempotencyKey: string;
}

export interface PixelUninstallInput {
  brandId: string;
}

/** Uniform install result across all storefronts. Provider-specific detail lives in `meta`. */
export interface PixelInstallOutcome {
  installed: boolean;
  /** The storefront provider key (shopify | woocommerce | …). */
  provider: string;
  /** Provider-side handle (Shopify ScriptTag id, WooCommerce site URL, …). */
  ref: string;
  installToken: string;
  /** The injected pixel src (no secrets). */
  src: string;
  /** True when this exact install was already in place (idempotent re-run). */
  alreadyPresent: boolean;
  /** Provider-specific extras (e.g. { webPixel }, { pluginVersion }). Surfaced verbatim to the UI. */
  meta?: Record<string, unknown>;
}

export interface PixelUninstallOutcome {
  removed: boolean;
  provider: string;
  alreadyAbsent: boolean;
}

/**
 * One installer per storefront platform. Stateless; resolves everything from brandId.
 * `code` is the stable error-code namespace an installer throws (mapped to HTTP by the route);
 * installers throw their own typed errors carrying a `.code` string.
 */
export interface PixelInstaller {
  /** Stable provider key — the URL segment in POST /api/v1/pixel/install/:provider. */
  readonly provider: string;
  /** Human label for the UI button ("Shopify", "WooCommerce"). */
  readonly displayName: string;
  /**
   * Does this brand have the prerequisite connection for this installer? Drives whether the UI
   * offers the button. Cheap check (a single connector lookup); never throws.
   */
  isAvailable(brandId: string): Promise<boolean>;
  /** Place the pixel on the storefront. Throws a typed error (with `.code`) on a precondition gap. */
  install(input: PixelInstallInput): Promise<PixelInstallOutcome>;
  /** Remove the pixel (optional — not every platform supports programmatic removal). */
  uninstall?(input: PixelUninstallInput): Promise<PixelUninstallOutcome>;
}

/** Lightweight descriptor returned to the UI by GET /api/v1/pixel/installers. */
export interface PixelInstallerDescriptor {
  provider: string;
  displayName: string;
  available: boolean;
  supportsUninstall: boolean;
}

/**
 * PixelInstallerRegistry — the single place storefront installers register. The route + UI read
 * from here, so adding a storefront is `registry.register(new XInstaller(...))` and nothing else.
 */
export class PixelInstallerRegistry {
  private readonly installers = new Map<string, PixelInstaller>();

  register(installer: PixelInstaller): this {
    if (this.installers.has(installer.provider)) {
      throw new Error(`PixelInstaller already registered for provider "${installer.provider}"`);
    }
    this.installers.set(installer.provider, installer);
    return this;
  }

  get(provider: string): PixelInstaller | undefined {
    return this.installers.get(provider);
  }

  list(): PixelInstaller[] {
    return [...this.installers.values()];
  }

  /** Descriptors for the UI, with per-brand availability resolved concurrently. */
  async describeForBrand(brandId: string): Promise<PixelInstallerDescriptor[]> {
    return Promise.all(
      this.list().map(async (i) => ({
        provider: i.provider,
        displayName: i.displayName,
        available: await i.isAvailable(brandId).catch(() => false),
        supportsUninstall: typeof i.uninstall === 'function',
      })),
    );
  }
}
