// SPEC: A.1.4
/**
 * A.1.4 (WA-09) — GoKwik connector identity dual-write + checkout_session_id tests.
 *   A1.4.1 flag OFF → byte-identical envelope; A1.4.2 flag ON → interop fields added;
 *   A1.4.3 bridge parity; A1.4.4 checkout_session_id passthrough on order + checkout events
 *   (dedicated session keys ONLY — an order id is never promoted to a session id).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailInteropHash } from '@brain/identity-normalization';
import { mapGokwikCheckout, mapGokwikOrder } from '../index.js';

const BRAND = 'c1c1c1c1-0000-4000-8000-000000000001';
const SALT = 'c'.repeat(64);
const EMAIL = 'GoKwik.Buyer@Example.com';

function pixelSideEmailHash(email: string): string {
  return createHash('sha256').update(String(email).trim().toLowerCase(), 'utf8').digest('hex');
}

const ORDER_BODY = {
  event_type: 'order.paid',
  moid: 'GK-ORDER-1',
  total: '650.00',
  currency: 'INR',
  email: EMAIL,
  phone: '9876543210',
  checkout_id: 'gk_checkout_sess_9',
  updated_at: '2026-07-01T12:00:00Z',
};

const CHECKOUT_BODY = {
  event_type: 'checkout.started',
  checkout_id: 'gk_checkout_sess_9',
  cart_value: '650.00',
  email: EMAIL,
  created_at: '2026-07-01T11:58:00Z',
};

describe('A.1.4 GoKwik identity dual-write + checkout_session_id (WA-09 / AMD-01)', () => {
  it('A1.4.1 flag OFF → byte-identical envelope (no interop keys, no checkout_session_id)', () => {
    const legacy = mapGokwikOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real');
    const off = mapGokwikOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: false,
    });
    expect(JSON.stringify(off)).toBe(JSON.stringify(legacy));
    for (const k of ['email_sha256', 'phone_sha256', 'checkout_session_id']) {
      expect(k in legacy.properties, k).toBe(false);
    }
  });

  it('A1.4.2 + A1.4.3 flag ON → interop fields added; email hash === pixel hash', () => {
    const off = mapGokwikOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real');
    const on = mapGokwikOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.hashed_customer_email).toBe(off.properties.hashed_customer_email);
    expect(on.properties.email_sha256).toBe(pixelSideEmailHash(EMAIL));
    expect(on.properties.email_sha256).toBe(emailInteropHash(EMAIL));
    expect(on.properties.phone_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('A1.4.4 checkout_session_id passthrough — order event (flag ON)', () => {
    const on = mapGokwikOrder({ ...ORDER_BODY }, BRAND, SALT, 'IN', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.checkout_session_id).toBe('gk_checkout_sess_9');
  });

  it('A1.4.4 checkout_session_id passthrough — checkout event (flag ON) + honest-absent', () => {
    const on = mapGokwikCheckout({ ...CHECKOUT_BODY }, BRAND, SALT, 'IN', 'started', 'real', {
      emitInteropIdentifiers: true,
    });
    expect(on.properties.checkout_session_id).toBe('gk_checkout_sess_9');

    // Order-id-only payload → NO checkout_session_id (an order id is not a session id).
    const orderOnly = mapGokwikOrder(
      { event_type: 'order.paid', moid: 'GK-2', total: '10.00', updated_at: '2026-07-01T12:00:00Z' },
      BRAND, SALT, 'IN', 'real', { emitInteropIdentifiers: true },
    );
    expect('checkout_session_id' in orderOnly.properties).toBe(false);
  });
});
