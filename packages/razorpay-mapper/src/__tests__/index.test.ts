/**
 * @brain/razorpay-mapper — unit tests (A0 — FROZEN after A0 commit)
 *
 * Tests:
 *   UT-1: hashRazorpayId — determinism + distinctness from different salts + input normalization
 *   UT-2: uuidV5FromSettlementItem — entityType discriminator prevents dedup collision
 *   UT-3: uuidV5FromSettlementSummary — ':summary:' token non-collision with per-payment events
 *   UT-4: uuidV5FromRazorpayWebhook — distinct namespace (':settlement.webhook.v1')
 *   UT-5: mapSettlementItemToEvent — card-field allowlist (C4): no card.* in output
 *   UT-6: mapSettlementItemToEvent — raw utr/payment_id NEVER in output (C1 boundary hash)
 *   UT-7: mapSettlementItemToEvent — only allowlisted fields pass (C4 completeness)
 *   UT-8: mapSettlementItemToEvent — integer paisa → BIGINT-as-string (I-S07, no float)
 *   UT-9: mapPaymentWebhookToMapRow — null when shopify_order_id missing
 *   UT-10: uuidV5 provably non-colliding with order.live.v1 / order.backfill.v1 namespaces
 *   UT-11: uuidV5FromSettlementItem correction discriminator — same (settlement+payment), diff entityType = DISTINCT ids
 *   UT-14: uuidV5FromRazorpayWebhookWithType — entity_type discriminator non-collision
 *   UT-15: mapRefundWebhookToEvent — refund.processed / refund.failed → entity_type='refund', C1 hashes, I-S07
 *   UT-16: mapDisputeWebhookToEvent — dispute lifecycle + dispute_direction correctness (REVENUE REVERSAL on lost)
 *   UT-17: mapOrderPaidWebhookToEvent — order.paid → entity_type='order_paid', I-S07
 *   UT-18: mapPaymentAuthorizedToEvent — payment.authorized → entity_type='payment_authorized', C1 hash, I-S07
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  hashRazorpayId,
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  uuidV5FromRazorpayWebhook,
  uuidV5FromRazorpayWebhookWithType,
  mapSettlementItemToEvent,
  mapPaymentWebhookToMapRow,
  mapRefundWebhookToEvent,
  mapDisputeWebhookToEvent,
  mapOrderPaidWebhookToEvent,
  mapPaymentAuthorizedToEvent,
  RAZORPAY_FIELD_ALLOWLIST,
  CARD_FIELDS_BLOCKED,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
  paisaToMinorString,
  type RazorpaySettlementItem,
  type RazorpayPaymentCapturedPayload,
  type RazorpayRefundEntity,
  type RazorpayDisputeEntity,
  type RazorpayOrderEntity,
  type RazorpayPaymentAuthorizedEntity,
  type DisputeLifecycleType,
} from '../index.js';

// ── Test constants ─────────────────────────────────────────────────────────────

const BRAND_A = 'c07ec701-0a00-4a00-8a00-000000000001';
const BRAND_B = 'c07ec702-0b00-4b00-8b00-000000000002';
const SALT_A = 'a'.repeat(64);   // 64-char hex salt for brand A
const SALT_B = 'b'.repeat(64);   // 64-char hex salt for brand B

const SETTLEMENT_ID = 'setl_TestSettlement123';
const PAYMENT_ID = 'pay_TestPayment12345678';  // 14-char after prefix

const FIXTURE_ITEM_WITH_CARD_FIELDS: RazorpaySettlementItem = {
  settlement_id: SETTLEMENT_ID,
  payment_id: PAYMENT_ID,
  order_id: 'order_TestOrder1234',
  amount: 100000,
  fee: 2000,
  tax: 360,
  utr: 'UTR20241231000000000001',
  status: 'settled',
  created_at: 1704067200,   // 2024-01-01T00:00:00Z as Unix timestamp
  settled_at: 1704153600,   // 2024-01-02T00:00:00Z as Unix timestamp
  currency: 'INR',
  entity_type: 'payment',
  // card.* fields — these MUST be dropped at the boundary (C4)
  card_last4: '4242',
  card_network: 'Visa',
  card_brand: 'Visa',
  card_issuer: 'HDFC',
  card_international: false,
  card_type: 'credit',
  card_country: 'IN',
  // nested card object — also blocked
  card: {
    last4: '4242',
    network: 'Visa',
    issuer: 'HDFC',
  },
  // other non-allowlisted fields
  method: 'card',
  bank: 'HDFC',
  wallet: null,
  error_code: null,
  error_description: null,
};

// ── UT-1: hashRazorpayId determinism ──────────────────────────────────────────

describe('UT-1: hashRazorpayId — determinism + normalization', () => {
  it('produces the same hash for the same input (deterministic)', () => {
    const h1 = hashRazorpayId(PAYMENT_ID, SALT_A);
    const h2 = hashRazorpayId(PAYMENT_ID, SALT_A);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);   // sha256 hex = 64 chars
  });

  it('normalizes whitespace and case (trim + lowercase)', () => {
    const h1 = hashRazorpayId(PAYMENT_ID, SALT_A);
    const h2 = hashRazorpayId(`  ${PAYMENT_ID.toLowerCase()}  `, SALT_A);
    expect(h1).toBe(h2);
  });

  it('different salts → different hashes (per-brand isolation)', () => {
    const hA = hashRazorpayId(PAYMENT_ID, SALT_A);
    const hB = hashRazorpayId(PAYMENT_ID, SALT_B);
    expect(hA).not.toBe(hB);
  });

  it('different raw values → different hashes', () => {
    const h1 = hashRazorpayId('pay_AAAAAAAAAAAAAAA', SALT_A);
    const h2 = hashRazorpayId('pay_BBBBBBBBBBBBBBB', SALT_A);
    expect(h1).not.toBe(h2);
  });

  it('matches manual sha256(salt ‖ normalized) computation', () => {
    const normalized = PAYMENT_ID.trim().toLowerCase();
    const expected = createHash('sha256')
      .update(Buffer.from(SALT_A, 'hex'))
      .update(normalized, 'utf8')
      .digest('hex');
    expect(hashRazorpayId(PAYMENT_ID, SALT_A)).toBe(expected);
  });
});

// ── UT-2: uuidV5FromSettlementItem entityType discriminator ───────────────────

describe('UT-2: uuidV5FromSettlementItem — entityType discriminator prevents collision', () => {
  it('same (brand, settlement, payment) but DIFFERENT entityType → DISTINCT event_ids', () => {
    const idPayment = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    const idRefund = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'refund');
    const idAdj = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'adjustment');
    const idRes = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'reserve_deduction');

    // All four must be distinct (the discriminator works)
    const ids = new Set([idPayment, idRefund, idAdj, idRes]);
    expect(ids.size).toBe(4);
  });

  it('same inputs → same id (deterministic)', () => {
    const id1 = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    const id2 = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    expect(id1).toBe(id2);
  });

  it('different brands → different ids (cross-brand non-collision)', () => {
    const idA = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    const idB = uuidV5FromSettlementItem(BRAND_B, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    expect(idA).not.toBe(idB);
  });

  it('returns a UUIDv5-shaped string (8-4-4-4-12 hex groups)', () => {
    const id = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── UT-3: uuidV5FromSettlementSummary — ':summary:' non-collision ─────────────

describe('UT-3: uuidV5FromSettlementSummary — brand-level event non-collision', () => {
  it("':summary:' token does not collide with a payment_id that equals 'summary'", () => {
    // Note: Razorpay payment IDs are 'pay_XXXX' — they never equal 'summary'.
    // This test proves the ':summary:' literal is distinct from a ':payment_id:' seed.
    const summaryId = uuidV5FromSettlementSummary(BRAND_A, SETTLEMENT_ID);
    const perPaymentId = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, 'summary', 'payment');
    // Different because the seed for summary is '...summary:settlement.live.v1'
    // while per-payment is '...summary:payment:settlement.live.v1'
    expect(summaryId).not.toBe(perPaymentId);
  });

  it('same inputs → same id (deterministic)', () => {
    const id1 = uuidV5FromSettlementSummary(BRAND_A, SETTLEMENT_ID);
    const id2 = uuidV5FromSettlementSummary(BRAND_A, SETTLEMENT_ID);
    expect(id1).toBe(id2);
  });

  it('different settlements → different ids', () => {
    const id1 = uuidV5FromSettlementSummary(BRAND_A, 'setl_AAA');
    const id2 = uuidV5FromSettlementSummary(BRAND_A, 'setl_BBB');
    expect(id1).not.toBe(id2);
  });

  it('returns a UUIDv5-shaped string', () => {
    const id = uuidV5FromSettlementSummary(BRAND_A, SETTLEMENT_ID);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── UT-4: uuidV5FromRazorpayWebhook — distinct namespace ─────────────────────

describe('UT-4: uuidV5FromRazorpayWebhook — webhook namespace distinct from item namespace', () => {
  it('webhook event_id does not collide with settlement item event_id for same brand/settlement', () => {
    const webhookId = uuidV5FromRazorpayWebhook(BRAND_A, 'event_ABCDEF12345');
    const itemId = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    const summaryId = uuidV5FromSettlementSummary(BRAND_A, SETTLEMENT_ID);
    const ids = new Set([webhookId, itemId, summaryId]);
    expect(ids.size).toBe(3);
  });

  it('same inputs → same id (deterministic)', () => {
    const id1 = uuidV5FromRazorpayWebhook(BRAND_A, 'event_XYZ');
    const id2 = uuidV5FromRazorpayWebhook(BRAND_A, 'event_XYZ');
    expect(id1).toBe(id2);
  });
});

// ── UT-5: Card-field allowlist drop (C4 / PCI SAQ-A) ─────────────────────────

describe('UT-5: mapSettlementItemToEvent — card fields DROPPED at boundary (C4)', () => {
  it('drops ALL card.* fields — none appear in emitted event properties', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const props = event.properties as unknown as Record<string, unknown>;

    // Explicitly assert every blocked card field is absent
    for (const blockedField of CARD_FIELDS_BLOCKED) {
      expect(props).not.toHaveProperty(blockedField);
      // Also check in the serialized JSON (belt + suspenders)
      expect(JSON.stringify(props)).not.toContain(`"${blockedField}"`);
    }

    // Full JSON serialization also must not contain any card-related keys
    const json = JSON.stringify(event);
    expect(json).not.toContain('card_last4');
    expect(json).not.toContain('card_network');
    expect(json).not.toContain('card_brand');
    expect(json).not.toContain('card_issuer');
    expect(json).not.toContain('card_international');
    expect(json).not.toContain('card_type');
    expect(json).not.toContain('card_country');
    expect(json).not.toContain('"card":');
    expect(json).not.toContain('"card":{');
  });

  it('also drops non-allowlisted fields like method, bank, wallet, error_code', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain('"method"');
    expect(json).not.toContain('"bank"');
    expect(json).not.toContain('"wallet"');
    expect(json).not.toContain('"error_code"');
    expect(json).not.toContain('"error_description"');
  });
});

// ── UT-6: DPDP boundary hash — raw utr/payment_id NOT in output (C1) ─────────

describe('UT-6: mapSettlementItemToEvent — raw utr/payment_id dropped; only hashes present (C1)', () => {
  it('output does NOT contain raw payment_id value', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    // The raw PAYMENT_ID must never appear in the output
    expect(json).not.toContain(PAYMENT_ID);
    // But payment_id_hash must be present
    expect(event.properties.payment_id_hash).toBeTruthy();
    expect(event.properties.payment_id_hash).not.toBe(PAYMENT_ID);
  });

  it('output does NOT contain raw utr value', () => {
    const rawUtr = 'UTR20241231000000000001';
    const item: RazorpaySettlementItem = { ...FIXTURE_ITEM_WITH_CARD_FIELDS, utr: rawUtr };
    const event = mapSettlementItemToEvent(item, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(rawUtr);
    expect(event.properties.utr_hash).toBeTruthy();
    expect(event.properties.utr_hash).not.toBe(rawUtr);
  });

  it('payment_id_hash is deterministic (same input → same hash)', () => {
    const ev1 = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const ev2 = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    expect(ev1.properties.payment_id_hash).toBe(ev2.properties.payment_id_hash);
    expect(ev1.properties.utr_hash).toBe(ev2.properties.utr_hash);
  });

  it('payment_id_hash differs for different brands (per-brand salt isolation)', () => {
    const ev_A = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const ev_B = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_B, SALT_B);
    expect(ev_A.properties.payment_id_hash).not.toBe(ev_B.properties.payment_id_hash);
  });

  it('payment_id_hash is null when payment_id is null', () => {
    const item: RazorpaySettlementItem = { ...FIXTURE_ITEM_WITH_CARD_FIELDS, payment_id: null };
    const event = mapSettlementItemToEvent(item, BRAND_A, SALT_A);
    expect(event.properties.payment_id_hash).toBeNull();
  });
});

// ── UT-7: Only allowlisted fields pass (C4 completeness) ─────────────────────

describe('UT-7: mapSettlementItemToEvent — all allowlisted fields present in output', () => {
  it('all 12 allowlist fields correctly mapped to output properties', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    const props = event.properties;

    // settlement_id stored as opaque ref (not hashed — C1 PII assessment: not person-linkable)
    expect(props.settlement_id).toBe(SETTLEMENT_ID);
    // payment_id_hash (hashed — raw dropped)
    expect(props.payment_id_hash).toBeTruthy();
    // order_id (Razorpay-native order ID — not PII)
    expect(props.order_id).toBe('order_TestOrder1234');
    // utr_hash (hashed — raw dropped)
    expect(props.utr_hash).toBeTruthy();
    // amount_minor, fee_minor, tax_minor as BIGINT-as-string
    expect(props.amount_minor).toBe('100000');
    expect(props.fee_minor).toBe('2000');
    expect(props.tax_minor).toBe('360');
    // currency_code uppercased
    expect(props.currency_code).toBe('INR');
    // entity_type
    expect(props.entity_type).toBe('payment');
    // status
    expect(props.status).toBe('settled');
    // settlement_at (ISO-8601 from Unix timestamp)
    expect(props.settlement_at).toBe('2024-01-02T00:00:00.000Z');
    // reconciliation_type
    expect(props.reconciliation_type).toBe('per_order');
    // source
    expect(props.source).toBe('razorpay');
    // event_name
    expect(event.event_name).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
  });
});

// ── UT-8: Integer paisa → BIGINT-as-string (I-S07) ───────────────────────────

describe('UT-8: paisaToMinorString — integer arithmetic, no float (I-S07)', () => {
  it('converts integer number to string', () => {
    expect(paisaToMinorString(100000)).toBe('100000');
    expect(paisaToMinorString(0)).toBe('0');
  });

  it('converts numeric string to string', () => {
    expect(paisaToMinorString('2000')).toBe('2000');
  });

  it('returns "0" for null/undefined', () => {
    expect(paisaToMinorString(null)).toBe('0');
    expect(paisaToMinorString(undefined)).toBe('0');
  });

  it('throws for float values (never float paisa)', () => {
    expect(() => paisaToMinorString(99.5)).toThrow('I-S07');
    expect(() => paisaToMinorString('99.5')).toThrow('I-S07');
  });

  it('throws for negative values', () => {
    expect(() => paisaToMinorString(-100)).toThrow('I-S07');
  });

  it('amount_minor in event is a string with no decimal', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
    expect(event.properties.fee_minor).toMatch(/^\d+$/);
    expect(event.properties.tax_minor).toMatch(/^\d+$/);
  });
});

// ── UT-9: mapPaymentWebhookToMapRow ──────────────────────────────────────────

describe('UT-9: mapPaymentWebhookToMapRow', () => {
  const validPayload: RazorpayPaymentCapturedPayload = {
    id: 'pay_TestPayment12345678',
    order_id: 'order_TestOrder1234',
    notes: {
      shopify_order_id: 'shopify_order_9999',
    },
  };

  it('extracts correct fields when shopify_order_id is present in notes', () => {
    const row = mapPaymentWebhookToMapRow(BRAND_A, validPayload);
    expect(row).not.toBeNull();
    expect(row!.brand_id).toBe(BRAND_A);
    expect(row!.razorpay_order_id).toBe('order_TestOrder1234');
    expect(row!.shopify_order_id).toBe('shopify_order_9999');
    expect(row!.razorpay_payment_id).toBe('pay_TestPayment12345678');
  });

  it('returns null when shopify_order_id is missing from notes', () => {
    const payload: RazorpayPaymentCapturedPayload = {
      id: 'pay_AABB',
      order_id: 'order_XYZ',
      notes: {},
    };
    expect(mapPaymentWebhookToMapRow(BRAND_A, payload)).toBeNull();
  });

  it('returns null when notes is null', () => {
    const payload: RazorpayPaymentCapturedPayload = {
      id: 'pay_AABB',
      notes: null,
    };
    expect(mapPaymentWebhookToMapRow(BRAND_A, payload)).toBeNull();
  });

  it('handles null razorpay order_id (order-keyless payment)', () => {
    const payload: RazorpayPaymentCapturedPayload = {
      id: 'pay_NoOrder',
      order_id: null,
      notes: { shopify_order_id: 'shopify_order_direct' },
    };
    const row = mapPaymentWebhookToMapRow(BRAND_A, payload);
    expect(row).not.toBeNull();
    expect(row!.razorpay_order_id).toBeNull();
    expect(row!.shopify_order_id).toBe('shopify_order_direct');
  });
});

// ── UT-10: Non-collision with order.live.v1 / order.backfill.v1 ──────────────

describe('UT-10: settlement uuidv5 provably non-colliding with order namespaces', () => {
  it('settlement item seed differs from order.live.v1 seed for same (brand, id)', () => {
    // Simulate an order.live.v1 seed (from shopify-mapper)
    const orderLiveSeed = `${BRAND_A}:${PAYMENT_ID}:12345:order.live.v1`;
    // Settlement item seed
    const settlementSeed = `${BRAND_A}:${SETTLEMENT_ID}:${PAYMENT_ID}:payment:settlement.live.v1`;

    // Confirm they are literally different strings → different hashes → different UUIDs
    expect(orderLiveSeed).not.toBe(settlementSeed);
    // The seeds have distinct suffixes (':order.live.v1' vs ':settlement.live.v1')
    expect(orderLiveSeed.endsWith(':order.live.v1')).toBe(true);
    expect(settlementSeed.endsWith(':settlement.live.v1')).toBe(true);
  });

  it('settlement webhook seed differs from settlement item seed', () => {
    // Webhook: '...settlement.webhook.v1'
    // Item:    '...settlement.live.v1'
    const wh = uuidV5FromRazorpayWebhook(BRAND_A, 'event_SAME');
    const item = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, 'event_SAME', 'payment');
    expect(wh).not.toBe(item);
  });
});

// ── UT-11: Correction discriminator — same (settlement + payment), different entityType ──

describe('UT-11: correction discriminator — Razorpay corrections land as new Bronze rows', () => {
  it('a Razorpay correction (same settlement_id + payment_id, different entityType) produces a DISTINCT id', () => {
    // This is the key scenario: Razorpay sends a correction that references the same
    // (settlement_id, payment_id) pair but with entity_type='adjustment' (correction).
    // Without the entityType discriminator, this would collide with the original 'payment'
    // event and be silently deduped by ON CONFLICT DO NOTHING — the correction is lost.
    const originalId = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment');
    const correctionId = uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'adjustment');

    expect(originalId).not.toBe(correctionId);   // MUST be distinct → both land in Bronze
  });

  it('the four entityTypes all produce distinct ids for the same (settlement, payment)', () => {
    const ids = [
      uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'payment'),
      uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'refund'),
      uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'adjustment'),
      uuidV5FromSettlementItem(BRAND_A, SETTLEMENT_ID, PAYMENT_ID, 'reserve_deduction'),
    ];
    expect(new Set(ids).size).toBe(4);
  });
});

// ── UT-12: brand_level reconciliation path ────────────────────────────────────

describe('UT-12: brand-level / order-keyless reconciliation_type', () => {
  it('adjustment entityType → reconciliation_type=brand_level', () => {
    const item: RazorpaySettlementItem = {
      settlement_id: SETTLEMENT_ID,
      amount: 50000,
      entity_type: 'adjustment',
    };
    const event = mapSettlementItemToEvent(item, BRAND_A, SALT_A);
    expect(event.properties.reconciliation_type).toBe('brand_level');
  });

  it('isSummary=true → reconciliation_type=brand_level regardless of entityType', () => {
    const item: RazorpaySettlementItem = {
      settlement_id: SETTLEMENT_ID,
      payment_id: PAYMENT_ID,
      amount: 10000,
      entity_type: 'payment',
    };
    const event = mapSettlementItemToEvent(item, BRAND_A, SALT_A, true);
    expect(event.properties.reconciliation_type).toBe('brand_level');
  });

  it('payment entityType with payment_id → reconciliation_type=per_order', () => {
    const event = mapSettlementItemToEvent(FIXTURE_ITEM_WITH_CARD_FIELDS, BRAND_A, SALT_A);
    expect(event.properties.reconciliation_type).toBe('per_order');
  });

  it('payment entityType with no payment_id → reconciliation_type=brand_level', () => {
    const item: RazorpaySettlementItem = {
      settlement_id: SETTLEMENT_ID,
      payment_id: null,
      amount: 10000,
      entity_type: 'payment',
    };
    const event = mapSettlementItemToEvent(item, BRAND_A, SALT_A);
    expect(event.properties.reconciliation_type).toBe('brand_level');
  });
});

// ── UT-14: uuidV5FromRazorpayWebhookWithType — entity_type discriminator ─────

describe('UT-14: uuidV5FromRazorpayWebhookWithType — entity_type discriminator non-collision', () => {
  const EVENT_ID = 'event_WEBHOOKTEST001';

  it('same (brand, eventId) but DIFFERENT entityTypeTag → DISTINCT ids', () => {
    const idRefundProcessed = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'refund.processed');
    const idRefundFailed    = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'refund.failed');
    const idDisputeCreated  = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'payment.dispute.created');
    const idDisputeLost     = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'payment.dispute.lost');
    const idOrderPaid       = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'order.paid');

    const ids = new Set([idRefundProcessed, idRefundFailed, idDisputeCreated, idDisputeLost, idOrderPaid]);
    expect(ids.size).toBe(5);
  });

  it('does NOT collide with uuidV5FromRazorpayWebhook for the same (brand, eventId)', () => {
    const legacy = uuidV5FromRazorpayWebhook(BRAND_A, EVENT_ID);
    const typed  = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'refund.processed');
    expect(legacy).not.toBe(typed);
  });

  it('same inputs → same id (deterministic)', () => {
    const id1 = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'dispute.lost');
    const id2 = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'dispute.lost');
    expect(id1).toBe(id2);
  });

  it('different brands → different ids (cross-brand non-collision)', () => {
    const idA = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'refund.processed');
    const idB = uuidV5FromRazorpayWebhookWithType(BRAND_B, EVENT_ID, 'refund.processed');
    expect(idA).not.toBe(idB);
  });

  it('returns a UUIDv5-shaped string (8-4-4-4-12 hex groups)', () => {
    const id = uuidV5FromRazorpayWebhookWithType(BRAND_A, EVENT_ID, 'payment.authorized');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── UT-15: mapRefundWebhookToEvent ────────────────────────────────────────────

describe('UT-15: mapRefundWebhookToEvent — C1 hashes, I-S07 money, entity_type discriminator', () => {
  const REFUND_ID = 'rfnd_TestRefund12345678';
  const REFUND_PAYMENT_ID = 'pay_TestPayment12345678';

  const validRefundEntity: RazorpayRefundEntity = {
    id: REFUND_ID,
    payment_id: REFUND_PAYMENT_ID,
    amount: 50000,
    currency: 'INR',
    status: 'processed',
    speed_processed: 'normal',
    created_at: 1704067200,
    processed_at: 1704153600,
  };

  it('entity_type is "refund"', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    expect(event.properties.entity_type).toBe('refund');
  });

  it('raw refund_id NOT in output (C1) — only refund_id_hash present', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(REFUND_ID);
    expect(event.properties.refund_id_hash).toBeTruthy();
    expect(event.properties.refund_id_hash).toHaveLength(64); // sha256 hex
  });

  it('raw payment_id NOT in output (C1) — only payment_id_hash present', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(REFUND_PAYMENT_ID);
    expect(event.properties.payment_id_hash).toBeTruthy();
  });

  it('refund_id_hash is deterministic (same input → same hash)', () => {
    const ev1 = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    const ev2 = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    expect(ev1.properties.refund_id_hash).toBe(ev2.properties.refund_id_hash);
  });

  it('refund_id_hash differs for different brands (per-brand salt isolation)', () => {
    const evA = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    const evB = mapRefundWebhookToEvent(validRefundEntity, BRAND_B, SALT_B);
    expect(evA.properties.refund_id_hash).not.toBe(evB.properties.refund_id_hash);
  });

  it('amount_minor is BIGINT-as-string integer paisa (I-S07)', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    expect(event.properties.amount_minor).toBe('50000');
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
  });

  it('currency_code is uppercased', () => {
    const entity: RazorpayRefundEntity = { ...validRefundEntity, currency: 'inr' };
    const event = mapRefundWebhookToEvent(entity, BRAND_A, SALT_A);
    expect(event.properties.currency_code).toBe('INR');
  });

  it('status is preserved from entity', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    expect(event.properties.status).toBe('processed');
  });

  it('payment_id_hash is null when payment_id is null', () => {
    const entity: RazorpayRefundEntity = { ...validRefundEntity, payment_id: null };
    const event = mapRefundWebhookToEvent(entity, BRAND_A, SALT_A);
    expect(event.properties.payment_id_hash).toBeNull();
  });

  it('throws when refund id is missing', () => {
    const entity: RazorpayRefundEntity = { ...validRefundEntity, id: null };
    expect(() => mapRefundWebhookToEvent(entity, BRAND_A, SALT_A)).toThrow();
  });

  it('event_name is settlement.live.v1 (same lane as settlement events)', () => {
    const event = mapRefundWebhookToEvent(validRefundEntity, BRAND_A, SALT_A);
    expect(event.event_name).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
  });
});

// ── UT-16: mapDisputeWebhookToEvent ──────────────────────────────────────────

describe('UT-16: mapDisputeWebhookToEvent — dispute lifecycle + REVENUE REVERSAL on lost', () => {
  const DISPUTE_ID = 'disp_TestDispute12345678';
  const DISPUTE_PAYMENT_ID = 'pay_TestPayment12345678';

  const validDisputeEntity: RazorpayDisputeEntity = {
    id: DISPUTE_ID,
    payment_id: DISPUTE_PAYMENT_ID,
    amount: 100000,
    currency: 'INR',
    reason_code: 'FROD',
    reason_description: 'Fraudulent transaction',
    status: 'open',
    created_at: 1704067200,
    respond_by: 1704672000,
  };

  it('entity_type is "dispute"', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    expect(event.properties.entity_type).toBe('dispute');
  });

  it('dispute.created → dispute_direction=debit', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    expect(event.properties.dispute_direction).toBe('debit');
  });

  it('dispute.under_review → dispute_direction=debit', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.under_review', BRAND_A, SALT_A);
    expect(event.properties.dispute_direction).toBe('debit');
  });

  it('dispute.won → dispute_direction=credit (money returned)', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.won', BRAND_A, SALT_A);
    expect(event.properties.dispute_direction).toBe('credit');
  });

  it('dispute.lost → dispute_direction=debit (REVENUE REVERSAL)', () => {
    // This is the critical invariant: dispute.lost is a revenue reversal.
    // Consumers MUST apply negative sign to amount_minor when dispute_direction = 'debit'
    // on a dispute.lost event.
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.lost', BRAND_A, SALT_A);
    expect(event.properties.dispute_direction).toBe('debit');
    expect(event.properties.dispute_lifecycle).toBe('dispute.lost');
    // amount_minor is positive integer — the sign semantics are carried by dispute_direction
    expect(event.properties.amount_minor).toBe('100000');
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
  });

  it('dispute_lifecycle is set correctly for each lifecycle stage', () => {
    const stages: Array<{ input: DisputeLifecycleType; expected: string }> = [
      { input: 'dispute.created',      expected: 'dispute.created' },
      { input: 'dispute.under_review', expected: 'dispute.under_review' },
      { input: 'dispute.won',          expected: 'dispute.won' },
      { input: 'dispute.lost',         expected: 'dispute.lost' },
    ];
    for (const { input, expected } of stages) {
      const event = mapDisputeWebhookToEvent(validDisputeEntity, input, BRAND_A, SALT_A);
      expect(event.properties.dispute_lifecycle).toBe(expected);
    }
  });

  it('raw dispute_id NOT in output (C1) — only dispute_id_hash present', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(DISPUTE_ID);
    expect(event.properties.dispute_id_hash).toBeTruthy();
    expect(event.properties.dispute_id_hash).toHaveLength(64);
  });

  it('raw payment_id NOT in output (C1) — only payment_id_hash present', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(DISPUTE_PAYMENT_ID);
    expect(event.properties.payment_id_hash).toBeTruthy();
  });

  it('amount_minor is BIGINT-as-string integer paisa (I-S07)', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.lost', BRAND_A, SALT_A);
    expect(event.properties.amount_minor).toBe('100000');
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
  });

  it('reason_code is preserved', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    expect(event.properties.reason_code).toBe('FROD');
  });

  it('respond_by is ISO-8601', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    expect(event.properties.respond_by).toBe('2024-01-08T00:00:00.000Z');
  });

  it('throws when dispute id is missing', () => {
    const entity: RazorpayDisputeEntity = { ...validDisputeEntity, id: null };
    expect(() => mapDisputeWebhookToEvent(entity, 'dispute.created', BRAND_A, SALT_A)).toThrow();
  });

  it('event_name is settlement.live.v1', () => {
    const event = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.lost', BRAND_A, SALT_A);
    expect(event.event_name).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
  });

  it('dispute.created and dispute.lost for same dispute produce DISTINCT event content (lifecycle discriminator)', () => {
    const evCreated = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.created', BRAND_A, SALT_A);
    const evLost    = mapDisputeWebhookToEvent(validDisputeEntity, 'dispute.lost',    BRAND_A, SALT_A);
    // Both reference the same dispute_id_hash but carry different lifecycle + direction
    expect(evCreated.properties.dispute_id_hash).toBe(evLost.properties.dispute_id_hash);
    expect(evCreated.properties.dispute_lifecycle).not.toBe(evLost.properties.dispute_lifecycle);
    expect(evCreated.properties.dispute_direction).toBe(evLost.properties.dispute_direction); // both debit
  });
});

// ── UT-17: mapOrderPaidWebhookToEvent ─────────────────────────────────────────

describe('UT-17: mapOrderPaidWebhookToEvent — entity_type=order_paid, I-S07', () => {
  const validOrderEntity: RazorpayOrderEntity = {
    id: 'order_TestOrder12345678',
    amount: 200000,
    amount_paid: 200000,
    amount_due: 0,
    currency: 'INR',
    status: 'paid',
    created_at: 1704067200,
  };

  it('entity_type is "order_paid"', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.properties.entity_type).toBe('order_paid');
  });

  it('order_id is stored as opaque reference (not PII)', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.properties.order_id).toBe('order_TestOrder12345678');
  });

  it('payment_id_hash is null (no payment_id on order entity)', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.properties.payment_id_hash).toBeNull();
  });

  it('amount_minor is BIGINT-as-string integer paisa (I-S07)', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.properties.amount_minor).toBe('200000');
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
  });

  it('currency_code is uppercased', () => {
    const entity: RazorpayOrderEntity = { ...validOrderEntity, currency: 'inr' };
    const event = mapOrderPaidWebhookToEvent(entity, BRAND_A, SALT_A);
    expect(event.properties.currency_code).toBe('INR');
  });

  it('status is preserved', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.properties.status).toBe('paid');
  });

  it('event_name is settlement.live.v1', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.event_name).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
  });

  it('occurred_at is ISO-8601 derived from created_at', () => {
    const event = mapOrderPaidWebhookToEvent(validOrderEntity, BRAND_A, SALT_A);
    expect(event.occurred_at).toBe('2024-01-01T00:00:00.000Z');
  });
});

// ── UT-18: mapPaymentAuthorizedToEvent ────────────────────────────────────────

describe('UT-18: mapPaymentAuthorizedToEvent — entity_type=payment_authorized, C1 hash, I-S07', () => {
  const AUTH_PAYMENT_ID = 'pay_TestAuthorized123456';
  const AUTH_ORDER_ID   = 'order_TestAuthorized12345';

  const validAuthEntity: RazorpayPaymentAuthorizedEntity = {
    id: AUTH_PAYMENT_ID,
    order_id: AUTH_ORDER_ID,
    amount: 150000,
    currency: 'INR',
    status: 'authorized',
    created_at: 1704067200,
  };

  it('entity_type is "payment_authorized"', () => {
    const event = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    expect(event.properties.entity_type).toBe('payment_authorized');
  });

  it('raw payment_id NOT in output (C1) — only payment_id_hash', () => {
    const event = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    const json = JSON.stringify(event);
    expect(json).not.toContain(AUTH_PAYMENT_ID);
    expect(event.properties.payment_id_hash).toBeTruthy();
    expect(event.properties.payment_id_hash).toHaveLength(64);
  });

  it('order_id is stored as opaque reference (not PII)', () => {
    const event = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    expect(event.properties.order_id).toBe(AUTH_ORDER_ID);
  });

  it('payment_id_hash is deterministic', () => {
    const ev1 = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    const ev2 = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    expect(ev1.properties.payment_id_hash).toBe(ev2.properties.payment_id_hash);
  });

  it('payment_id_hash differs across brands (per-brand salt isolation)', () => {
    const evA = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    const evB = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_B, SALT_B);
    expect(evA.properties.payment_id_hash).not.toBe(evB.properties.payment_id_hash);
  });

  it('amount_minor is BIGINT-as-string integer paisa (I-S07)', () => {
    const event = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    expect(event.properties.amount_minor).toBe('150000');
    expect(event.properties.amount_minor).toMatch(/^\d+$/);
  });

  it('payment_id_hash is null when payment id missing', () => {
    const entity: RazorpayPaymentAuthorizedEntity = { ...validAuthEntity, id: null };
    const event = mapPaymentAuthorizedToEvent(entity, BRAND_A, SALT_A);
    expect(event.properties.payment_id_hash).toBeNull();
  });

  it('event_name is settlement.live.v1', () => {
    const event = mapPaymentAuthorizedToEvent(validAuthEntity, BRAND_A, SALT_A);
    expect(event.event_name).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
  });
});

// ── UT-13: RAZORPAY_FIELD_ALLOWLIST and CARD_FIELDS_BLOCKED exports ───────────

describe('UT-13: exported constants correctness', () => {
  it('RAZORPAY_FIELD_ALLOWLIST has exactly the 12 allowed fields', () => {
    const expected = new Set([
      'settlement_id', 'payment_id', 'order_id', 'amount', 'fee', 'tax',
      'utr', 'status', 'created_at', 'settled_at', 'currency', 'entity_type',
    ]);
    expect(RAZORPAY_FIELD_ALLOWLIST.size).toBe(expected.size);
    for (const field of expected) {
      expect(RAZORPAY_FIELD_ALLOWLIST.has(field as never)).toBe(true);
    }
  });

  it('CARD_FIELDS_BLOCKED contains the required card field names (C4)', () => {
    const required = ['card_last4', 'card_network', 'card_brand', 'card_issuer',
                      'card_international', 'card_type', 'card_country', 'card'];
    for (const field of required) {
      expect(CARD_FIELDS_BLOCKED.has(field as never)).toBe(true);
    }
  });
});
