/**
 * RazorpayWebhookStrategy unit tests — new event types + grace-window.
 *
 * Tests:
 *   GW-1: signatureVerify — valid current secret → accepted
 *   GW-2: signatureVerify — invalid secret, no previous secret → HMAC_INVALID
 *   GW-3: signatureVerify — invalid current secret, valid previous within TTL → accepted (grace window)
 *   GW-4: signatureVerify — invalid current secret, valid previous but EXPIRED → HMAC_INVALID
 *   GW-5: signatureVerify — invalid current secret, previous secret present but wrong HMAC → HMAC_INVALID
 *
 *   PM-1: payloadMap — refund.processed → settlement.live.v1, entity_type='refund', skip=false
 *   PM-2: payloadMap — refund.failed → settlement.live.v1, entity_type='refund', skip=false
 *   PM-3: payloadMap — refund.processed without payload → skip=true (fast-ack, no loss)
 *   PM-4: payloadMap — payment.dispute.created → entity_type='dispute', dispute_direction='debit'
 *   PM-5: payloadMap — payment.dispute.under_review → entity_type='dispute', dispute_direction='debit'
 *   PM-6: payloadMap — payment.dispute.won → entity_type='dispute', dispute_direction='credit'
 *   PM-7: payloadMap — payment.dispute.lost → entity_type='dispute', dispute_direction='debit' (REVENUE REVERSAL)
 *   PM-8: payloadMap — payment.dispute.lost without payload → skip=true
 *   PM-9: payloadMap — order.paid → entity_type='order_paid', skip=false
 *   PM-10: payloadMap — order.paid without payload → skip=true
 *   PM-11: payloadMap — payment.authorized → entity_type='payment_authorized', skip=false
 *   PM-12: payloadMap — payment.authorized without payload → skip=true
 *   PM-13: payloadMap — unknown event → skip=true (fast-ack, no event loss)
 *   PM-14: payloadMap — refund.processed and refund.failed for same eventId → DISTINCT eventIds (type discriminator)
 *   PM-15: payloadMap — all dispute lifecycle stages for same eventId → 4 DISTINCT eventIds
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { RazorpayWebhookStrategy, GRACE_WINDOW_SECONDS } from '../strategies/RazorpayWebhookStrategy.js';
import { SETTLEMENT_LIVE_V1_EVENT_NAME } from '@brain/razorpay-mapper';

// ── Test constants ─────────────────────────────────────────────────────────────

const BRAND_A = 'c07ec701-0a00-4a00-8a00-111100000001';
const SALT_A = 'a'.repeat(64);
const ACCOUNT_A = 'acc_strattest001';
const CURRENT_SECRET = 'current-webhook-secret-strategy-test-001';
const PREVIOUS_SECRET = 'previous-webhook-secret-strategy-test-001';
const EVENT_ID = 'evt_strattest001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function makeEnvelope(opts: {
  accountId?: string;
  event?: string;
  eventId?: string;
  createdAt?: number;
  payload?: unknown;
}): string {
  return JSON.stringify({
    id: opts.eventId ?? EVENT_ID,
    entity: 'event',
    account_id: opts.accountId ?? ACCOUNT_A,
    event: opts.event ?? 'test.unknown',
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

function makeRefundPayload(opts?: { status?: string }): unknown {
  return {
    refund: {
      entity: {
        id: 'rfnd_StratTest001',
        payment_id: 'pay_StratTest001',
        amount: 50000,
        currency: 'INR',
        status: opts?.status ?? 'processed',
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  };
}

function makeDisputePayload(opts?: { status?: string }): unknown {
  return {
    dispute: {
      entity: {
        id: 'disp_StratTest001',
        payment_id: 'pay_StratTest001',
        amount: 100000,
        currency: 'INR',
        reason_code: 'FROD',
        status: opts?.status ?? 'open',
        created_at: Math.floor(Date.now() / 1000),
        respond_by: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      },
    },
  };
}

function makeOrderPayload(): unknown {
  return {
    order: {
      entity: {
        id: 'order_StratTest001',
        amount: 200000,
        currency: 'INR',
        status: 'paid',
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  };
}

function makePaymentPayload(): unknown {
  return {
    payment: {
      entity: {
        id: 'pay_StratTest001',
        order_id: 'order_StratTest001',
        amount: 150000,
        currency: 'INR',
        status: 'authorized',
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  };
}

/**
 * Build a mock getSecret that returns the current secret and optionally the previous one
 * with a given TTL (as an absolute ISO-8601 expiry).
 */
