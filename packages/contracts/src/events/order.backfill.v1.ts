/**
 * order.backfill.v1 — Backfill order event properties contract.
 *
 * Wire format: CollectorEventV1 envelope (sample.collector.event.v1.ts) with
 *   event_name = 'order.backfill.v1'
 *   properties = OrderBackfillPropertiesSchema (below)
 *
 * Topic: {env}.collector.order.backfill.v1  (ORDER_BACKFILL_V1_TOPIC_SUFFIX)
 *   Single partition = natural throughput cap (ADR-BF-7 / D-3)
 *   Separate from live lane ({env}.collector.event.v1)
 *   Consumer group: stream-worker-backfill (isolated from stream-worker-live)
 *
 * event_id derivation (ADR-BF-2 / D-5):
 *   Deterministic, stable across re-runs:
 *   sha256(brand_id + ':' + shopify_order_id + ':' + 'order.backfill.v1')
 *   formatted as RFC-4122 UUIDv5-shaped (version nibble = 5, variant bits set),
 *   hyphenated. NOT randomUUID(). Computed in the backfill worker at emit time.
 *   Guarantees: idempotent Bronze dedup on re-run via Redis NX + PG PK (I-ST04).
 *
 * occurred_at (envelope field, D-6):
 *   = Shopify order's processed_at ?? created_at — NOT NOW() at ingest.
 *   The revenue-finalization job uses `occurred_at + horizon_days < NOW()` for
 *   provisional→realized; a past-dated occurred_at finalizes on next cron run.
 *
 * PII rule (D-10 / I-S02):
 *   NO raw email, phone, name, address in this schema or in Bronze payload.
 *   Only hashed identifiers (sha256(brand-salt || normalized)) may appear.
 *   Enforced by no-pii-schema-lint CI gate.
 */
import { z } from 'zod';

// ── OrderBackfill properties payload ─────────────────────────────────────────

export const OrderBackfillPropertiesSchema = z.object({
  /** Connector source — 'shopify' for this slice */
  source: z.literal('shopify'),

  /** Shopify numeric order ID as string (globally unique — not PII). */
  shopify_order_id: z.string().min(1),

  /**
   * Canonical order_id used in the ledger (= shopify_order_id for Shopify).
   * Consumed by OrderEventConsumer → RecognizeOrder → realized_revenue_ledger.
   */
  order_id: z.string().min(1),

  /**
   * Order total in minor units (paisa for INR) as a BIGINT-as-string.
   * Integer arithmetic only — never parseFloat (D-13 / I-S07).
   * Conversion: split on '.', assert ≤2 decimals, BigInt(whole)*100n + BigInt(frac).
   */
  amount_minor: z.string().regex(/^\d+$/, 'amount_minor must be a non-negative integer string'),

  /** ISO 4217 currency code (3 chars). Required alongside every money field (I-S07). */
  currency_code: z.string().length(3),

  /**
   * Payment method for COD/prepaid horizon split (ADR-BF-15).
   * Mapped from Shopify gateway/payment_gateway_names/financial_status at worker boundary.
   * Consumed by OrderEventConsumer.toPaymentMethod → RecognitionPolicy → horizon days.
   */
  payment_method: z.enum(['cod', 'prepaid']),

  /** Shopify financial_status (paid/pending/refunded/voided/partially_refunded). */
  financial_status: z.string().optional(),

  /** Shopify fulfillment_status (null = unfulfilled). */
  fulfillment_status: z.string().nullable().optional(),

  /** Shopify cancelled_at timestamp (ISO-8601 UTC) or null. */
  cancelled_at: z.string().datetime({ offset: false }).nullable().optional(),

  /**
   * Hashed customer email — sha256(brand-salt || normalize(email)).
   * Consumed by ResolveIdentityUseCase for brain_id resolution.
   * NEVER the raw email. Optional: not all orders have a customer email.
   * Max 64 hex chars (SHA-256 output = 64 hex).
   */
  hashed_customer_email: z.string().max(64).optional(),

  /**
   * Hashed customer phone — sha256(brand-salt || normalize(phone)).
   * Consumed by ResolveIdentityUseCase for brain_id resolution.
   * NEVER the raw phone number.
   */
  hashed_customer_phone: z.string().max(64).optional(),

  /**
   * Shopify numeric customer ID (not PII — a platform identifier, not a contact).
   * Used as storefront_customer_id for weak identity linking (tier: strong_on_link).
   */
  storefront_customer_id: z.string().optional(),
});

export type OrderBackfillProperties = z.infer<typeof OrderBackfillPropertiesSchema>;

// ── Topic suffix (ADR-BF-7 / D-3) ────────────────────────────────────────────

/**
 * Topic suffix for the backfill lane.
 * Full topic: {env}.collector.order.backfill.v1
 * Single partition (natural throughput cap). Separate from live topic.
 */
export const ORDER_BACKFILL_V1_TOPIC_SUFFIX = 'collector.order.backfill.v1' as const;

/** Event name constant — matches event_name in the CollectorEventV1 envelope. */
export const ORDER_BACKFILL_V1_EVENT_NAME = 'order.backfill.v1' as const;

/** Avro subject name for Apicurio schema registry (additive evolution only). */
export const ORDER_BACKFILL_V1_AVRO_SUBJECT = 'brain.collector.order.backfill.v1' as const;
