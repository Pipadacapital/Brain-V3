/**
 * ShopfloWebhookStrategy unit tests — signature posture (verify-if-present) + strict lanes.
 *
 * Posture matrix (per instance, driven by the bundle's webhook_secret_origin marker):
 *   SP-1: signed correctly + origin 'minted'    → accepted (present ⇒ always verified).
 *   SP-2: signed correctly + origin 'merchant'  → accepted.
 *   SP-3: signed WRONG (any origin)             → HMAC_INVALID (tampering, never relaxed).
 *   SP-4: UNSIGNED + origin 'minted'            → ACCEPTED (verify-if-present; the merchant could
 *         not configure Brain's minted secret in Shopflo's UI — previously permanently-401).
 *   SP-5: UNSIGNED + origin 'merchant'          → HMAC_INVALID (they configured a secret ⇒ expected).
 *   SP-6: UNSIGNED + origin ABSENT (legacy)     → HMAC_INVALID (fail-closed default unchanged).
 *   SP-7: UNSIGNED + origin 'minted' + SHOPFLO_REQUIRE_SIGNATURE=1 → HMAC_INVALID (operator force).
 *   SP-8: no resolvable secret at all           → HMAC_INVALID regardless of posture.
 *   SP-9: merchant_id missing                   → HMAC_INVALID; invalid JSON → INVALID_JSON.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { ShopfloWebhookStrategy } from '../strategies/ShopfloWebhookStrategy.js';

const MERCHANT = 'mrc_posture_001';
const SECRET = 'shopflo-webhook-secret-posture-test-001';
const SIG_HEADER = 'x-shopflo-signature';

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function makeBody(over?: Record<string, unknown>): string {
  return JSON.stringify({
    merchant_id: MERCHANT,
    event: 'order.created',
    occurred_at: new Date().toISOString(),
    ...over,
  });
}

function getSecretStub(opts: { secret?: string; origin?: string }) {
  return async (lookupKey: string) => ({
    webhookSecret: opts.secret ?? '',
    connectorLookupKey: lookupKey,
    ...(opts.origin !== undefined ? { webhookSecretOrigin: opts.origin } : {}),
  });
}

afterEach(() => {
  delete process.env['SHOPFLO_REQUIRE_SIGNATURE'];
});

describe('ShopfloWebhookStrategy.signatureVerify — posture matrix', () => {
  const strategy = new ShopfloWebhookStrategy();

  it('SP-1: valid signature + minted origin → accepted', async () => {
    const body = makeBody();
    const headers = { [SIG_HEADER]: signBody(body, SECRET) };
    const result = await strategy.signatureVerify(
      Buffer.from(body), headers, getSecretStub({ secret: SECRET, origin: 'minted' }),
    );
    expect(result.lookupKey).toBe(MERCHANT);
  });

  it('SP-2: valid signature + merchant origin → accepted', async () => {
    const body = makeBody();
    const headers = { [SIG_HEADER]: signBody(body, SECRET) };
    const result = await strategy.signatureVerify(
      Buffer.from(body), headers, getSecretStub({ secret: SECRET, origin: 'merchant' }),
    );
    expect(result.lookupKey).toBe(MERCHANT);
  });

  it('SP-3: WRONG signature is rejected even under the relaxed minted posture (tampering)', async () => {
    const body = makeBody();
    const headers = { [SIG_HEADER]: signBody(body, 'the-wrong-secret') };
    await expect(
      strategy.signatureVerify(Buffer.from(body), headers, getSecretStub({ secret: SECRET, origin: 'minted' })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SP-4: UNSIGNED delivery + minted origin → ACCEPTED (verify-if-present, the 401-forever fix)', async () => {
    const body = makeBody();
    const result = await strategy.signatureVerify(
      Buffer.from(body), {}, getSecretStub({ secret: SECRET, origin: 'minted' }),
    );
    expect(result.lookupKey).toBe(MERCHANT);
    expect(result.parsedPayload).toMatchObject({ merchant_id: MERCHANT });
  });

  it('SP-5: UNSIGNED delivery + merchant-supplied secret → HMAC_INVALID (signatures expected)', async () => {
    const body = makeBody();
    await expect(
      strategy.signatureVerify(Buffer.from(body), {}, getSecretStub({ secret: SECRET, origin: 'merchant' })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SP-6: UNSIGNED delivery + NO origin marker (legacy bundle) → HMAC_INVALID (fail-closed default)', async () => {
    const body = makeBody();
    await expect(
      strategy.signatureVerify(Buffer.from(body), {}, getSecretStub({ secret: SECRET })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SP-7: SHOPFLO_REQUIRE_SIGNATURE=1 forces strict even for minted origin', async () => {
    process.env['SHOPFLO_REQUIRE_SIGNATURE'] = '1';
    const body = makeBody();
    await expect(
      strategy.signatureVerify(Buffer.from(body), {}, getSecretStub({ secret: SECRET, origin: 'minted' })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SP-8: no resolvable secret → HMAC_INVALID regardless of posture (nothing proven to relax on)', async () => {
    const body = makeBody();
    await expect(
      strategy.signatureVerify(Buffer.from(body), {}, getSecretStub({ origin: 'minted' })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('SP-9: merchant_id missing → HMAC_INVALID; invalid JSON → INVALID_JSON', async () => {
    const noMerchant = JSON.stringify({ event: 'order.created' });
    await expect(
      strategy.signatureVerify(Buffer.from(noMerchant), {}, getSecretStub({ secret: SECRET, origin: 'minted' })),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });

    await expect(
      strategy.signatureVerify(Buffer.from('{not json'), {}, getSecretStub({ secret: SECRET })),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });
});
