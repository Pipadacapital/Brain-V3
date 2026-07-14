// SPEC: A.1.4
/**
 * A.1.4 (WA-09) — Shopflo connector identity dual-write + name-unification tests.
 *   A1.4.1 flag OFF → byte-identical envelope (legacy customer_email_hash names untouched);
 *   A1.4.2 flag ON  → AMD-02 standard names + AMD-01 interop fields + checkout_session_id
 *                     added on the frozen checkout_abandoned lane; interop on order events;
 *   A1.4.3 bridge parity (interop hash === pixel client-side hash).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailInteropHash } from '@brain/identity-normalization';
import {
  mapShopfloCheckoutAbandoned,
  mapShopfloOrder,
  type ShopfloCheckoutAbandonedPayload,
} from '../index.js';

const BRAND = 'd1d1d1d1-0000-4000-8000-000000000001';
const SALT = 'd'.repeat(64);
const EMAIL = ' Flo.Shopper@Example.COM ';

function pixelSideEmailHash(email: string): string {
  return createHash('sha256').update(String(email).trim().toLowerCase(), 'utf8').digest('hex');
}

function abandoned(): ShopfloCheckoutAbandonedPayload {
  return {
    event_name: 'checkout_abandoned',
    checkout_id: 'flo_sess_77',
    cart_token: 'tok_1',
    customer: { email: EMAIL, phone: '9876543210' },
    total_price: 65,
    currency: 'INR',
    occurred_at: '2026-07-01T08:00:00Z',
  };
}

const ORDER_BODY = {
  event_name: 'order.paid',
  order_id: 'FLO-1',
  total_price: '65',
  currency: 'INR',
  email: EMAIL,
  checkout_session_id: 'flo_sess_77',
  occurred_at: '2026-07-01T08:05:00Z',
};

describe('A.1.4 Shopflo identity dual-write + name unification (WA-09 / AMD-01 / AMD-02)', () => {
  it('A1.4.1 flag OFF → byte-identical envelope (legacy names only)', () => {
    const legacy = mapShopfloCheckoutAbandoned(abandoned(), BRAND, SALT, 'IN', 'real');
    const off = mapShopfloCheckoutAbandoned(abandoned(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: false,
    });
    expect(JSON.stringify(off)).toBe(JSON.stringify(legacy));
    for (const k of ['hashed_customer_email', 'hashed_customer_phone', 'email_sha256', 'phone_sha256', 'checkout_session_id']) {
      expect(k in legacy.properties, k).toBe(false);
    }
    // Frozen legacy names still carried.
    expect(legacy.properties.customer_email_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('A1.4.2 flag ON → AMD-02 standard names + interop + checkout_session_id on checkout_abandoned', () => {
    const on = mapShopfloCheckoutAbandoned(abandoned(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    // AMD-02 unification: the standard salted names mirror the legacy values (same bytes).
    expect(on.properties.hashed_customer_email).toBe(on.properties.customer_email_hash);
    expect(on.properties.hashed_customer_phone).toBe(on.properties.customer_phone_hash);
    // AMD-01 interop dual-write.
    expect(on.properties.email_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(on.properties.phone_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(on.properties.email_sha256).not.toBe(on.properties.customer_email_hash);
    // checkout_session_id = this event's checkout_id (the session join key).
    expect(on.properties.checkout_session_id).toBe('flo_sess_77');
  });

  it('A1.4.2 flag ON → interop + checkout_session_id passthrough on order events', () => {
    const off = mapShopfloOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real');
    const on = mapShopfloOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.hashed_customer_email).toBe(off.properties.hashed_customer_email);
    expect(on.properties.email_sha256).toBe(emailInteropHash(EMAIL));
    // checkout_session_id passthrough exists on BOTH (journey-context, pre-Wave-A behavior kept).
    expect(off.properties.checkout_session_id).toBe('flo_sess_77');
    expect(on.properties.checkout_session_id).toBe('flo_sess_77');
  });

  it('A1.4.3 bridge parity: interop email hash === pixel client-side hash', () => {
    const on = mapShopfloCheckoutAbandoned(abandoned(), BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.email_sha256).toBe(pixelSideEmailHash(EMAIL));
  });
});
