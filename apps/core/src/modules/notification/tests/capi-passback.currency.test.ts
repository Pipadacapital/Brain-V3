/**
 * capi-passback.currency.test.ts — #68 currency-exponent correctness + fail-closed guard.
 *
 * Proves:
 *  (1) A supported currency converts minor→major with the CURRENCY-AWARE exponent (@brain/money),
 *      not a hardcoded /100 — so the value Meta receives is correct.
 *  (2) A 0-decimal currency (JPY) sends the CORRECT major value (minor == major; a /100 would be
 *      100x wrong). Since 1b577a41 (@brain/money multi-currency), JPY IS modeled — the ISO-4217
 *      exponent table (MINOR_UNIT_DIGITS_EXCEPTIONS) carries JPY: 0, so the guard lets it through
 *      and the wire conversion is exact.
 *  (3) A currency Brain CANNOT model (a malformed, non-ISO-4217 code — isValidCurrency is now
 *      format-based, 1b577a41) is BLOCKED terminally — the adapter is NEVER called with a
 *      fabricated value. This is the revenue-truth-over-platform-truth / fail-safe posture.
 *
 * Pure unit test — engine/adapter/pii/db are stubbed.
 */
import { describe, it, expect, vi } from 'vitest';
import { CapiPassbackService, type CapiConversion } from '../internal/capi-passback.service.js';

function makeConv(overrides: Partial<CapiConversion> = {}): CapiConversion {
  return {
    brandId: '550e8400-e29b-41d4-a716-446655440000',
    orderId: 'order-1',
    ledgerEventId: 'ledger-evt-1',
    subjectHash: 'subj-hash-1',
    valueMinor: 99900n, // 999.00 in a 2-decimal currency
    currencyCode: 'INR',
    occurredAt: new Date('2026-06-20T00:00:00.000Z'),
    fbc: null,
    fbp: null,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeService(adapterSend: ReturnType<typeof vi.fn>) {
  const dbCalls: unknown[][] = [];
  const deps = {
    engine: { evaluate: vi.fn(async () => ({ decision: 'allow' as const, reason: 'ok' })) },
    adapter: { send: adapterSend },
    pii: { getMatchPii: vi.fn(async () => null) }, // click-id-only match; no PII hashing path
    db: { query: vi.fn(async (_ctx: unknown, _sql: unknown, params: unknown[]) => { dbCalls.push(params); return { rows: [], rowCount: 1 }; }) },
  };
  const service = new CapiPassbackService(deps as never);
  return { service, deps, dbCalls };
}

describe('CapiPassbackService currency handling (#68)', () => {
  it('a supported currency sends the currency-aware major value (INR 99900 minor → 999)', async () => {
    const send = vi.fn(async () => ({ status: 'would_send_dev' as const }));
    const { service } = makeService(send);

    const outcome = await service.passback(makeConv({ valueMinor: 99900n, currencyCode: 'INR' }));

    expect(send).toHaveBeenCalledOnce();
    const sent = (send.mock.calls[0] as unknown[])[0] as { customData: { value: number; currency: string } };
    expect(sent.customData.value).toBe(999); // 99900 / 100, NOT a raw 99900
    expect(sent.customData.currency).toBe('INR');
    expect(outcome.status).toBe('would_send_dev');
  });

  it('a 0-decimal currency (JPY) sends the exact major value — minor == major, never /100', async () => {
    const send = vi.fn(async () => ({ status: 'would_send_dev' as const }));
    const { service } = makeService(send);

    // JPY is MODELED since 1b577a41 (exponent table: JPY → 0 digits). 5000 minor = ¥5000 major.
    const outcome = await service.passback(makeConv({ valueMinor: 5000n, currencyCode: 'JPY' }));

    expect(send).toHaveBeenCalledOnce();
    const sent = (send.mock.calls[0] as unknown[])[0] as { customData: { value: number; currency: string } };
    expect(sent.customData.value).toBe(5000); // NOT 50 — the /100 bug class this file pins
    expect(sent.customData.currency).toBe('JPY');
    expect(outcome.status).toBe('would_send_dev');
  });

  it('BLOCKS an unmodelable (malformed) currency fail-closed — the adapter is never called', async () => {
    const send = vi.fn(async () => ({ status: 'would_send_dev' as const }));
    const { service, dbCalls } = makeService(send);

    // 'YEN2' is not a well-formed ISO-4217 alpha-3 code — @brain/money cannot model its exponent,
    // so any major-unit value sent to Meta would be fabricated. The guard must block terminally.
    const outcome = await service.passback(makeConv({ valueMinor: 5000n, currencyCode: 'YEN2' }));

    expect(send).not.toHaveBeenCalled(); // never fabricate a value to Meta
    expect(outcome.status).toBe('blocked_unsupported_currency');
    expect(outcome.blockReason).toContain('YEN2');
    // The block is recorded honestly in capi_passback_log (status param position 6).
    const logged = dbCalls.at(-1)!;
    expect(logged).toContain('blocked_unsupported_currency');
  });
});
