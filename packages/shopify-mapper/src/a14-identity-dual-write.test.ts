// SPEC: A.1.4
/**
 * A.1.4 (WA-09) — Shopify connector identity dual-write tests.
 *
 *   A1.4.1 flag OFF  → BYTE-IDENTICAL envelope (no interop keys; §0.5 non-negotiable).
 *   A1.4.2 flag ON   → email_sha256/phone_sha256 emitted ALONGSIDE the unchanged salted fields.
 *   A1.4.3 BRIDGE-FIX PROOF (AMD-01 R1): the connector's interop email hash equals the hash the
 *          PIXEL computes client-side for the same email (plain unsalted sha256 of
 *          trim+lowercase — pixel-sdk/src/asset/runtime.ts identify()). This is the exact
 *          equality that was impossible with salted-only fields (the live broken anon→known
 *          bridge) and is what makes pixel identify events joinable with connector identities.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailInteropHash, phoneInteropHash } from '@brain/identity-normalization';
import { mapOrderToEvent, ORDER_LIVE_V1_EVENT_NAME, type ShopifyOrderShape } from './index.js';

const SALT = 'a'.repeat(64);
const EMAIL = '  Bridge.Proof+tag@Example.COM ';
const PHONE = '+91 98765 43210';

/** The PIXEL's client-side hash, replicated byte-for-byte from runtime.ts identify():
 *  plain UNSALTED SHA-256 of ("" + email).trim().toLowerCase(). */
function pixelSideEmailHash(email: string): string {
  const norm = String(email).trim().toLowerCase();
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

function order(): ShopifyOrderShape {
  return {
    id: 5551001,
    name: '#1001',
    created_at: '2026-07-01T10:00:00Z',
    processed_at: '2026-07-01T10:00:05Z',
    updated_at: '2026-07-01T10:00:05Z',
    cancelled_at: null,
    currency: 'INR',
    current_total_price: '1250.00',
    financial_status: 'paid',
    fulfillment_status: null,
    customer: { id: 42, email: EMAIL, phone: PHONE },
  };
}

describe('A.1.4 Shopify identity dual-write (WA-09 / AMD-01)', () => {
  it('A1.4.1 flag OFF → byte-identical envelope (no interop keys)', () => {
    const legacy = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME);
    const offExplicit = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME, {
      emitInteropIdentifiers: false,
    });
    const offAbsent = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME, {});

    expect(JSON.stringify(offExplicit)).toBe(JSON.stringify(legacy));
    expect(JSON.stringify(offAbsent)).toBe(JSON.stringify(legacy));
    expect('email_sha256' in legacy.properties).toBe(false);
    expect('phone_sha256' in legacy.properties).toBe(false);
  });

  it('A1.4.2 flag ON → interop fields ADDED, salted fields unchanged', () => {
    const off = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME);
    const on = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME, {
      emitInteropIdentifiers: true,
    });

    // Salted (internal-space) fields are byte-identical to the flag-off output.
    expect(on.properties.hashed_customer_email).toBe(off.properties.hashed_customer_email);
    expect(on.properties.hashed_customer_phone).toBe(off.properties.hashed_customer_phone);
    expect(on.properties.storefront_customer_id).toBe('42'); // = platform_customer_id (AMD-02)

    // Interop fields present, 64-hex, and NOT equal to the salted values (two hash spaces).
    expect(on.properties.email_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(on.properties.phone_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(on.properties.email_sha256).not.toBe(on.properties.hashed_customer_email);
    expect(on.properties.phone_sha256).not.toBe(on.properties.hashed_customer_phone);
    expect(on.properties.phone_sha256).toBe(phoneInteropHash(PHONE, 'IN'));
  });

  it('A1.4.3 BRIDGE-FIX PROOF: connector interop hash === pixel client-side hash of the same email', () => {
    const on = mapOrderToEvent(order(), SALT, 'IN', ORDER_LIVE_V1_EVENT_NAME, {
      emitInteropIdentifiers: true,
    });
    const pixelHash = pixelSideEmailHash(EMAIL);

    // The shared-package hash, the mapper's emitted field, and the pixel's hash all agree.
    expect(emailInteropHash(EMAIL)).toBe(pixelHash);
    expect(on.properties.email_sha256).toBe(pixelHash);
  });
});