function makeGetSecret(opts: {
  webhookSecret: string;
  previousWebhookSecret?: string;
  previousWebhookSecretExpiresAt?: string;  // ISO-8601 UTC
}): (lookupKey: string) => Promise<{
  webhookSecret: string;
  connectorLookupKey: string;
  previousWebhookSecret?: string;
  previousWebhookSecretExpiresAt?: string;
}> {
  return async (_lookupKey: string) => ({
    webhookSecret: opts.webhookSecret,
    connectorLookupKey: `ci_${_lookupKey}`,
    ...(opts.previousWebhookSecret !== undefined
      ? { previousWebhookSecret: opts.previousWebhookSecret }
      : {}),
    ...(opts.previousWebhookSecretExpiresAt !== undefined
      ? { previousWebhookSecretExpiresAt: opts.previousWebhookSecretExpiresAt }
      : {}),
  });
}

function futureIso(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function pastIso(offsetSeconds: number): string {
  return new Date(Date.now() - offsetSeconds * 1000).toISOString();
}

// ── Strategy instance ─────────────────────────────────────────────────────────

const strategy = new RazorpayWebhookStrategy();

// ─────────────────────────────────────────────────────────────────────────────
// GW: Grace-window tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GW: RazorpayWebhookStrategy — old-secret grace window', () => {

  it('GW-1: valid current secret → accepted (normal path)', async () => {
    const body = makeEnvelope({ event: 'refund.processed', payload: makeRefundPayload() });
    const sig = signBody(body, CURRENT_SECRET);
    const rawBody = Buffer.from(body);

    const result = await strategy.signatureVerify(
      rawBody,
      { 'x-razorpay-signature': sig },
      makeGetSecret({ webhookSecret: CURRENT_SECRET }),
    );

    expect(result.lookupKey).toBe(ACCOUNT_A);
  });

  it('GW-2: invalid secret, no previous_webhook_secret → throws HMAC_INVALID', async () => {
    const body = makeEnvelope({ event: 'refund.processed' });
    const badSig = signBody(body, 'wrong-secret');
    const rawBody = Buffer.from(body);

    await expect(
      strategy.signatureVerify(
        rawBody,
        { 'x-razorpay-signature': badSig },
        makeGetSecret({ webhookSecret: CURRENT_SECRET }),
      ),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('GW-3: invalid current secret, valid previous within grace TTL → accepted (grace window)', async () => {
    const body = makeEnvelope({ event: 'refund.processed', payload: makeRefundPayload() });
    // Sign with the PREVIOUS secret (simulates in-flight events from before rotation)
    const sig = signBody(body, PREVIOUS_SECRET);
    const rawBody = Buffer.from(body);

    const result = await strategy.signatureVerify(
      rawBody,
      { 'x-razorpay-signature': sig },
      makeGetSecret({
        webhookSecret: CURRENT_SECRET,                      // current — won't match
        previousWebhookSecret: PREVIOUS_SECRET,            // old — will match
        previousWebhookSecretExpiresAt: futureIso(GRACE_WINDOW_SECONDS), // still active
      }),
    );

    expect(result.lookupKey).toBe(ACCOUNT_A);
  });

  it('GW-4: invalid current secret, valid previous but EXPIRED → throws HMAC_INVALID', async () => {
    const body = makeEnvelope({ event: 'refund.processed' });
    const sig = signBody(body, PREVIOUS_SECRET);
    const rawBody = Buffer.from(body);

    await expect(
      strategy.signatureVerify(
        rawBody,
        { 'x-razorpay-signature': sig },
        makeGetSecret({
          webhookSecret: CURRENT_SECRET,
          previousWebhookSecret: PREVIOUS_SECRET,
          previousWebhookSecretExpiresAt: pastIso(1), // 1 second in the past — expired
        }),
      ),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('GW-5: invalid current secret, previous present but wrong HMAC → throws HMAC_INVALID', async () => {
    const body = makeEnvelope({ event: 'refund.processed' });
    const sig = signBody(body, 'some-other-secret-entirely');
    const rawBody = Buffer.from(body);

    await expect(
      strategy.signatureVerify(
        rawBody,
        { 'x-razorpay-signature': sig },
        makeGetSecret({
          webhookSecret: CURRENT_SECRET,
          previousWebhookSecret: PREVIOUS_SECRET,           // different from signing key
          previousWebhookSecretExpiresAt: futureIso(300),
        }),
      ),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PM: payloadMap tests for new event types
// ─────────────────────────────────────────────────────────────────────────────

function makePayloadCtx(eventName: string, payload?: unknown) {
  const envelope = JSON.parse(makeEnvelope({ event: eventName, payload }));
  return {
    rawBody: Buffer.from('{}'),
    headers: {},
    parsedBody: envelope,
    brandId: BRAND_A,
    saltHex: SALT_A,
    regionCode: 'IN',
    correlationId: 'test-corr-001',
    requestId: 'test-req-001',
  };
}

describe('PM: payloadMap — refund.processed / refund.failed', () => {

  it('PM-1: refund.processed → settlement.live.v1, entity_type=refund, skip=false', async () => {
    const ctx = makePayloadCtx('refund.processed', makeRefundPayload({ status: 'processed' }));
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
    expect((result.properties as Record<string, unknown>)['entity_type']).toBe('refund');
    expect(result.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('PM-2: refund.failed → settlement.live.v1, entity_type=refund, skip=false', async () => {
    const ctx = makePayloadCtx('refund.failed', makeRefundPayload({ status: 'failed' }));
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
    expect((result.properties as Record<string, unknown>)['entity_type']).toBe('refund');
  });

  it('PM-3: refund.processed without refund entity → skip=true (fast-ack, no loss)', async () => {
    const ctx = makePayloadCtx('refund.processed'); // no payload
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
  });

  it('PM-14: refund.processed and refund.failed for the same eventId → DISTINCT Bronze eventIds', async () => {
    const sharedEventId = 'evt_shared001';
    const ctxProcessed = makePayloadCtx('refund.processed', makeRefundPayload());
    const ctxFailed    = makePayloadCtx('refund.failed',    makeRefundPayload({ status: 'failed' }));
    // Override the eventId in both envelopes to be the same
    (ctxProcessed.parsedBody as Record<string, unknown>)['id'] = sharedEventId;
    (ctxFailed.parsedBody as Record<string, unknown>)['id'] = sharedEventId;

    const r1 = await strategy.payloadMap(ctxProcessed);
    const r2 = await strategy.payloadMap(ctxFailed);

    // With entity_type discriminator: same eventId + different event name → DISTINCT Bronze rows
    expect(r1.eventId).not.toBe(r2.eventId);
  });
});

describe('PM: payloadMap — payment.dispute.* lifecycle', () => {

  it('PM-4: payment.dispute.created → entity_type=dispute, dispute_direction=debit', async () => {
    const ctx = makePayloadCtx('payment.dispute.created', makeDisputePayload());
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
    const props = result.properties as Record<string, unknown>;
    expect(props['entity_type']).toBe('dispute');
    expect(props['dispute_lifecycle']).toBe('dispute.created');
    expect(props['dispute_direction']).toBe('debit');
  });

  it('PM-5: payment.dispute.under_review → dispute_direction=debit', async () => {
    const ctx = makePayloadCtx('payment.dispute.under_review', makeDisputePayload({ status: 'under_review' }));
    const result = await strategy.payloadMap(ctx);

    const props = result.properties as Record<string, unknown>;
    expect(props['dispute_direction']).toBe('debit');
    expect(props['dispute_lifecycle']).toBe('dispute.under_review');
    expect(result.skip).toBe(false);
  });

  it('PM-6: payment.dispute.won → dispute_direction=credit (money returned)', async () => {
    const ctx = makePayloadCtx('payment.dispute.won', makeDisputePayload({ status: 'won' }));
    const result = await strategy.payloadMap(ctx);

    const props = result.properties as Record<string, unknown>;
    expect(props['dispute_direction']).toBe('credit');
    expect(props['dispute_lifecycle']).toBe('dispute.won');
    expect(result.skip).toBe(false);
  });

  it('PM-7: payment.dispute.lost → dispute_direction=debit (REVENUE REVERSAL)', async () => {
    const ctx = makePayloadCtx('payment.dispute.lost', makeDisputePayload({ status: 'lost' }));
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    const props = result.properties as Record<string, unknown>;
    expect(props['entity_type']).toBe('dispute');
    expect(props['dispute_lifecycle']).toBe('dispute.lost');
    // REVENUE REVERSAL: direction=debit, amount is positive integer (sign semantic via direction)
    expect(props['dispute_direction']).toBe('debit');
    expect(typeof props['amount_minor']).toBe('string');
    expect((props['amount_minor'] as string)).toMatch(/^\d+$/);
  });

  it('PM-8: payment.dispute.lost without dispute entity → skip=true (fast-ack)', async () => {
    const ctx = makePayloadCtx('payment.dispute.lost'); // no payload
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
  });

  it('PM-15: all 4 dispute lifecycle stages for same eventId → 4 DISTINCT Bronze eventIds', async () => {
    const sharedEventId = 'evt_shared_dispute001';
    const lifecycles = [
      'payment.dispute.created',
      'payment.dispute.under_review',
      'payment.dispute.won',
      'payment.dispute.lost',
    ];

    const ids = await Promise.all(
      lifecycles.map(async (eventName) => {
        const ctx = makePayloadCtx(eventName, makeDisputePayload());
        (ctx.parsedBody as Record<string, unknown>)['id'] = sharedEventId;
        const r = await strategy.payloadMap(ctx);
        return r.eventId;
      }),
    );

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(4); // each lifecycle stage → distinct Bronze row
  });
});

describe('PM: payloadMap — order.paid', () => {

  it('PM-9: order.paid → entity_type=order_paid, skip=false', async () => {
    const ctx = makePayloadCtx('order.paid', makeOrderPayload());
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
    const props = result.properties as Record<string, unknown>;
    expect(props['entity_type']).toBe('order_paid');
    expect(result.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('PM-10: order.paid without order entity → skip=true (fast-ack)', async () => {
    const ctx = makePayloadCtx('order.paid'); // no payload
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
  });
});

describe('PM: payloadMap — payment.authorized', () => {

  it('PM-11: payment.authorized → entity_type=payment_authorized, skip=false', async () => {
    const ctx = makePayloadCtx('payment.authorized', makePaymentPayload());
    const result = await strategy.payloadMap(ctx);

    expect(result.skip).toBe(false);
    expect(result.eventName).toBe(SETTLEMENT_LIVE_V1_EVENT_NAME);
    const props = result.properties as Record<string, unknown>;
    expect(props['entity_type']).toBe('payment_authorized');
    expect(result.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('PM-12: payment.authorized without payment entity → skip=true (fast-ack)', async () => {
    const ctx = makePayloadCtx('payment.authorized'); // no payload
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
  });
});

describe('PM: payloadMap — unknown events', () => {

  it('PM-13: unknown event type → skip=true (fast-ack, no event loss)', async () => {
    const ctx = makePayloadCtx('subscription.activated');
    const result = await strategy.payloadMap(ctx);
    expect(result.skip).toBe(true);
    // eventId is the raw envelope.id (fast-ack preserves it for dedup tracking)
    expect(result.eventId).toBe(EVENT_ID);
  });
});
