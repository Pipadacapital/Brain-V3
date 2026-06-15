/**
 * ConnectorInstance — domain entity representing a Shopify store connection.
 *
 * NN-2 INVARIANT: `secret_ref` is the ONLY credential field.
 * There is intentionally no `oauth_token`, `access_token`, `*_ciphertext`,
 * `*_secret`, or `*_key` field on this entity. The Secrets Manager ARN is
 * the sole reference; the token never crosses the domain boundary.
 */

export type ConnectorStatus = 'connected' | 'disconnected' | 'error';

export interface ConnectorInstanceProps {
  readonly id: string;
  readonly brandId: string;
  readonly provider: 'shopify';
  readonly shopDomain: string;
  /** AWS Secrets Manager ARN — the ONLY credential reference (NN-2 / I-S09). */
  readonly secretRef: string;
  readonly status: ConnectorStatus;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ConnectorInstance {
  readonly id: string;
  readonly brandId: string;
  readonly provider: 'shopify';
  readonly shopDomain: string;
  /** AWS Secrets Manager ARN. Never a plaintext token (NN-2). */
  readonly secretRef: string;
  readonly status: ConnectorStatus;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: ConnectorInstanceProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.provider = props.provider;
    this.shopDomain = props.shopDomain;
    this.secretRef = props.secretRef;
    this.status = props.status;
    this.connectedAt = props.connectedAt;
    this.disconnectedAt = props.disconnectedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ConnectorInstanceProps): ConnectorInstance {
    // Validate shop domain format (must be *.myshopify.com per NN-4)
    if (!ConnectorInstance.isValidShopDomain(props.shopDomain)) {
      throw new Error(
        `[ConnectorInstance] Invalid shop_domain "${props.shopDomain}": must match *.myshopify.com`,
      );
    }

    // Validate secret_ref is present and non-empty (NN-2)
    if (!props.secretRef || props.secretRef.trim() === '') {
      throw new Error('[ConnectorInstance] secret_ref must be a non-empty Secrets Manager ARN (NN-2)');
    }

    return new ConnectorInstance(props);
  }

  /**
   * Validate shop domain: must be *.myshopify.com (NN-4).
   */
  static isValidShopDomain(shopDomain: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain);
  }

  disconnect(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'disconnected',
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  markError(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'error',
      updatedAt: new Date(),
    });
  }

  toProps(): ConnectorInstanceProps {
    return {
      id: this.id,
      brandId: this.brandId,
      provider: this.provider,
      shopDomain: this.shopDomain,
      secretRef: this.secretRef,
      status: this.status,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
