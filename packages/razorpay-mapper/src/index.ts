/**
 * @brain/razorpay-mapper — Frozen shared mapper package (ADR-RZ-1 / ADR-RZ-2).
 *
 * FROZEN API — do not change after A0 commit without Architect sign-off.
 *
 * Binding decisions implemented here:
 *   C1  — Boundary-hash for DPDP financial-pseudonymous identifiers:
 *          utr → utr_hash, payment_id → payment_id_hash via sha256(per-brand-salt ‖ normalized).
 *          Raw values exist ONLY in-memory in this layer; NEVER persisted, NEVER logged.
 *   C4  — Field ALLOWLIST: only the 12 net-of-fees fields pass the boundary.
 *          ALL card.* fields (card_last4, card_network, card_brand, card_issuer,
 *          card_international, card_type, card_country) are DROPPED at the boundary.
 *   MB-2 — uuidv5-shaped deterministic event_id seeds with entityType discriminator.
 *          Three seed fns: item, summary (brand-level), webhook, webhook-with-type.
 *          Provably non-colliding with ':order.live.v1' / ':order.backfill.v1' namespaces.
 *
 * Exports:
 *   SETTLEMENT_LIVE_V1_EVENT_NAME  — 'settlement.live.v1'
 *   RAZORPAY_FIELD_ALLOWLIST       — the 12 allowed field names (C4)
 *   hashRazorpayId                 — sha256(per-brand-salt ‖ normalized_value) boundary hash (C1)
 *   uuidV5FromSettlementItem       — per-payment event_id seed (MB-2)
 *   uuidV5FromSettlementSummary    — brand-level event_id seed (MB-2)
 *   uuidV5FromRazorpayWebhook      — webhook event_id seed (MB-2)
 *   uuidV5FromRazorpayWebhookWithType — webhook event_id seed with entity_type discriminator (MB-2)
 *   mapSettlementItemToEvent       — raw settlement item → MappedSettlementEvent (allowlisted + hashed)
 *   mapPaymentWebhookToMapRow      — payment.captured webhook payload → connector map row fields
 *   mapRefundWebhookToEvent        — refund.processed / refund.failed → MappedSettlementEvent
 *   mapDisputeWebhookToEvent       — payment.dispute.* lifecycle → MappedDisputeEvent
 *   mapOrderPaidWebhookToEvent     — order.paid → MappedOrderEvent
 *   mapPaymentAuthorizedToEvent    — payment.authorized → MappedOrderEvent
 *   RazorpaySettlementItem         — raw Razorpay settlement API response item type
 *   RazorpayRefundEntity           — raw Razorpay refund webhook payload
 *   RazorpayDisputeEntity          — raw Razorpay dispute webhook payload
 *   RazorpayOrderEntity            — raw Razorpay order.paid webhook payload
 *   MappedSettlementEvent          — output type (settlement + refund lane)
 *   MappedDisputeEvent             — output type (dispute lane)
 *   MappedOrderEvent               — output type (order.paid / payment.authorized lane)
 *   SettlementEventProperties      — properties payload type
 *   DisputeEventProperties         — dispute event properties type
 *   OrderEventProperties           — order/authorization event properties type
 *
 * Money: amount_minor stays BIGINT-as-string throughout (I-S07). Input is integer paisa.
 * PII: raw utr/payment_id consumed here and DROPPED — only hashed identifiers in output (C1).
 * settlement_id: NOT a PII identifier — identifies a batch, not a natural person.
 *                Stored as opaque operational reference (un-hashed) in Bronze/ledger.
 *                Documented as PII data catalog entry: "settlement_id — batch reference, not person-linkable".
 * dispute.lost: REVENUE REVERSAL — amount_minor carried with negative sign semantics in
 *               dispute_direction='debit' (amount itself is positive integer; consumers
 *               must apply sign based on dispute_direction).
 */

import { createHash } from 'node:crypto';
import { hashToUuidShaped } from '@brain/connector-core';

// ── Event name constant ──────────────────────────────────────────────────────

/** Live settlement event name on the live lane */
export const SETTLEMENT_LIVE_V1_EVENT_NAME = 'settlement.live.v1' as const;

// ── C4: Field allowlist (HARD — no other fields cross the boundary) ──────────

/**
 * The ONLY fields permitted from a Razorpay settlement API response.
 * ALL card.* fields and any other metadata are DROPPED at this boundary.
 * PCI SAQ-A compliance: card-network metadata never enters Brain's Bronze layer.
 */
