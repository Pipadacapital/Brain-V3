/**
 * IWebhookStrategy — per-provider webhook strategy interface (Strategy pattern).
 *
 * The WebhookPipeline (Template Method) calls these two methods; the strategy
 * provides ONLY the provider-specific parts:
 *   1. signatureVerify: extract the lookup key from raw bytes/headers + verify HMAC.
 *   2. payloadMap: parse + map the provider payload to a CollectorEventV1-ready shape.
 *
 * All common steps (raw body capture, age gate, dedup, brand resolve, Kafka produce,
 * raw archive write, sync_status touch) are done by the pipeline, not the strategy.
 *
 * SECURITY: signatureVerify is called FIRST, before any write or DB touch (NN-4).
 */

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

/**
 * The minimal Neo4j identity-reader surface a webhook side-effect needs (GDPR redact). Structural so the
 * webhook layer stays loosely coupled to the identity module.
 */
export interface WebhookIdentityReader {
  resolveBrainIdByStorefrontCustomerId(brandId: string, storefrontHash: string): Promise<string | null>;
  eraseCustomer(brandId: string, brainId: string): Promise<{ erased: boolean; contact_pii_deleted: number; links_tombstoned: number }>;
}

/**
 * Result of a successful signatureVerify call.
 * The lookupKey is provider-specific (shopDomain, accountId, merchantId, siteUrl) and
 * is used as the argument to the brand-resolution DB function. It is NOT the brand_id.
 */
export interface SignatureVerifyResult {
  /** Provider-specific lookup key for brand resolution (NOT brand_id). */
  lookupKey: string;
  /**
   * Parsed payload — returned here for providers that must parse the body early
   * to extract the lookup key (e.g. Razorpay parses JSON for account_id).
   * null for providers where the lookup key is in a header (e.g. Shopify, WooCommerce).
   */
  parsedPayload: unknown;
}

/**
 * Result of a successful payloadMap call.
 */
export interface PayloadMapResult {
  /** CollectorEventV1-compatible event_id (deterministic per state-change). */
  eventId: string;
  /** Canonical event name (e.g. 'order.live.v1'). */
  eventName: string;
  /** ISO-8601 occurred_at (from the provider event or derived). */
  occurredAt: string;
  /** Mapped + PII-hashed properties for the CollectorEventV1 envelope. */
  properties: Record<string, unknown>;
  /**
   * Provider-level dedup timestamp in Unix seconds for the age gate.
   * null = provider does not supply a timestamp (skip age gate for this provider).
   */
  ageCheckTimestampSeconds: number | null;
  /**
   * Provider-level dedup key (may differ from eventId for providers that compute
   * a deterministic key from payload fields, e.g. Shopflo's uuidV5(brand,checkout,occurred)).
   * When null, eventId is used as the dedup key.
   */
  dedupKey: string | null;
  /**
   * true if this event type should be skipped (fast-ack 200 without Kafka produce).
   * Used for non-order topics (Shopify's app/uninstalled etc.) and unknown event types.
   */
  skip: boolean;
  /**
   * Optional: extra provider-specific side-effect fn (e.g. Razorpay's map-table upsert,
   * Shopify's cart-stitch upsert). Runs AFTER successful Kafka produce + BEFORE sync touch.
   * Fire-and-forget semantics (errors logged, not re-thrown) unless throwOnError is true.
   */
  sideEffect?: (
    brandId: string,
    rawPgPool: pg.Pool,
    requestId: string,
    // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the Neo4j identity reader — for GDPR redact
    // (resolve brain_id + erase) now that identity is the Neo4j SoR.
    identityReader?: WebhookIdentityReader,
  ) => Promise<void>;
  /**
   * If true, a sideEffect error returns 500 (not fire-and-forget).
   * Razorpay uses this for the map-table upsert (MB-1 HARD prerequisite).
   */
  throwOnSideEffectError?: boolean;
}

export interface WebhookStrategyContext {
  /** Raw request body Buffer (always non-null when called — pipeline guards this). */
  rawBody: Buffer;
  /** All request headers (Fastify lowercased). */
  headers: FastifyRequest['headers'];
  /** Parsed JSON body (may be null for strategies that parse inside signatureVerify). */
  parsedBody: unknown;
  /** brand_id resolved from the DB connector row (NOT from header/body). */
  brandId: string;
  /** Per-brand identity salt (64-hex). */
  saltHex: string;
  /** Region code (e.g. 'IN'). */
  regionCode: string;
  /**
   * SPEC: A.1.4 (WA-09) — per-brand `connector.identity_fields` flag state, resolved by the
   * pipeline (fail-closed: absent/undefined = OFF = today's envelope byte-identical). When true,
   * strategies pass { emitInteropIdentifiers: true } to the mappers → AMD-01 interop dual-write
   * (email_sha256 / phone_sha256) + checkout_session_id where the provider carries it.
   */
  identityFieldsEnabled?: boolean;
  /** Correlation ID for the request. */
  correlationId: string;
  /** Request ID for logging. */
  requestId: string;
}

export interface IWebhookStrategy {
  /** Provider name (e.g. 'shopify', 'razorpay', 'shopflo', 'woocommerce'). */
  readonly provider: string;

  /**
   * STEP 1 (NN-4 immovable): Extract the brand-resolution lookup key and verify
   * the HMAC signature. Returns SignatureVerifyResult on success; throws on failure.
   *
   * This is the gating security operation — any failure must result in HTTP 401.
   * No write, no DB touch occurs before this succeeds.
   *
   * For providers that need to parse the body to extract the lookup key (Razorpay,
   * Shopflo), the parse + lookup MUST happen before the HMAC check in the overall
   * security ordering. The returned parsedPayload carries the pre-parsed body
   * so the pipeline doesn't double-parse.
   *
   * @throws Error with code 'HMAC_INVALID' on auth failure.
   * @throws Error with code 'INVALID_JSON' on parse failure.
   * @throws Error with code 'LOOKUP_KEY_MISSING' when lookup key absent.
   */
  signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{
      webhookSecret: string;
      connectorLookupKey: string;
      /**
       * Optional per-instance provenance of the webhook secret, read from the credential bundle's
       * `webhook_secret_origin` marker: 'minted' = Brain generated it at connect (the merchant never
       * entered one — they may be UNABLE to configure it in the provider UI, e.g. Shopflo), 'merchant'
       * = the merchant supplied their own (signatures are expected → strict verify). Absent for
       * legacy bundles / providers that don't stamp it — strategies MUST treat absent as strict.
       */
      webhookSecretOrigin?: string;
    }>,
  ): Promise<SignatureVerifyResult>;

  /**
   * STEP 2: Map the verified payload to a CollectorEventV1-ready shape.
   *
   * Called ONLY after signatureVerify succeeds and brand is resolved.
   * Hashes PII at the boundary (I-S02): raw email/phone MUST NOT leave this scope.
   *
   * @throws Error with code 'INVALID_PAYLOAD' on unmappable payloads (→ 400).
   */
  payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult>;
}
