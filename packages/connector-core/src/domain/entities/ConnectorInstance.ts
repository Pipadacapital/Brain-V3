/**
 * ConnectorInstance — provider-AGNOSTIC domain entity for a connector store connection.
 *
 * This is the neutral connector kernel entity (@brain/connector-core). It is the SINGLE
 * source of truth for every connector source (storefront/advertising/payment/logistics/
 * checkout/marketplace/messaging) — the Single-Primitive Rule applied to the connector base.
 *
 * NN-2 INVARIANT: `secret_ref` is the ONLY credential field.
 * There is intentionally no `oauth_token`, `access_token`, `*_ciphertext`,
 * `*_secret`, or `*_key` field on this entity. The Secrets Manager ARN is
 * the sole reference; the token never crosses the domain boundary.
 *
 * ADR-CM-5: health_state (7-state) + safety_rating (3-state) added in 0021_connector_health.
 *
 * HOST VALIDATION: this kernel entity does NOT hardcode any provider-specific host rule.
 * The Shopify `*.myshopify.com` rule moved INTO the Shopify connector
 * (sources/storefront/shopify/domain/ShopifyHostPolicy). A provider that needs host
 * validation passes an optional `hostValidator` strategy hook to `create`; providers that
 * have no host concept simply omit it (Open/Closed — new providers extend, never edit here).
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

/**
 * Optional provider-supplied host-validation strategy (Strategy pattern).
 * Returns true if the given (non-empty) host string is valid for the provider.
 * When omitted, no host validation is performed (credential connectors with no host).
 */
export type HostValidator = (host: string) => boolean;

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

  /**
   * Construct a valid ConnectorInstance (Factory — invariants at birth).
   *
   * @param props          the connector instance properties
   * @param hostValidator  OPTIONAL provider-supplied host-validation strategy. When provided
   *                       AND shopDomain is non-empty, the host MUST satisfy it or this throws.
   *                       Omit for credential connectors that have no host concept.
   */
  static create(props: ConnectorInstanceProps, hostValidator?: HostValidator): ConnectorInstance {
    // Provider-agnostic host validation: only enforced when a strategy is supplied AND a host
    // is present. The kernel knows NO provider-specific host rule (the Shopify rule lives in
    // the Shopify connector). Credential connectors pass shopDomain='' and no validator.
    if (props.shopDomain && hostValidator && !hostValidator(props.shopDomain)) {
      throw new Error(
        `[ConnectorInstance] Invalid host "${props.shopDomain}" for provider "${props.provider}"`,
      );
    }

    // Validate secret_ref is present and non-empty (NN-2)
    if (!props.secretRef || props.secretRef.trim() === '') {
      throw new Error('[ConnectorInstance] secret_ref must be a non-empty Secrets Manager ARN (NN-2)');
    }

    return new ConnectorInstance(props);
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
