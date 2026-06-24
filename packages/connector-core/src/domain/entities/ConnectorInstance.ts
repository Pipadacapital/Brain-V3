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

/**
 * Sentinel account key for single-account connectors (Gap B — multi-account-per-provider).
 * Every connector instance has an account_key; single-account connectors use this sentinel.
 */
export const DEFAULT_ACCOUNT_KEY = '__default__' as const;

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
  /**
   * Per-account key within a provider (Gap B — multi-account-per-provider, migration 0092).
   * Defaults to DEFAULT_ACCOUNT_KEY ('__default__') for single-account connectors.
   * Optional for backward compat — callers that omit it get the sentinel default.
   */
  readonly accountKey?: string;
  /**
   * Provider-specific config blob (Gap A — data-driven discovery, migration 0091).
   * Populated by connect commands; consumed by list_connectors_for_repull fn.
   * Optional for backward compat.
   */
  readonly providerConfig?: Record<string, string | null>;
  /**
   * Ad-account activation marker (migration 0106). NULL = discovered-but-not-ingesting; a Date =
   * the chosen account that ingests. Exactly one active per (brand, ad-platform provider). Only
   * meaningful for ad-platform providers (meta/google_ads/…); storefront + payment connectors
   * ignore it and always ingest when status='connected'. Optional for backward compat.
   */
  readonly activatedAt?: Date | null;
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
  /** Account key within provider (Gap B). Defaults to DEFAULT_ACCOUNT_KEY. */
  readonly accountKey: string;
  /** Provider-specific config blob (Gap A). */
  readonly providerConfig: Record<string, string | null>;
  /** Ad-account activation marker (0106). null = not the chosen account; a Date = active. */
  readonly activatedAt: Date | null;

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
    this.accountKey = props.accountKey ?? DEFAULT_ACCOUNT_KEY;
    this.providerConfig = props.providerConfig ?? {};
    this.activatedAt = props.activatedAt ?? null;
  }

  /** True iff this ad account is the activated (ingesting) one. */
  get isActive(): boolean {
    return this.activatedAt !== null;
  }

  /**
   * Activate this account (it becomes the ingesting one). Pure — returns a new instance; the
   * sibling-deactivation switch (exactly one active per brand+provider) is enforced at the
   * repository/command layer in a single transaction. Re-activating is idempotent (keeps the
   * original activated_at so the watermark/ordering is stable).
   */
  activate(): ConnectorInstance {
    if (this.activatedAt !== null) return this;
    return new ConnectorInstance({
      ...this.toProps(),
      activatedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  /** Deactivate this account (stops ingesting; the OAuth connection stays connected). Pure. */
  deactivate(): ConnectorInstance {
    if (this.activatedAt === null) return this;
    return new ConnectorInstance({
      ...this.toProps(),
      activatedAt: null,
      updatedAt: new Date(),
    });
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

  /**
   * Token expired (401/invalid-token on any API call).
   * ADR-CM-5: token-expiry → TokenExpired/blocked; status stays 'error' not 'disconnected'
   * (the underlying connection was not intentionally closed — the credential was rejected).
   * Pure — returns a new instance; does NOT persist.
   */
  markTokenExpired(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'error',
      healthState: 'TokenExpired',
      safetyRating: 'blocked',
      updatedAt: new Date(),
    });
  }

  /**
   * Rate-limited (429/throttle on any API call).
   * ADR-CM-5: rate-limit → RateLimited/degraded; status 'error' (data is stale, not blocked completely).
   * safetyRating 'degraded' (not 'blocked') — the connector auth is valid but data may be stale.
   * Pure — returns a new instance; does NOT persist.
   */
  markRateLimited(): ConnectorInstance {
    return new ConnectorInstance({
      ...this.toProps(),
      status: 'error',
      healthState: 'RateLimited',
      safetyRating: 'degraded',
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
      accountKey: this.accountKey,
      providerConfig: this.providerConfig,
      activatedAt: this.activatedAt,
    };
  }
}
