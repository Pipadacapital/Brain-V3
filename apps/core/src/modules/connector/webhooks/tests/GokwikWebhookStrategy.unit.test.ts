/**
 * GokwikWebhookStrategy unit tests — HMAC gate (fail-closed) + discriminated canonical-event mapping.
 *
 * The strategy DISCRIMINATES on the GoKwik event type and emits exactly ONE canonical Brain event
 * (order.live.v1 / checkout.abandoned.v1 / gokwik.checkout_started|step.v1 / payment.attempted|
 * authorized.v1 / gokwik.rto_predict.v1). Money is bigint minor units; raw PII is hashed at the
 * boundary; unknown types fast-ack (skip:true). The opaque gokwik.webhook.v1 envelope is RETIRED.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { GokwikWebhookStrategy } from '../strategies/GokwikWebhookStrategy.js';
import type { WebhookStrategyContext } from '../platform/IWebhookStrategy.js';

const APPID = '2ed4ab74a5b14a3382ba14b01ecfa6f6';
const SECRET = 'gokwik-webhook-signing-secret-001';
const BRAND = 'c07ec701-0a00-4a00-8a00-1111000000aa';
const SALT = 'a'.repeat(64);

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}
const getSecret = (webhookSecret: string) => async () => ({ webhookSecret, connectorLookupKey: APPID });

function ctx(parsedBody: unknown): WebhookStrategyContext {
  return {
    rawBody: Buffer.from(''), headers: {}, parsedBody, brandId: BRAND, saltHex: SALT,
    regionCode: 'IN', correlationId: 'c', requestId: 'r',
  };
}

describe('GokwikWebhookStrategy.signatureVerify', () => {
  const s = new GokwikWebhookStrategy();

  it('accepts a valid HMAC and returns the appid lookup key (from body)', async () => {
    const body = JSON.stringify({ appid: APPID, event: 'order.update', order_id: 'OID1' });
    const res = await s.signatureVerify(
      Buffer.from(body), { 'x-gokwik-signature': sign(body, SECRET) }, getSecret(SECRET),
    );
    expect(res.lookupKey).toBe(APPID);
  });

  it('reads appid from the x-gokwik-appid header when absent in body', async () => {
    const body = JSON.stringify({ event: 'order.update' });
    const res = await s.signatureVerify(
      Buffer.from(body), { 'x-gokwik-signature': sign(body, SECRET), 'x-gokwik-appid': APPID }, getSecret(SECRET),
    );
    expect(res.lookupKey).toBe(APPID);
  });

  it('FAILS CLOSED when no webhook_secret is configured (empty secret)', async () => {
    const body = JSON.stringify({ appid: APPID });
    await expect(
      s.signatureVerify(Buffer.from(body), { 'x-gokwik-signature': sign(body, SECRET) }, getSecret('')),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('rejects a bad signature', async () => {
    const body = JSON.stringify({ appid: APPID });
    await expect(
      s.signatureVerify(Buffer.from(body), { 'x-gokwik-signature': 'deadbeef' }, getSecret(SECRET)),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('rejects when the appid lookup key is missing', async () => {
    const body = JSON.stringify({ event: 'x' });
    await expect(
      s.signatureVerify(Buffer.from(body), { 'x-gokwik-signature': sign(body, SECRET) }, getSecret(SECRET)),
    ).rejects.toMatchObject({ code: 'LOOKUP_KEY_MISSING' });
  });

  it('rejects invalid JSON', async () => {
    await expect(
      s.signatureVerify(Buffer.from('not-json'), {}, getSecret(SECRET)),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });
});

describe('GokwikWebhookStrategy.payloadMap — discriminated canonical emit', () => {
  const s = new GokwikWebhookStrategy();

  it('order.* → order.live.v1 (minor-units money, hashed PII, no raw email/phone)', async () => {
    const body = {
      appid: APPID, event: 'order.created', moid: 'OID42', total: '1299.00',
      currency: 'INR', payment_method: 'cod', email: 'buyer@example.com', phone: '+919876543210',
      updated_at: '2026-05-05T16:00:00Z',
    };
    const res = await s.payloadMap(ctx(body));
    expect(res.skip).toBe(false);
    expect(res.eventName).toBe('order.live.v1');
    expect(res.properties['order_id']).toBe('OID42');
    expect(res.properties['amount_minor']).toBe('129900');
    expect(res.properties['currency_code']).toBe('INR');
    expect(res.properties['payment_method']).toBe('cod');
    expect(res.eventId).toMatch(/^[0-9a-f-]{36}$/);
    const serialized = JSON.stringify(res.properties);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('9876543210');
  });

  it('order.failed → order.live.v1 financial_status=voided', async () => {
    const body = { appid: APPID, event: 'order.failed', moid: 'OID9', total: '500', currency: 'INR', updated_at: '2026-05-05T16:00:00Z' };
    const res = await s.payloadMap(ctx(body));
    expect(res.eventName).toBe('order.live.v1');
    expect(res.properties['financial_status']).toBe('voided');
  });

  it('checkout.abandoned → checkout.abandoned.v1', async () => {
    const body = { appid: APPID, event: 'checkout.abandoned', checkout_id: 'CHK1', total: '999.00', currency: 'INR', pincode: '110001', updated_at: '2026-05-05T16:00:00Z' };
    const res = await s.payloadMap(ctx(body));
    expect(res.skip).toBe(false);
    expect(res.eventName).toBe('checkout.abandoned.v1');
    expect(res.properties['total_price_minor']).toBe('99900');
    expect(res.properties['has_address']).toBe(true);
  });

  it('checkout.started / checkout.step_completed → gokwik.checkout_started|step.v1', async () => {
    const started = await s.payloadMap(ctx({ appid: APPID, event: 'checkout.started', checkout_id: 'CHK2', updated_at: '2026-05-05T16:00:00Z' }));
    expect(started.eventName).toBe('gokwik.checkout_started.v1');
    const step = await s.payloadMap(ctx({ appid: APPID, event: 'checkout.step_completed', checkout_id: 'CHK3', step: 'address', updated_at: '2026-05-05T16:00:00Z' }));
    expect(step.eventName).toBe('gokwik.checkout_step.v1');
    expect(step.properties['step_name']).toBe('address');
  });

  it('payment.attempted / payment.authorized → payment.*.v1 (payment_id hashed, raw dropped)', async () => {
    const attempted = await s.payloadMap(ctx({ appid: APPID, event: 'payment.attempted', order_id: 'OID42', payment_id: 'pay_xyz', amount: '1299.00', currency: 'INR', updated_at: '2026-05-05T16:05:00Z' }));
    expect(attempted.eventName).toBe('payment.attempted.v1');
    expect(attempted.properties['payment_status']).toBe('initiated');
    expect(JSON.stringify(attempted.properties)).not.toContain('pay_xyz');
    expect(attempted.properties['payment_id_hash']).toMatch(/^[0-9a-f]{64}$/);

    const authorized = await s.payloadMap(ctx({ appid: APPID, event: 'payment.authorized', order_id: 'OID42', payment_id: 'pay_xyz', amount: '1299.00', currency: 'INR', updated_at: '2026-05-05T16:05:00Z' }));
    expect(authorized.eventName).toBe('payment.authorized.v1');
    expect(authorized.properties['payment_status']).toBe('authorized');
  });

  it('risk.scored → gokwik.rto_predict.v1 (categorical, verbatim risk_flag_raw)', async () => {
    const body = { appid: APPID, event: 'risk.scored', order_id: 'OID42', request_id: 'req_1', risk_flag: 'High Risk' };
    const res = await s.payloadMap(ctx(body));
    expect(res.eventName).toBe('gokwik.rto_predict.v1');
    expect(res.properties['risk_flag']).toBe('high');
    expect(res.properties['risk_flag_raw']).toBe('High Risk');
    expect(JSON.stringify(res.properties)).not.toMatch(/"(score|probability|risk_score)"\s*:/);
  });

  it('unknown event type → skip (fast-ack, no produce)', async () => {
    const res = await s.payloadMap(ctx({ appid: APPID, event: 'wishlist.added', order_id: 'X' }));
    expect(res.skip).toBe(true);
  });

  it('same order state replay → deterministic eventId', async () => {
    const body = { appid: APPID, event: 'order.updated', moid: 'OID7', total: '10', currency: 'INR', updated_at: '2026-05-05T16:00:00Z' };
    const a = await s.payloadMap(ctx(body));
    const b = await s.payloadMap(ctx(body));
    expect(a.eventId).toBe(b.eventId);
    expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('missing payload timestamp → mapper throws (pipeline surfaces a 400 skip, never a wall-clock id)', async () => {
    // FAIL-CLOSED contract: a mappable event with NO updated_at/event_time/created_at/timestamp must
    // NOT mint a wall-clock occurred_at (it seeds the deterministic event_id → redelivery would mint a
    // NEW id = permanent Bronze duplicate). The throw is caught by WebhookPipeline's payloadMap catch
    // → 400 INVALID_PAYLOAD (a logged skip, not a 500 retry loop).
    await expect(
      s.payloadMap(ctx({ appid: APPID, event: 'order.updated', moid: 'OID-NT', total: '10' })),
    ).rejects.toThrow(/timestamp/);
    await expect(
      s.payloadMap(ctx({ appid: APPID, event: 'payment.attempted', order_id: 'OID-NT' })),
    ).rejects.toThrow(/timestamp/);
  });
});
