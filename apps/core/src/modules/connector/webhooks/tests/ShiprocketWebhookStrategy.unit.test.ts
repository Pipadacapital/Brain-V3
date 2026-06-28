/**
 * ShiprocketWebhookStrategy unit tests — token verify + payload map + fail-closed guard.
 *
 * SW-1: signatureVerify — valid token → accepted; lookupKey = channel-id header
 * SW-2: signatureVerify — wrong token → throws HMAC_INVALID
 * SW-3: signatureVerify — unset webhook_secret (empty string) → throws HMAC_INVALID (fail-closed)
 * SW-4: signatureVerify — missing channel-id header → throws LOOKUP_KEY_MISSING
 * SW-5: signatureVerify — x-shiprocket-account-id fallback used when channel-id absent
 * SW-6: signatureVerify — body is not JSON → throws INVALID_JSON
 *
 * PM-1: payloadMap — shipment.update topic → canonical shipment event, skip=false
 * PM-2: payloadMap — tracking.update topic → canonical shipment event, skip=false
 * PM-3: payloadMap — non-shipment topic → skip=true (fast-ack, no event loss)
 * PM-4: payloadMap — missing order_id → throws INVALID_PAYLOAD
 * PM-5: payloadMap — AWB hashed at boundary; raw AWB never in output (I-S02)
 * PM-6: payloadMap — RTO Initiated status → terminal_class='rto', is_terminal=true
 * PM-7: payloadMap — deterministic event_id for same (brand, awb, status, ts)
 * PM-8: payloadMap — body with nested 'shipment' key works correctly
 * PM-9: payloadMap — body without nested key (flat) works correctly
 */

import { describe, it, expect } from 'vitest';
import { ShiprocketWebhookStrategy } from '../strategies/ShiprocketWebhookStrategy.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BRAND_A = 'aaaa0000-0000-4000-8000-000000000001';
const SALT_A = 'c'.repeat(64);
const CHANNEL_ID = 'sr_ch_test_001';
const VALID_TOKEN = 'sr-shared-api-key-test-value-001';

const strategy = new ShiprocketWebhookStrategy();

// ── getSecret mock builders ────────────────────────────────────────────────────

function makeGetSecret(webhookSecret: string) {
  return async (_lookupKey: string) => ({
    webhookSecret,
    connectorLookupKey: _lookupKey,
  });
}

// ── Payload builders ──────────────────────────────────────────────────────────

function makeShipmentBody(opts?: {
  topic?: string;
  nested?: boolean;
  orderId?: string;
  awb?: string;
  status?: string;
  statusChangedAt?: string;
}): Buffer {
  const {
    topic = 'shipment.update',
    nested = false,
    orderId = 'ORD-001',
    awb = 'SR9876543210',
    status = 'In-Transit',
    statusChangedAt = '2026-06-22T10:00:00.000Z',
  } = opts ?? {};

  const shipmentData = {
    awb,
    order_id: orderId,
    current_status: status,
    status_date: statusChangedAt,
    payment_method: 'COD',
    pincode: '110001',
    courier_name: 'Delhivery',
  };

  const body = nested
    ? { event: topic, shipment: shipmentData }
    : { event: topic, ...shipmentData };

  return Buffer.from(JSON.stringify(body));
}