export const RAZORPAY_FIELD_ALLOWLIST = new Set([
  'settlement_id',
  'payment_id',
  'order_id',
  'amount',
  'fee',
  'tax',
  'utr',
  'status',
  'created_at',
  'settled_at',
  'currency',
  'entity_type',
] as const);

/** Card fields that MUST be dropped at the boundary (C4 / PCI SAQ-A) */
// This Set lists the blocked names as string literals; the brain-pci/no-pci-card-fields
// ESLint rule targets identifier and property-key usages, not string values in a Set.
// This file IS the authoritative drop boundary (ADR-RZ-10) — the rule guards all OTHER files.
/* eslint-disable brain-pci/no-pci-card-fields -- the boundary's own blocklist
   enumeration (ADR-RZ-10): this Set IS the drop mechanism the rule enforces
   everywhere else; the rule's own message directs the disable here. */
export const CARD_FIELDS_BLOCKED = new Set([
  'card_last4',
  'card_network',
  'card_brand',
  'card_issuer',
  'card_international',
  'card_type',
  'card_country',
  // nested card.* fields — also blocked
  'card',
]);
/* eslint-enable brain-pci/no-pci-card-fields */

// ── Entity types (MB-2 / MB-3) ───────────────────────────────────────────────

export type SettlementEntityType =
  | 'payment'
  | 'refund'
  | 'adjustment'
  | 'reserve_deduction';

// ── Raw Razorpay settlement item (from /v1/settlements/recon/combined API) ───

/**
 * Raw shape of a Razorpay settlement reconciliation item.
 * This type accepts arbitrary extra fields (from the API) which the allowlist drops.
 * card.* fields exist at the source but never survive past mapSettlementItemToEvent.
 */
export interface RazorpaySettlementItem {
  settlement_id?: string | null;
  payment_id?: string | null;
  order_id?: string | null;
  amount?: number | string | null;   // paisa integer (Razorpay sends integers)
  fee?: number | string | null;      // paisa integer
  tax?: number | string | null;      // paisa integer (GST on MDR)
  utr?: string | null;
  status?: string | null;
  created_at?: number | string | null;   // Unix timestamp or ISO
  settled_at?: number | string | null;   // Unix timestamp or ISO
  currency?: string | null;
  entity_type?: string | null;
  // card.* and other fields may be present in the raw API response — all DROPPED
  [key: string]: unknown;
}

