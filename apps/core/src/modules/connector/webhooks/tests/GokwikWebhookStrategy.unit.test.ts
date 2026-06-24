/**
 * GokwikWebhookStrategy unit tests — HMAC gate (fail-closed) + I-S02-safe lossless mapping.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { GokwikWebhookStrategy, GOKWIK_WEBHOOK_EVENT_NAME } from '../strategies/GokwikWebhookStrategy.js';
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

describe('GokwikWebhookStrategy.payloadMap', () => {
  const s = new GokwikWebhookStrategy();

  it('maps safe fields, hashes PII (no raw email/phone), emits gokwik.webhook.v1', async () => {
    const body = {
      appid: APPID, event: 'order.delivered', order_id: 'OID42', payment_status: 'paid',
      currency: 'INR', amount: 1299, email: 'buyer@example.com', phone: '+919876543210',
      address: '12 MG Road', customer_name: 'Asha',
    };
    const res = await s.payloadMap(ctx(body));

    expect(res.eventName).toBe(GOKWIK_WEBHOOK_EVENT_NAME);
    expect(res.skip).toBe(false);
    expect(res.properties['order_id']).toBe('OID42');
    expect(res.properties['payment_status']).toBe('paid');
    expect(res.properties['amount_raw']).toBe('1299');
    // PII: hashed, never raw; raw PII + non-allowlisted fields absent.
    expect(res.properties['email_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.properties['phone_hash']).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(res.properties);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('MG Road');
    expect(res.properties['customer_name']).toBeUndefined();
  });

  it('produces a deterministic eventId for the same (brand, event, order)', async () => {
    const body = { appid: APPID, event: 'order.shipped', order_id: 'OID7' };
    const a = await s.payloadMap(ctx(body));
    const b = await s.payloadMap(ctx(body));
    expect(a.eventId).toBe(b.eventId);
    expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
