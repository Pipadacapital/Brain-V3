/**
 * PixelInstallation — domain entity for pixel_installation.
 *
 * install_token = per-brand UUID embedded in the snippet (public, not a secret).
 * This entity represents the installation record, NOT the brain.js SDK.
 *
 * Scope note: The production brain.js pixel SDK (anon-id, session management,
 * UTM/click-ID capture, CNAME deployment) is the M1-data-spine deliverable,
 * NOT M1-app-foundation. See packages/pixel-sdk/src/index.ts for the scope comment.
 *
 * M1-app-foundation pixel = migration 006 + snippet endpoint + verify endpoint + status.
 */

export interface PixelInstallationProps {
  readonly id: string;
  readonly brandId: string;
  /** Per-brand tag identifier embedded in the snippet (public). NOT a secret. */
  readonly installToken: string;
  /** Host to verify (e.g. 'www.merchant.com'). Sourced from brand.domain. */
  readonly targetHost: string;
  /** Set after first-signal / verification success. */
  readonly installedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class PixelInstallation {
  readonly id: string;
  readonly brandId: string;
  readonly installToken: string;
  readonly targetHost: string;
  readonly installedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: PixelInstallationProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.installToken = props.installToken;
    this.targetHost = props.targetHost;
    this.installedAt = props.installedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: PixelInstallationProps): PixelInstallation {
    if (!props.targetHost || props.targetHost.trim() === '') {
      throw new Error('[PixelInstallation] targetHost must be non-empty');
    }
    return new PixelInstallation(props);
  }

  markInstalled(): PixelInstallation {
    return new PixelInstallation({
      ...this.toProps(),
      installedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  /** Build the snippet HTML to embed on the merchant's storefront. */
  buildSnippetHtml(ingestBaseUrl: string): string {
    return `<!-- Brain Pixel (M1 verification tag) -->
<script>
  window.__brain = { install_token: '${this.installToken}', brand_id: '${this.brandId}' };
</script>
<script src="${ingestBaseUrl}/pixel.js" defer></script>`;
  }

  toProps(): PixelInstallationProps {
    return {
      id: this.id,
      brandId: this.brandId,
      installToken: this.installToken,
      targetHost: this.targetHost,
      installedAt: this.installedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
