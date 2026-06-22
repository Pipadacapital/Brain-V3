/**
 * IConnector — the unified connector lifecycle contract.
 *
 * Every connector source (storefront/advertising/payment/logistics/checkout/marketplace/
 * messaging) implements this ONE interface. Adding a new provider costs 1x engineering — a new
 * IConnector implementation registered into the ConnectorFactory — never a per-source fork of the
 * lifecycle (Single-Primitive Rule + Open/Closed: extend by registering, never edit the kernel).
 *
 * The eight verbs are the full connector lifecycle:
 *   authenticate → validate → connect → (sync / backfill / webhook / health)* → disconnect
 *
 * All param/return types are NEUTRAL — built on the kernel entities. Provider-specific shapes
 * (Shopify HMAC, Razorpay credential bundle, ...) live behind the typed `params` generics of each
 * verb, supplied by the concrete connector, never leaking into this contract.
 *
 * NN-2: credentials never appear on the entity boundary — `connect` returns a ConnectorInstance
 * whose only credential field is `secretRef` (an ARN). Tokens never cross this contract.
 */
import type { ConnectorInstance } from '../domain/entities/ConnectorInstance.js';
import type { ConnectorSyncStatus } from '../domain/entities/ConnectorSyncStatus.js';

/** Result of an authentication exchange — yields the secret_ref (ARN), never the token (NN-2). */
export interface AuthResult {
  /** AWS Secrets Manager ARN where the obtained credential bundle was stored (NN-2). */
  readonly secretRef: string;
  /** Optional provider host/identifier resolved during auth (e.g. shop domain). */
  readonly host?: string;
}

/** Outcome of a credential/config validation check (cheap, side-effect-free where possible). */
export interface ValidationResult {
  readonly valid: boolean;
  /** Human-readable reason when `valid` is false. */
  readonly reason?: string;
}

/** A connector health probe result — maps onto the entity's HealthState/SafetyRating. */
export interface HealthResult {
  readonly state: ConnectorInstance['healthState'];
  readonly safety: ConnectorInstance['safetyRating'];
  /** Optional last-error / diagnostic string. */
  readonly detail?: string;
}

/**
 * The unified connector lifecycle.
 *
 * Type parameters let each concrete connector supply its provider-specific input shapes without
 * widening the contract:
 *   - TAuthParams    : provider auth input (OAuth code+state, or a credential bundle)
 *   - TConnectParams : provider connect input
 *   - TSyncParams    : incremental sync input (resource, cursor, ...)
 *   - TWebhookParams : raw webhook delivery (headers + body)
 */
export interface IConnector<
  TAuthParams = unknown,
  TConnectParams = unknown,
  TSyncParams = unknown,
  TWebhookParams = unknown,
> {
  /** The provider id this connector serves — matches a CONNECTOR_CATALOG entry. */
  readonly provider: string;

  /**
   * Exchange provider auth (OAuth code / credential bundle) for a stored secret_ref (ARN).
   * Persists the credential to the secrets manager; the token never crosses this boundary (NN-2).
   */
  authenticate(brandId: string, params: TAuthParams): Promise<AuthResult>;

  /** Validate credentials/config without mutating connection state (cheap pre-connect check). */
  validate(brandId: string, params: TAuthParams): Promise<ValidationResult>;

  /**
   * Establish the connection: create/activate the ConnectorInstance (status 'connected',
   * health 'Healthy', safety 'safe') and seed its sync status. Idempotent on (brand, provider).
   */
  connect(brandId: string, params: TConnectParams): Promise<ConnectorInstance>;

  /** Run an incremental sync for one resource; advances the cursor (I-ST04 idempotent). */
  sync(brandId: string, params: TSyncParams): Promise<ConnectorSyncStatus>;

  /** Run a historical backfill for the connection (bounded by the provider's window). */
  backfill(brandId: string, params: TSyncParams): Promise<ConnectorSyncStatus>;

  /** Handle a raw inbound webhook delivery (verify signature, map, emit). Idempotent. */
  webhook(brandId: string, params: TWebhookParams): Promise<void>;

  /** Probe live connection health (maps onto the entity's 7-state health / 3-state safety). */
  health(brandId: string): Promise<HealthResult>;

  /** Tear down the connection: flip the instance to disconnected/blocked (ADR-CM-5). */
  disconnect(brandId: string): Promise<ConnectorInstance>;
}