function makeCtx(parsedBody: unknown) {
  return {
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
    headers: {},
    parsedBody,
    brandId: BRAND_A,
    saltHex: SALT_A,
    regionCode: 'IN',
    correlationId: 'corr-sw-test',
    requestId: 'req-sw-test',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SW: signatureVerify tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SW: ShiprocketWebhookStrategy — signatureVerify (token scheme)', () => {

  it('SW-1: valid token matches stored webhook_secret → accepted, lookupKey = channel-id', async () => {
    const body = makeShipmentBody();
    const headers = {
      'x-shiprocket-channel-id': CHANNEL_ID,
      'x-api-key': VALID_TOKEN,
    };

    const result = await strategy.signatureVerify(body, headers, makeGetSecret(VALID_TOKEN));

    expect(result.lookupKey).toBe(CHANNEL_ID);
    expect(result.parsedPayload).not.toBeNull();
  });

  it('SW-2: wrong token → throws HMAC_INVALID', async () => {
    const body = makeShipmentBody();
    const headers = {
      'x-shiprocket-channel-id': CHANNEL_ID,
      'x-api-key': 'wrong-token-value',
    };

    await expect(
      strategy.signatureVerify(body, headers, makeGetSecret(VALID_TOKEN)),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SW-3: unset webhook_secret (empty string) → throws HMAC_INVALID (fail-closed — not connected)', async () => {
    const body = makeShipmentBody();
    const headers = {
      'x-shiprocket-channel-id': CHANNEL_ID,
      'x-api-key': VALID_TOKEN,
    };

    // Simulate brand that has not configured their Shiprocket API key
    await expect(
      strategy.signatureVerify(body, headers, makeGetSecret('')),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SW-4: missing channel-id AND account-id headers → throws LOOKUP_KEY_MISSING', async () => {
    const body = makeShipmentBody();
    const headers = { 'x-api-key': VALID_TOKEN }; // no channel/account header

    await expect(
      strategy.signatureVerify(body, headers, makeGetSecret(VALID_TOKEN)),
    ).rejects.toMatchObject({ code: 'LOOKUP_KEY_MISSING' });
  });

  it('SW-5: x-shiprocket-account-id fallback when channel-id absent → accepted', async () => {
    const body = makeShipmentBody();
    const headers = {
      'x-shiprocket-account-id': 'sr_acct_fallback_001',
      'x-api-key': VALID_TOKEN,
    };

    const result = await strategy.signatureVerify(body, headers, makeGetSecret(VALID_TOKEN));
    expect(result.lookupKey).toBe('sr_acct_fallback_001');
  });

  it('SW-6: body is not valid JSON → throws INVALID_JSON', async () => {
    const badBody = Buffer.from('not-json{{{');
    const headers = {
      'x-shiprocket-channel-id': CHANNEL_ID,
      'x-api-key': VALID_TOKEN,
    };

    await expect(
      strategy.signatureVerify(badBody, headers, makeGetSecret(VALID_TOKEN)),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PM: payloadMap tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PM: ShiprocketWebhookStrategy — payloadMap', () => {

  it('PM-1: shipment.update topic → canonical shipment event, skip=false', async () => {
    const body = {
      event: 'shipment.update',
      awb: 'SR1111111111',
      order_id: 'ORD-SHIPROCKET-001',
      current_status: 'In-Transit',
      status_date: '2026-06-22T10:00:00.000Z',
      payment_method: 'COD',
      pincode: '110001',
      courier_name: 'Delhivery',
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe('shiprocket.shipment_status.v1');
    expect(result.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const props = result.properties as Record<string, unknown>;
    expect(props['source']).toBe('shiprocket');
    expect(props['order_id']).toBe('ORD-SHIPROCKET-001');
    // Raw AWB must not appear in the output
    expect(JSON.stringify(result)).not.toContain('SR1111111111');
  });

  it('PM-2: tracking.update topic → canonical shipment event, skip=false', async () => {
    const body = {
      event: 'tracking.update',
      awb: 'SR2222222222',
      order_id: 'ORD-SHIPROCKET-002',
      current_status: 'Out for Delivery',
      status_date: '2026-06-22T11:00:00.000Z',
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(false);
    expect(result.eventName).toBe('shiprocket.shipment_status.v1');
  });

  it('PM-3: non-shipment topic → skip=true (fast-ack, no event loss)', async () => {
    const body = { event: 'invoice.generated', order_id: 'ORD-003' };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
  });

  it('PM-4: missing order_id → throws INVALID_PAYLOAD', async () => {
    const body = {
      event: 'shipment.update',
      awb: 'SR3333333333',
      // order_id intentionally omitted
      current_status: 'In-Transit',
      status_date: '2026-06-22T10:00:00.000Z',
    };
    const ctx = makeCtx(body);
    await expect(strategy.payloadMap(ctx)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('PM-5: AWB is hashed at boundary; raw AWB never appears in output (I-S02)', async () => {
    const rawAwb = 'SR_SENSITIVE_AWB_XYZ_001';
    const body = {
      event: 'shipment.update',
      awb: rawAwb,
      order_id: 'ORD-PII-TEST',
      current_status: 'In-Transit',
      status_date: '2026-06-22T10:00:00.000Z',
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);

    expect(JSON.stringify(result)).not.toContain(rawAwb);
    const props = result.properties as Record<string, unknown>;
    // The hash is a 64-char hex string
    expect(typeof props['awb_number_hash']).toBe('string');
    expect((props['awb_number_hash'] as string).length).toBe(64);
  });

  it('PM-6: RTO Initiated status → terminal_class=rto, is_terminal=true', async () => {
    const body = {
      event: 'shipment.rto_initiated',
      awb: 'SR4444444444',
      order_id: 'ORD-RTO-001',
      current_status: 'RTO Initiated',
      status_date: '2026-06-22T12:00:00.000Z',
      payment_method: 'COD',
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    const props = result.properties as Record<string, unknown>;
    expect(props['terminal_class']).toBe('rto');
    expect(props['is_terminal']).toBe(true);
    expect(props['payment_method']).toBe('cod');
  });

  it('PM-7: deterministic event_id for same (brand, awb, status, ts)', async () => {
    const body = {
      event: 'shipment.update',
      awb: 'SR5555555555',
      order_id: 'ORD-DET-001',
      current_status: 'Delivered',
      status_date: '2026-06-22T10:00:00.000Z',
    };
    const ctx1 = makeCtx(body);
    const ctx2 = makeCtx(body);
    const r1 = await strategy.payloadMap(ctx1);
    const r2 = await strategy.payloadMap(ctx2);
    expect(r1.eventId).toBe(r2.eventId);
    expect(r1.skip).toBe(false);
  });

  it('PM-8: body with nested shipment key is parsed correctly', async () => {
    const body = {
      event: 'shipment.update',
      shipment: {
        awb: 'SR6666666666',
        order_id: 'ORD-NESTED-001',
        current_status: 'Out for Delivery',
        status_date: '2026-06-22T13:00:00.000Z',
        courier_name: 'BlueDart',
        pincode: '560001',
      },
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    const props = result.properties as Record<string, unknown>;
    expect(props['order_id']).toBe('ORD-NESTED-001');
    expect(props['courier']).toBe('BlueDart');
  });

  // SR-3: widened forward-lifecycle + RTO topic allowlist → mapped (skip=false). Previously these
  // dedicated pushes fell through to fast-ack skip=true and were silently dropped.
  it.each([
    'shipment.created',
    'shipment.picked_up',
    'shipment.in_transit',
    'shipment.delayed',
    'shipment.exception',
    'shipment.ndr',
    'shipment.lost',
    'shipment.destroyed',
    'shipment.rto_in_transit',
    'shipment.rto_undelivered',
    'shipment.rto_ndr',
    'shipment.rto_disposed',
  ])('PM-10: widened topic %s → mapped (skip=false)', async (topic) => {
    const body = {
      event: topic,
      awb: 'SR8888888888',
      order_id: 'ORD-WIDE-001',
      current_status: 'In-Transit',
      status_date: '2026-06-22T10:00:00.000Z',
    };
    const result = await strategy.payloadMap(makeCtx(body));
    expect(result.skip).toBe(false);
    expect(result.eventName).toBe('shiprocket.shipment_status.v1');
  });

  // SR-4: return.* topics now map to the SEPARATE canonical shiprocket.return_status.v1 event (NOT the
  // shipment lane). A return is NEVER routed through mapShiprocketShipment, so return.completed can never
  // mis-classify to a forward DELIVERED (the false-delivery / revenue-truth bug SR-4 fixes).
  it.each([
    ['return.created', 'return_initiated'],
    ['return.picked_up', 'return_in_transit'],
    ['return.delivered', 'return_delivered'],
    ['return.completed', 'return_completed'],
  ])('PM-11: return topic %s → mapped to shiprocket.return_status.v1 (class %s)', async (topic, expectedClass) => {
    // No explicit body status → the strategy derives the return stage from the topic suffix.
    const body = { event: topic, awb: 'SR9999999999', order_id: 'ORD-RET-001', status_date: '2026-06-22T10:00:00.000Z' };
    const result = await strategy.payloadMap(makeCtx(body));
    expect(result.skip).toBe(false);
    expect(result.eventName).toBe('shiprocket.return_status.v1');
    const props = result.properties as Record<string, unknown>;
    expect(props['return_class']).toBe(expectedClass);
    // CRITICAL: never a forward shipment terminal_class on the return lane.
    expect(props['terminal_class']).toBeUndefined();
  });

  // SR-4: an explicit body return-status still classifies on the return lane, NEVER as a forward delivery.
  it('PM-11b: return.completed with body status "completed" → return_completed, NOT a forward DELIVERED', async () => {
    const body = { event: 'return.completed', awb: 'SRRET2', order_id: 'ORD-RET-002', current_status: 'completed', status_date: '2026-06-22T10:00:00.000Z' };
    const result = await strategy.payloadMap(makeCtx(body));
    expect(result.eventName).toBe('shiprocket.return_status.v1');
    expect((result.properties as Record<string, unknown>)['return_class']).toBe('return_completed');
  });

  // A genuinely unknown topic (neither shipment nor return) still fast-acks skip=true — no event loss.
  it('PM-11c: unknown topic → fast-ack skip=true', async () => {
    const body = { event: 'wallet.credited', order_id: 'ORD-X', status_date: '2026-06-22T10:00:00.000Z' };
    const result = await strategy.payloadMap(makeCtx(body));
    expect(result.skip).toBe(true);
  });

  it('PM-9: body without nested key (flat envelope) parsed correctly', async () => {
    const body = {
      event: 'shipment.delivered',
      awb: 'SR7777777777',
      order_id: 'ORD-FLAT-001',
      current_status: 'Delivered',
      status_date: '2026-06-22T14:00:00.000Z',
    };
    const ctx = makeCtx(body);
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    const props = result.properties as Record<string, unknown>;
    expect(props['terminal_class']).toBe('delivered');
    expect(props['is_terminal']).toBe(true);
    expect(props['order_id']).toBe('ORD-FLAT-001');
  });
});
