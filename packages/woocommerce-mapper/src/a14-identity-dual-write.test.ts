// SPEC: A.1.4
/**
 * A.1.4 (WA-09) — WooCommerce connector identity dual-write tests.
 *   A1.4.1 flag OFF → byte-identical envelope; A1.4.2 flag ON → interop fields added alongside
 *   unchanged salted fields; A1.4.3 bridge parity (interop hash === pixel client-side hash).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailInteropHash, phoneInteropHash } from '@brain/identity-normalization';
import { mapWooOrderToEvent, type WooOrderShape } from './index.js';

const BRAND = 'b1b1b1b1-0000-4000-8000-000000000001';
const SALT = 'b'.repeat(64);
const EMAIL = ' Woo.Customer@Example.COM ';
const PHONE = '9876543210';

function pixelSideEmailHash(email: string): string {
  return createHash('sha256').update(String(email).trim().toLowerCase(), 'utf8').digest('hex');
}

function order(): WooOrderShape {
  return {
    id: 777,
    status: 'processing',
    currency: 'INR',
    total: '999.00',
    date_created_gmt: '2026-07-01T09:00:00',
    date_modified_gmt: '2026-07-01T09:05:00',
    payment_method: 'razorpay',
    customer_id: 314,
    billing: { email: EMAIL, phone: PHONE },
  };
}

describe('A.1.4 WooCommerce identity dual-write (WA-09 / AMD-01)', () => {
  it('A1.4.1 flag OFF → byte-identical envelope (no interop keys)', () => {
    const legacy = mapWooOrderToEvent(order(), BRAND, SALT, 'IN', 'real');
    const off = mapWooOrderToEvent(order(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: false,
    });
    expect(JSON.stringify(off)).toBe(JSON.stringify(legacy));
    expect('email_sha256' in legacy.properties).toBe(false);
    expect('phone_sha256' in legacy.properties).toBe(false);
  });

  it('A1.4.2 flag ON → interop fields ADDED, salted fields unchanged', () => {
    const off = mapWooOrderToEvent(order(), BRAND, SALT, 'IN', 'real');
    const on = mapWooOrderToEvent(order(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.hashed_customer_email).toBe(off.properties.hashed_customer_email);
    expect(on.properties.hashed_customer_phone).toBe(off.properties.hashed_customer_phone);
    expect(on.properties.storefront_customer_id).toBe('314'); // = platform_customer_id (AMD-02)
    expect(on.properties.email_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(on.properties.phone_sha256).toBe(phoneInteropHash(PHONE, 'IN'));
    expect(on.properties.email_sha256).not.toBe(on.properties.hashed_customer_email);
  });

  it('A1.4.3 bridge parity: interop email hash === pixel client-side hash', () => {
    const on = mapWooOrderToEvent(order(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.email_sha256).toBe(pixelSideEmailHash(EMAIL));
    expect(emailInteropHash(EMAIL)).toBe(pixelSideEmailHash(EMAIL));
  });
});