/** Raw Razorpay payment.captured webhook payload (subset we care about) */
export interface RazorpayPaymentCapturedPayload {
  id: string;            // pay_XXXX — raw payment_id
  order_id?: string | null;   // order_XXXX — Razorpay-native order ID
  notes?: {
    shopify_order_id?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

// ── Output types ─────────────────────────────────────────────────────────────

export type ReconciliationType = 'per_order' | 'brand_level';

/**
 * Settlement event properties (allowlisted + hashed).
 * Raw utr/payment_id NEVER appear — only utr_hash, payment_id_hash.
 * settlement_id stored as opaque operational reference (C1 PII assessment: batch ref, not person-linkable).
 */
export interface SettlementEventProperties {
  source: 'razorpay';
  settlement_id: string;            // opaque batch ref — not person-linkable (C1 PII catalog)
  payment_id_hash: string | null;   // sha256(salt ‖ payment_id) — raw DROPPED (C1)
  order_id: string | null;          // Razorpay-native order_XXXX (for map-table join; not a PII field)
  utr_hash: string | null;          // sha256(salt ‖ utr) — raw DROPPED (C1)
  amount_minor: string;             // BIGINT-as-string, INR paisa (I-S07)
  fee_minor: string;                // BIGINT-as-string, INR paisa
  tax_minor: string;                // BIGINT-as-string, INR paisa (GST on MDR — separate from fee)
  currency_code: string;
  entity_type: SettlementEntityType;
  status: string | null;
  settlement_at: string | null;     // ISO-8601
  occurred_at: string;              // ISO-8601 — economic_effective_at
  reconciliation_type: ReconciliationType;
}

export interface MappedSettlementEvent {
  event_name: typeof SETTLEMENT_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: SettlementEventProperties;
}

/** Output from mapPaymentWebhookToMapRow — fields for connector_razorpay_order_map upsert */
export interface RazorpayOrderMapRow {
  brand_id: string;
  razorpay_order_id: string | null;
  shopify_order_id: string;
  razorpay_payment_id: string;   // raw — stored in RLS-protected map table (internal join only)
}

// ── UUID utils — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

// ── C1: Boundary hash for DPDP financial identifiers ─────────────────────────

/**
 * Hash a Razorpay financial identifier (UTR or payment_id) at the boundary.
 * Algorithm: sha256(per-brand-salt-hex ‖ normalized_value) → hex digest.
 * Mirrors the digest discipline from @brain/shopify-mapper / @brain/identity-core.
 *
 * CRITICAL: the raw value is NOT logged or persisted — it exists only in-memory
 * in this call frame. The returned hash is the ONLY form that survives this boundary.
 *
 * @param rawValue   The raw identifier (UTR string or payment_id string like "pay_XXXX")
 * @param saltHex    Per-brand 64-char hex salt (same salt used for identity hashing)
 * @returns          sha256(saltHex + normalized_value) as hex string
 */
export function hashRazorpayId(rawValue: string, saltHex: string): string {
  // Normalize: trim whitespace, lowercase (UTR and pay_ID have consistent casing but be safe)
  const normalized = rawValue.trim().toLowerCase();
  return createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(normalized, 'utf8')
    .digest('hex');
}

// ── MB-2: uuidv5-shaped event_id seeds ───────────────────────────────────────

/**
 * Deterministic event_id for a per-payment settlement item (MB-2 / ADR-RZ-2).
 * Seed: sha256(`${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1`)
 *
 * The entityType discriminator is CRITICAL: a Razorpay correction referencing the same
 * (settlementId, paymentId) but a different entityType generates a DISTINCT id — so
 * corrections land as new Bronze rows rather than being silently deduped.
 *
 * Provably non-colliding with ':order.live.v1' / ':order.backfill.v1' (distinct suffix).
 *
 * @param brandId      Brand UUID
 * @param settlementId Razorpay settlement_id (batch reference, not person-linkable)
 * @param paymentId    Raw payment_id (used in seed only — seed itself never logged)
 * @param entityType   'payment' | 'refund' | 'adjustment' | 'reserve_deduction'
 */
export function uuidV5FromSettlementItem(
  brandId: string,
  settlementId: string,
  paymentId: string,
  entityType: SettlementEntityType,
): string {
  return hashToUuidShaped(
    `${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1`,
  );
}

/**
 * Deterministic event_id for brand-level settlement events (MB-2 / ADR-RZ-2).
 * Used for: rolling reserve releases, adjustment batch settlements — no payment_id.
 * Seed: sha256(`${brandId}:${settlementId}:summary:settlement.live.v1`)
 *
 * The literal ':summary:' token ensures non-collision with per-payment events
 * (which use ':${paymentId}:' — payment IDs never equal 'summary').
 *
 * @param brandId      Brand UUID
 * @param settlementId Razorpay settlement_id
 */
export function uuidV5FromSettlementSummary(
  brandId: string,
  settlementId: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${settlementId}:summary:settlement.live.v1`,
  );
}

/**
 * Deterministic event_id for a Razorpay webhook event (MB-2 / ADR-RZ-2).
 * Seed: sha256(`${brandId}:${razorpayWebhookEventId}:settlement.webhook.v1`)
 *
 * @param brandId               Brand UUID
 * @param razorpayWebhookEventId Razorpay event.id from the webhook body
 */
export function uuidV5FromRazorpayWebhook(
  brandId: string,
  razorpayWebhookEventId: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${razorpayWebhookEventId}:settlement.webhook.v1`,
  );
}

/**
 * Deterministic event_id for a Razorpay webhook event with an entity_type discriminator.
 * Seed: sha256(`${brandId}:${razorpayWebhookEventId}:${entityTypeTag}:settlement.webhook.v1`)
 *
 * The entityTypeTag discriminator is CRITICAL for events that can share the same Razorpay
 * event_id but represent different semantic entities (e.g. refund.processed vs refund.failed
 * both referencing the same refund_id). Using this fn instead of uuidV5FromRazorpayWebhook
 * ensures the different event types land as DISTINCT Bronze rows.
 *
 * Provably non-colliding with uuidV5FromRazorpayWebhook (distinct token count in seed).
 *
 * @param brandId               Brand UUID
 * @param razorpayWebhookEventId Razorpay event.id from the webhook body
 * @param entityTypeTag          Opaque string discriminator (e.g. 'refund.processed', 'dispute.lost')
 */
export function uuidV5FromRazorpayWebhookWithType(
  brandId: string,
  razorpayWebhookEventId: string,
  entityTypeTag: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${razorpayWebhookEventId}:${entityTypeTag}:settlement.webhook.v1`,
  );
}

// ── Money util — integer paisa to BIGINT-as-string ───────────────────────────

/**
 * Convert a Razorpay amount (integer paisa, as number or string) to BIGINT-as-string.
 * Razorpay sends all amounts as integers (already in paisa — no decimal conversion needed).
 * Integer arithmetic only — no parseFloat (I-S07).
 *
 * @throws if the value is not a non-negative integer or string of integer
 */
export function paisaToMinorString(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(
      `[razorpay-mapper] paisaToMinorString: expected non-negative integer, got "${str}" (I-S07)`,
    );
  }
  return str;
}

/**
 * Convert a Unix timestamp (seconds since epoch) or ISO string to ISO-8601.
 * Razorpay API returns created_at/settled_at as Unix timestamps (integers).
 */
function toIso(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  const str = String(value).trim();
  if (!str) return null;
  // If it looks like a Unix timestamp (all digits)
  if (/^\d+$/.test(str)) {
    return new Date(parseInt(str, 10) * 1000).toISOString();
  }
  // Otherwise treat as ISO
  return new Date(str).toISOString();
}

// ── C4: allowlist filter ─────────────────────────────────────────────────────

/**
 * Filter a raw Razorpay API response object to ONLY the allowed fields.
 * ALL other fields — including card.* — are dropped here and never emitted.
 * Returns a plain object with only allowed keys.
 */
function applyFieldAllowlist(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of RAZORPAY_FIELD_ALLOWLIST) {
    if (key in raw) {
      filtered[key] = raw[key];
    }
  }
  return filtered;
}

// ── Entity type resolver ──────────────────────────────────────────────────────

function resolveEntityType(raw: string | null | undefined): SettlementEntityType {
  switch ((raw ?? '').toLowerCase()) {
    case 'payment':
      return 'payment';
    case 'refund':
      return 'refund';
    case 'adjustment':
      return 'adjustment';
    case 'reserve_deduction':
      return 'reserve_deduction';
    default:
      return 'payment'; // default: treat as payment (conservative)
  }
}

function resolveReconciliationType(entityType: SettlementEntityType): ReconciliationType {
  // rolling_reserve_release and adjustment settlements are brand-level (no payment/order join key)
  // For items that come through with payment_id: per_order
  // For items without payment_id (reserve/adjustment): brand_level
  if (entityType === 'adjustment') return 'brand_level';
  return 'per_order';
}

// ── Main mapper ──────────────────────────────────────────────────────────────

/**
 * Map a raw Razorpay settlement API item to a MappedSettlementEvent.
 *
 * Key invariants:
 *   1. Field allowlist applied FIRST — card.* and all non-allowed fields dropped (C4).
 *   2. utr and payment_id are hashed via sha256(salt ‖ normalized) BEFORE any output (C1).
 *   3. Raw utr and payment_id are NOT present in the returned event (C1).
 *   4. Raw values are NEVER logged at any level (C5).
 *   5. amount_minor, fee_minor, tax_minor are BIGINT-as-strings (I-S07).
 *   6. event_id seed uses entityType discriminator (MB-2).
 *
 * @param item      Raw Razorpay settlement reconciliation item
 * @param brandId   Brand UUID (from connector, NOT from the API response)
 * @param saltHex   Per-brand 64-char hex salt for PII hashing
 * @param isSummary true for brand-level events (reserve releases, adjustment batches)
 */
export function mapSettlementItemToEvent(
  item: RazorpaySettlementItem,
  brandId: string,
  saltHex: string,
  isSummary = false,
): MappedSettlementEvent {
  // ── C4: Apply field allowlist FIRST — card.* and all other fields DROPPED ──
  const allowed = applyFieldAllowlist(item as Record<string, unknown>);

  const settlementId = String(allowed['settlement_id'] ?? '');
  const rawPaymentId = allowed['payment_id'] != null ? String(allowed['payment_id']) : null;
  const rawUtr = allowed['utr'] != null ? String(allowed['utr']) : null;
  const orderId = allowed['order_id'] != null ? String(allowed['order_id']) : null;
  const entityType = resolveEntityType(allowed['entity_type'] as string | null);
  const currency = String(allowed['currency'] ?? 'INR').trim().toUpperCase();

  // ── C1: Hash DPDP identifiers at boundary — raw values DROPPED after this scope ──
  // payment_id (pay_XXXX) — DPDP financial-pseudonymous: linkable to natural person via bank records
  // utr — DPDP financial-pseudonymous: Unique Transaction Reference linkable to bank transaction
  const paymentIdHash = rawPaymentId ? hashRazorpayId(rawPaymentId, saltHex) : null;
  const utrHash = rawUtr ? hashRazorpayId(rawUtr, saltHex) : null;
  // rawPaymentId and rawUtr are dropped here — they do not appear in the returned struct

  // ── I-S07: Integer paisa → BIGINT-as-string (no parseFloat) ─────────────────
  const amountMinor = paisaToMinorString(allowed['amount'] as number | string);
  const feeMinor = paisaToMinorString(allowed['fee'] as number | string);
  const taxMinor = paisaToMinorString(allowed['tax'] as number | string);

  const settledAt = toIso(allowed['settled_at'] as number | string);
  const occurredAt = settledAt ?? toIso(allowed['created_at'] as number | string) ?? new Date().toISOString();

  const reconciliationType = isSummary
    ? 'brand_level'
    : (rawPaymentId ? resolveReconciliationType(entityType) : 'brand_level');

  const properties: SettlementEventProperties = {
    source: 'razorpay',
    settlement_id: settlementId,    // opaque batch ref — not person-linkable (C1 catalog)
    payment_id_hash: paymentIdHash, // hashed only — raw DROPPED (C1)
    order_id: orderId,              // Razorpay-native order_XXXX — not PII
    utr_hash: utrHash,              // hashed only — raw DROPPED (C1)
    amount_minor: amountMinor,
    fee_minor: feeMinor,
    tax_minor: taxMinor,
    currency_code: currency,
    entity_type: entityType,
    status: allowed['status'] != null ? String(allowed['status']) : null,
    settlement_at: settledAt,
    occurred_at: occurredAt,
    reconciliation_type: reconciliationType,
  };

  return {
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

// ── New event entity types ────────────────────────────────────────────────────

/**
 * Raw Razorpay refund entity from refund.processed / refund.failed webhook payload.
 * card.* fields MUST NOT cross the boundary (C4).
 */
export interface RazorpayRefundEntity {
  id?: string | null;                 // rfnd_XXXX — raw refund_id
  payment_id?: string | null;         // pay_XXXX — the payment this refund belongs to
  amount?: number | string | null;    // paisa integer — the refunded amount
  currency?: string | null;
  status?: string | null;             // 'processed' | 'failed'
  speed_processed?: string | null;    // 'normal' | 'instant'
  speed_requested?: string | null;
  created_at?: number | null;         // Unix timestamp
  processed_at?: number | null;       // Unix timestamp
  notes?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Dispute lifecycle types — maps to Razorpay event names.
 * dispute.lost is a REVENUE REVERSAL (debit direction).
 */
export type DisputeLifecycleType =
  | 'dispute.created'
  | 'dispute.under_review'
  | 'dispute.won'
  | 'dispute.lost';

/**
 * direction for dispute events: 'credit' (won/reversal returned) | 'debit' (created/lost — money withheld/taken).
 */
export type DisputeDirection = 'debit' | 'credit';

/**
 * Raw Razorpay dispute entity from payment.dispute.* webhook payloads.
 */
export interface RazorpayDisputeEntity {
  id?: string | null;                 // disp_XXXX
  payment_id?: string | null;         // pay_XXXX — the payment under dispute
  amount?: number | string | null;    // paisa integer — disputed amount
  currency?: string | null;
  reason_code?: string | null;        // e.g. 'FROD'
  reason_description?: string | null;
  status?: string | null;             // 'open' | 'under_review' | 'won' | 'lost'
  created_at?: number | null;         // Unix timestamp
  respond_by?: number | null;         // Unix timestamp — chargeback response deadline
  [key: string]: unknown;
}

/**
 * Raw Razorpay order entity from order.paid webhook payload.
 */
export interface RazorpayOrderEntity {
  id?: string | null;                 // order_XXXX
  amount?: number | string | null;    // paisa integer — order amount
  amount_paid?: number | string | null; // paisa integer — total paid so far
  amount_due?: number | string | null;  // paisa integer — remaining
  currency?: string | null;
  status?: string | null;             // 'paid'
  created_at?: number | null;         // Unix timestamp
  [key: string]: unknown;
}

/**
 * Raw Razorpay payment entity from payment.authorized webhook payload.
 */
export interface RazorpayPaymentAuthorizedEntity {
  id?: string | null;                 // pay_XXXX
  order_id?: string | null;           // order_XXXX
  amount?: number | string | null;    // paisa integer
  currency?: string | null;
  status?: string | null;             // 'authorized'
  created_at?: number | null;         // Unix timestamp
  [key: string]: unknown;
}

// ── New output types ──────────────────────────────────────────────────────────

/**
 * Properties for refund.processed / refund.failed events on the settlement.live.v1 lane.
 * Reuses the settlement lane so the ledger receives both settlements and refunds.
 * PII: raw refund_id and payment_id are hashed (C1).
 * Money: amount_minor is BIGINT-as-string in integer paisa (I-S07).
 */
export interface RefundEventProperties {
  source: 'razorpay';
  entity_type: 'refund';
  refund_id_hash: string;             // sha256(salt ‖ rfnd_XXXX) — raw DROPPED (C1)
  payment_id_hash: string | null;     // sha256(salt ‖ pay_XXXX) — raw DROPPED (C1)
  amount_minor: string;               // BIGINT-as-string, INR paisa (I-S07)
  currency_code: string;
  status: string | null;              // 'processed' | 'failed'
  speed_processed: string | null;
  occurred_at: string;                // ISO-8601
}

/**
 * Properties for payment.dispute.* lifecycle events on the settlement.live.v1 lane.
 *
 * dispute.lost is a REVENUE REVERSAL:
 *   dispute_direction = 'debit' — the disputed amount is withheld / charged back.
 *   Consumers (ledger writers) MUST apply a negative sign when dispute_direction = 'debit'.
 *
 * dispute.won is the reversal of a lost dispute (credit direction).
 * dispute.created / dispute.under_review are informational (debit — amount withheld).
 */
export interface DisputeEventProperties {
  source: 'razorpay';
  entity_type: 'dispute';
  dispute_lifecycle: DisputeLifecycleType;
  /**
   * 'debit'  — money withheld or taken (dispute.created, dispute.under_review, dispute.lost).
   * 'credit' — money returned (dispute.won).
   * Consumers MUST use dispute_direction to apply the correct sign to amount_minor.
   */
  dispute_direction: DisputeDirection;
  dispute_id_hash: string;            // sha256(salt ‖ disp_XXXX) — raw DROPPED (C1)
  payment_id_hash: string | null;     // sha256(salt ‖ pay_XXXX) — raw DROPPED (C1)
  amount_minor: string;               // BIGINT-as-string, INR paisa (I-S07)
  currency_code: string;
  reason_code: string | null;
  status: string | null;
  respond_by: string | null;          // ISO-8601 — chargeback response deadline
  occurred_at: string;                // ISO-8601
}

/**
 * Properties for order.paid and payment.authorized events on the settlement.live.v1 lane.
 * These are pre-settlement signals — no UTR, no refund context.
 * PII: raw payment_id hashed (C1). order_id is not person-linkable.
 */
export interface OrderEventProperties {
  source: 'razorpay';
  entity_type: 'order_paid' | 'payment_authorized';
  payment_id_hash: string | null;     // sha256(salt ‖ pay_XXXX) — raw DROPPED (C1); null for order.paid with no payment link
  order_id: string | null;            // Razorpay-native order_XXXX — not PII
  amount_minor: string;               // BIGINT-as-string, INR paisa (I-S07)
  currency_code: string;
  status: string | null;
  occurred_at: string;                // ISO-8601
}

export interface MappedRefundEvent {
  event_name: typeof SETTLEMENT_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: RefundEventProperties;
}

export interface MappedDisputeEvent {
  event_name: typeof SETTLEMENT_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: DisputeEventProperties;
}

export interface MappedOrderEvent {
  event_name: typeof SETTLEMENT_LIVE_V1_EVENT_NAME;
  occurred_at: string;
  properties: OrderEventProperties;
}

// ── Dispute direction resolver ────────────────────────────────────────────────

/**
 * Resolve dispute_direction from the lifecycle type.
 *   debit  = money withheld or taken by payment processor (created, under_review, lost).
 *   credit = money returned to merchant (won).
 *
 * dispute.lost is a REVENUE REVERSAL — consumers MUST apply negative sign to amount_minor
 * when dispute_direction = 'debit'.
 */
function resolveDisputeDirection(lifecycle: DisputeLifecycleType): DisputeDirection {
  switch (lifecycle) {
    case 'dispute.won':
      return 'credit';
    case 'dispute.created':
    case 'dispute.under_review':
    case 'dispute.lost':
    default:
      return 'debit';
  }
}

// ── New mapper functions ──────────────────────────────────────────────────────

/**
 * Map a Razorpay refund entity (from refund.processed or refund.failed webhook) to a
 * MappedRefundEvent on the settlement.live.v1 lane.
 *
 * Key invariants:
 *   1. refund_id (rfnd_XXXX) and payment_id (pay_XXXX) are hashed via sha256(salt ‖ normalized) (C1).
 *   2. Raw identifiers are NOT in the returned struct.
 *   3. amount_minor is BIGINT-as-string integer paisa (I-S07).
 *   4. entity_type='refund' discriminates from settlement.live.v1 payment rows.
 *
 * @param entity          Raw Razorpay refund entity from webhook payload
 * @param brandId         Brand UUID (from connector row, not from body)
 * @param saltHex         Per-brand 64-char hex salt for PII hashing
 */
export function mapRefundWebhookToEvent(
  entity: RazorpayRefundEntity,
  brandId: string,
  saltHex: string,
): MappedRefundEvent {
  void brandId; // reserved for future brand-scoped fields

  const rawRefundId = entity.id ? String(entity.id).trim() : null;
  const rawPaymentId = entity.payment_id ? String(entity.payment_id).trim() : null;
  const currency = String(entity.currency ?? 'INR').trim().toUpperCase();

  // ── C1: Hash DPDP identifiers at boundary — raw values DROPPED after this scope ──
  if (!rawRefundId) {
    throw new Error('[razorpay-mapper] mapRefundWebhookToEvent: refund id missing (I-S07)');
  }
  const refundIdHash = hashRazorpayId(rawRefundId, saltHex);
  const paymentIdHash = rawPaymentId ? hashRazorpayId(rawPaymentId, saltHex) : null;

  // ── I-S07: Integer paisa → BIGINT-as-string ──────────────────────────────────
  const amountMinor = paisaToMinorString(entity.amount);

  const occurredAt =
    toIso(entity.processed_at) ??
    toIso(entity.created_at) ??
    new Date().toISOString();

  const properties: RefundEventProperties = {
    source: 'razorpay',
    entity_type: 'refund',
    refund_id_hash: refundIdHash,
    payment_id_hash: paymentIdHash,
    amount_minor: amountMinor,
    currency_code: currency,
    status: entity.status ? String(entity.status) : null,
    speed_processed: entity.speed_processed ? String(entity.speed_processed) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

/**
 * Map a Razorpay dispute entity to a MappedDisputeEvent on the settlement.live.v1 lane.
 *
 * REVENUE REVERSAL note (dispute.lost):
 *   dispute_direction = 'debit' for dispute.lost — the disputed amount is charged back.
 *   Consumers MUST check dispute_direction and apply negative sign when 'debit'.
 *
 * Key invariants:
 *   1. dispute_id (disp_XXXX) and payment_id (pay_XXXX) are hashed (C1).
 *   2. amount_minor is BIGINT-as-string integer paisa (I-S07).
 *   3. entity_type='dispute' discriminates from settlement / refund rows.
 *   4. dispute_direction='debit' for created/under_review/lost; 'credit' for won.
 *
 * @param entity          Raw Razorpay dispute entity from webhook payload
 * @param lifecycle       The dispute lifecycle stage (from the webhook event name)
 * @param brandId         Brand UUID (from connector row, not from body)
 * @param saltHex         Per-brand 64-char hex salt for PII hashing
 */
export function mapDisputeWebhookToEvent(
  entity: RazorpayDisputeEntity,
  lifecycle: DisputeLifecycleType,
  brandId: string,
  saltHex: string,
): MappedDisputeEvent {
  void brandId; // reserved for future brand-scoped fields

  const rawDisputeId = entity.id ? String(entity.id).trim() : null;
  const rawPaymentId = entity.payment_id ? String(entity.payment_id).trim() : null;
  const currency = String(entity.currency ?? 'INR').trim().toUpperCase();

  // ── C1: Hash DPDP identifiers ──────────────────────────────────────────────
  if (!rawDisputeId) {
    throw new Error('[razorpay-mapper] mapDisputeWebhookToEvent: dispute id missing');
  }
  const disputeIdHash = hashRazorpayId(rawDisputeId, saltHex);
  const paymentIdHash = rawPaymentId ? hashRazorpayId(rawPaymentId, saltHex) : null;

  // ── I-S07: Integer paisa ────────────────────────────────────────────────────
  const amountMinor = paisaToMinorString(entity.amount);

  const occurredAt = toIso(entity.created_at) ?? new Date().toISOString();
  const respondBy = entity.respond_by != null ? toIso(entity.respond_by) : null;
  const direction = resolveDisputeDirection(lifecycle);

  const properties: DisputeEventProperties = {
    source: 'razorpay',
    entity_type: 'dispute',
    dispute_lifecycle: lifecycle,
    dispute_direction: direction,
    dispute_id_hash: disputeIdHash,
    payment_id_hash: paymentIdHash,
    amount_minor: amountMinor,
    currency_code: currency,
    reason_code: entity.reason_code ? String(entity.reason_code) : null,
    status: entity.status ? String(entity.status) : null,
    respond_by: respondBy ?? null,
    occurred_at: occurredAt,
  };

  return {
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

/**
 * Map a Razorpay order.paid entity to a MappedOrderEvent on the settlement.live.v1 lane.
 * order.paid fires when ALL payments for an order are complete.
 *
 * Key invariants:
 *   1. order_id is Razorpay-native (not PII) — stored as opaque reference.
 *   2. No payment_id available directly on order entity (no hash needed here).
 *   3. amount_minor / amount_paid_minor are BIGINT-as-string (I-S07).
 *
 * @param entity    Raw Razorpay order entity from order.paid webhook
 * @param brandId   Brand UUID (from connector row)
 * @param saltHex   Per-brand 64-char hex salt
 */
export function mapOrderPaidWebhookToEvent(
  entity: RazorpayOrderEntity,
  brandId: string,
  saltHex: string,
): MappedOrderEvent {
  void brandId;
  void saltHex; // No PII to hash on order entity — order_id is not person-linkable

  const currency = String(entity.currency ?? 'INR').trim().toUpperCase();
  const amountMinor = paisaToMinorString(entity.amount);
  const occurredAt = toIso(entity.created_at) ?? new Date().toISOString();

  const properties: OrderEventProperties = {
    source: 'razorpay',
    entity_type: 'order_paid',
    payment_id_hash: null,            // no payment_id on order entity
    order_id: entity.id ? String(entity.id).trim() : null,
    amount_minor: amountMinor,
    currency_code: currency,
    status: entity.status ? String(entity.status) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

/**
 * Map a Razorpay payment.authorized entity to a MappedOrderEvent on the settlement.live.v1 lane.
 * payment.authorized fires when a payment is authorized but not yet captured.
 *
 * Key invariants:
 *   1. payment_id (pay_XXXX) is hashed (C1).
 *   2. order_id is Razorpay-native — not PII, stored as opaque reference.
 *   3. amount_minor is BIGINT-as-string (I-S07).
 *
 * @param entity    Raw Razorpay payment entity from payment.authorized webhook
 * @param brandId   Brand UUID (from connector row)
 * @param saltHex   Per-brand 64-char hex salt for PII hashing
 */
export function mapPaymentAuthorizedToEvent(
  entity: RazorpayPaymentAuthorizedEntity,
  brandId: string,
  saltHex: string,
): MappedOrderEvent {
  void brandId;

  const rawPaymentId = entity.id ? String(entity.id).trim() : null;
  const currency = String(entity.currency ?? 'INR').trim().toUpperCase();
  const amountMinor = paisaToMinorString(entity.amount);
  const occurredAt = toIso(entity.created_at) ?? new Date().toISOString();

  // ── C1: Hash payment_id ────────────────────────────────────────────────────
  const paymentIdHash = rawPaymentId ? hashRazorpayId(rawPaymentId, saltHex) : null;

  const properties: OrderEventProperties = {
    source: 'razorpay',
    entity_type: 'payment_authorized',
    payment_id_hash: paymentIdHash,
    order_id: entity.order_id ? String(entity.order_id).trim() : null,
    amount_minor: amountMinor,
    currency_code: currency,
    status: entity.status ? String(entity.status) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}

/**
 * Extract the fields needed to upsert a connector_razorpay_order_map row
 * from a payment.captured webhook payload (MB-1 / ADR-RZ-7).
 *
 * The raw payment_id IS stored in the map table (internal join use, RLS-protected).
 * It is NOT stored in Bronze events or ledger rows.
 *
 * shopify_order_id is extracted from payment.notes.shopify_order_id — the
 * Shopify storefront sets this at checkout via Razorpay order creation.
 *
 * @param brandId   Brand UUID (from connector row, never from webhook body)
 * @param payload   Raw payment.captured webhook payload
 * @returns         Map row fields, or null if shopify_order_id is missing (cannot map)
 */
export function mapPaymentWebhookToMapRow(
  brandId: string,
  payload: RazorpayPaymentCapturedPayload,
): RazorpayOrderMapRow | null {
  const shopifyOrderId =
    payload.notes?.shopify_order_id?.trim() ?? null;

  if (!shopifyOrderId) {
    // Cannot populate the map table without a shopify_order_id link.
    // Caller logs a structured warning (no raw IDs logged — C5).
    return null;
  }

  return {
    brand_id: brandId,
    razorpay_order_id: payload.order_id?.trim() ?? null,
    shopify_order_id: shopifyOrderId,
    razorpay_payment_id: payload.id.trim(), // raw — stored in RLS-protected map table only
  };
}
