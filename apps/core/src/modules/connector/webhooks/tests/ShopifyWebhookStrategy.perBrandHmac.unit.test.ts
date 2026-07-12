/**
 * ShopifyWebhookStrategy per-brand HMAC unit tests (generic per-brand connect, 2026-07-12).
 *
 * Shopify signs webhooks with the app `client_secret`. On the generic per-brand connect path each
 * brand has its OWN custom app, so signatureVerify MUST verify against the PER-BRAND secret the
 * resolver returns (registerWebhookRoutes: shop domain → brand → `brain/connector/shopify_app/
 * <brandId>` bundle) — never a shared env secret. Proves:
 *   1. A webhook signed with brand A's client_secret verifies when the resolver returns A's secret.
 *   2. The SAME payload signed with a DIFFERENT brand's secret is rejected (HMAC_INVALID).
 *   3. Resolver returning '' (unknown shop / no stored creds) → fail-closed HMAC_INVALID.
 *   4. A bundle-provisioned webhook_secret takes precedence over the resolver (CRIT-2 order).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';

const SHOP_A = 'brand-a.myshopify.com';
const SECRET_A = 'brand-a-custom-app-client-secret';
const SECRET_B = 'brand-b-custom-app-client-secret';

const BODY = Buffer.from(JSON.stringify({ id: 123, updated_at: '2026-07-12T00:00:00Z' }), 'utf8');

function sign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function headersFor(shopDomain: string, hmac: string): Record<string, string> {
  return {
    'x-shopify-shop-domain': shopDomain,
    'x-shopify-hmac-sha256': hmac,
    'x-shopify-topic': 'orders/create',
  };
}

/** Pipeline getSecret stub — bundle webhook_secret ('' unless overridden). */
function bundleSecret(webhookSecret = '') {
  return vi.fn(async (lookupKey: string) => ({ webhookSecret, connectorLookupKey: lookupKey }));
}

describe('ShopifyWebhookStrategy — per-brand HMAC', () => {
  it('verifies a webhook signed with the brand-resolved client_secret', async () => {
    const resolver = vi.fn(async (_shop: string) => SECRET_A);
    const strategy = new ShopifyWebhookStrategy(resolver);

    const result = await strategy.signatureVerify(
      BODY,
      headersFor(SHOP_A, sign(BODY, SECRET_A)),
      bundleSecret(),
    );

    expect(result.lookupKey).toBe(SHOP_A);
    expect(resolver).toHaveBeenCalledWith(SHOP_A);
  });

  it("rejects the same payload signed with ANOTHER brand's secret (tenant isolation)", async () => {
    const strategy = new ShopifyWebhookStrategy(async () => SECRET_A);

    await expect(
      strategy.signatureVerify(BODY, headersFor(SHOP_A, sign(BODY, SECRET_B)), bundleSecret()),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('fails closed when the resolver has no secret for the shop', async () => {
    const strategy = new ShopifyWebhookStrategy(async () => '');

    await expect(
      strategy.signatureVerify(BODY, headersFor(SHOP_A, sign(BODY, SECRET_A)), bundleSecret()),
    ).rejects.toMatchObject({ code: 'HMAC_INVALID' });
  });

  it('bundle webhook_secret wins over the resolver (CRIT-2 priority order)', async () => {
    const bundleKey = 'explicitly-provisioned-webhook-secret';
    const resolver = vi.fn(async () => SECRET_A);
    const strategy = new ShopifyWebhookStrategy(resolver);

    // Signed with the bundle key — must verify WITHOUT consulting the resolver.
    const result = await strategy.signatureVerify(
      BODY,
      headersFor(SHOP_A, sign(BODY, bundleKey)),
      bundleSecret(bundleKey),
    );
    expect(result.lookupKey).toBe(SHOP_A);
    expect(resolver).not.toHaveBeenCalled();
  });
});
