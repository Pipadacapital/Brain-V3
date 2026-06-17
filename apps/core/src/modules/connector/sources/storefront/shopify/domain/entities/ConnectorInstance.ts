/**
 * ConnectorInstance — domain entity representing a connector store connection.
 *
 * NN-2 INVARIANT: `secret_ref` is the ONLY credential field.
 * There is intentionally no `oauth_token`, `access_token`, `*_ciphertext`,
 * `*_secret`, or `*_key` field on this entity. The Secrets Manager ARN is
 * the sole reference; the token never crosses the domain boundary.
 *
 * ADR-CM-5: health_state (7-state) + safety_rating (3-state) added in 0021_connector_health.
 */

export type ConnectorStatus = 'connected' | 'disconnected' | 'error';

/** 7-state health model (migration 0021, ADR-CM-5). Column is persisted truth. */
export type HealthState =
  | 'Healthy'
  | 'Delayed'
  | 'Failed'
  | 'Disconnected'
  | 'RateLimited'
  | 'TokenExpired'
  | 'Disabled';

/** 3-state recommendation safety (ADR-CM-5). Derived from health_state via TS lookup. */
export type SafetyRating = 'safe' | 'degraded' | 'blocked';

export interface ConnectorInstanceProps {
  readonly id: string;
  readonly brandId: string;
  readonly provider: string;
  readonly shopDomain: string;
  /** AWS Secrets Manager ARN — the ONLY credential reference (NN-2 / I-S09). */
  readonly secretRef: string;
  readonly status: ConnectorStatus;
  /** 7-state health (ADR-CM-5). On connect → 'Healthy'; on disconnect → 'Disconnected'. */
  readonly healthState: HealthState;
  /** 3-state recommendation safety (ADR-CM-5). On connect → 'safe'; on disconnect → 'blocked'. */
  readonly safetyRating: SafetyRating;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ConnectorInstance {
  readonly id: string;
  readonly brandId: string;
  readonly provider: string;
  readonly shopDomain: string;
  /** AWS Secrets Manager ARN. Never a plaintext token (NN-2). */
  readonly secretRef: string;
  readonly status: ConnectorStatus;
  /** 7-state health (ADR-CM-5 / migration 0021). */
  readonly healthState: HealthState;
  /** 3-state recommendation safety (ADR-CM-5). */
  readonly safetyRating: SafetyRating;
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
    this.healthState = props.healthState;
    this.safetyRating = props.safetyRating;
    this.connectedAt = props.connectedAt;
    this.disconnectedAt = props.disconnectedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ConnectorInstanceProps): ConnectorInstance {
    // Validate shop domain format (must be *.myshopify.com per NN-4) — Shopify only.
    // Credential connectors (future) may have an empty shop_domain.
    if (props.shopDomain && !ConnectorInstance.isValidShopDomain(props.shopDomain)) {
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

  /**
   * Disconnect: flip status to disconnected, health_state to Disconnected, safety_rating to blocked.
   * ADR-CM-5: connect⇒Healthy/safe, disconnect⇒Disconnected/blocked.
   */
  disconnect(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'disconnected',
      healthState: 'Disconnected',
      safetyRating: 'blocked',
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  markError(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'error',
      healthState: 'Failed',
      safetyRating: 'blocked',
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
      healthState: this.healthState,
      safetyRating: this.safetyRating,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
