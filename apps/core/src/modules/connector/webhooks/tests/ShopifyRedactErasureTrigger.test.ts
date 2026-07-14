/**
 * ShopifyRedactErasureTrigger.test.ts — AUD-OPS-036/039 (the RTBF erasure-trigger bridge,
 * Shopify customers/redact entry point).
 *
 * Proves that the customers/redact sideEffect — in ADDITION to the synchronous partial erase
 * (Neo4j tombstone + contact_pii, unchanged and re-asserted here) — publishes the canonical
 * privacy.erasure.requested trigger via the injected ErasureEventPublisher:
 *   1. Happy path: resolved brain_id + the Shopify payload's raw email/phone are all carried.
 *   2. Customer not in the identity graph (never converted): STILL bridges with email/phone —
 *      the orchestrator resolves/skips subject-safely on its side.
 *   3. No identity reader wired: still bridges with email/phone (async completeness path).
 *   4. No publisher injected (pre-bridge construction): behavior identical to before — the
 *      existing ShopifyGdprUninstall tests keep passing unchanged.
 *
 * Pure unit tests: no DB, no Kafka — strategy object + captured fakes only.
 */
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';
import type { WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import type { ErasureEmit, ErasureEventPublisher } from '../../../../infrastructure/events/ErasureEventPublisher.js';

const BRAND = '33333333-3333-4333-8333-333333333333';
const SALT_HEX = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const EMAIL = 'redacted-subject@example.com';
const PHONE = '+919876543210';

function makeCtx(body: Record<string, unknown>): WebhookStrategyContext {
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-wh-topic': 'customers_redact' },
    parsedBody: null,
    brandId: BRAND,
    saltHex: SALT_HEX,
    regionCode: 'IN',
    correlationId: 'corr-redact-1',
    requestId: 'req-redact-1',
  } as WebhookStrategyContext;
}

function makePublisher(): { publisher: ErasureEventPublisher; emits: ErasureEmit[] } {
  const emits: ErasureEmit[] = [];
  return {
    emits,
    publisher: { emitErasureRequested: vi.fn(async (evt: ErasureEmit) => { emits.push(evt); }) },
  };
}

const mockPool = {} as pg.Pool; // the redact side-effect never touches PG directly

function makeReader(resolvedBrainId: string | null) {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      resolveBrainIdByStorefrontCustomerId: async (b: string, h: string) => {
        calls.push(`resolve:${b}:${h.slice(0, 8)}`);
        return resolvedBrainId;
      },
      eraseCustomer: async (b: string, id: string) => {
        calls.push(`erase:${b}:${id}`);
        return { erased: true, contact_pii_deleted: 1, links_tombstoned: 1 };
      },
    },
  };
}

describe('ShopifyWebhookStrategy customers/redact — erasure-trigger bridge (AUD-OPS-036)', () => {
  it('resolved customer: synchronous erase still runs AND the trigger carries brain_id + raw email/phone', async () => {
    const { publisher, emits } = makePublisher();
    const strategy = new ShopifyWebhookStrategy(undefined, publisher);
    const { reader, calls } = makeReader('brain-id-resolved');

    const result = await strategy.payloadMap(
      makeCtx({ customer: { id: 99001, email: EMAIL, phone: PHONE } }),
    );
    expect(result.skip).toBe(true);
    await result.sideEffect!(BRAND, mockPool, 'req-redact-1', reader);

    // Unchanged synchronous partial erase (AUD-OPS-039: keep for immediate UX).
    expect(calls.some((c) => c === `erase:${BRAND}:brain-id-resolved`)).toBe(true);

    // The bridge: one canonical trigger, fully addressed.
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      brandId: BRAND,
      brainId: 'brain-id-resolved',
      subjectEmail: EMAIL,
      subjectPhone: PHONE,
      source: 'shopify.customers_redact',
      correlationId: 'corr-redact-1',
    });
  });

  it('customer NOT in the identity graph: no graph erase, but the trigger still fires with email/phone', async () => {
    const { publisher, emits } = makePublisher();
    const strategy = new ShopifyWebhookStrategy(undefined, publisher);
    const { reader, calls } = makeReader(null); // never converted

    const result = await strategy.payloadMap(makeCtx({ customer: { id: 99002, email: EMAIL } }));
    await result.sideEffect!(BRAND, mockPool, 'req-redact-1', reader);

    expect(calls.some((c) => c.startsWith('erase:'))).toBe(false);
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ brandId: BRAND, subjectEmail: EMAIL, source: 'shopify.customers_redact' });
    expect(emits[0]!.brainId).toBeUndefined();
  });

  it('no identity reader wired: still bridges on the raw subject (async path is the completeness guarantee)', async () => {
    const { publisher, emits } = makePublisher();
    const strategy = new ShopifyWebhookStrategy(undefined, publisher);

    const result = await strategy.payloadMap(makeCtx({ customer: { id: 99003, phone: PHONE } }));
    await result.sideEffect!(BRAND, mockPool, 'req-redact-1'); // no reader arg

    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ brandId: BRAND, subjectPhone: PHONE, source: 'shopify.customers_redact' });
  });

  it('unaddressable payload (no customer id/email/phone): no trigger emitted (never a dead event)', async () => {
    const { publisher, emits } = makePublisher();
    const strategy = new ShopifyWebhookStrategy(undefined, publisher);

    const result = await strategy.payloadMap(makeCtx({ shop_id: 1 }));
    await result.sideEffect!(BRAND, mockPool, 'req-redact-1');

    expect(emits).toHaveLength(0);
  });

  it('no publisher injected (pre-bridge construction): sideEffect behavior unchanged, no throw', async () => {
    const strategy = new ShopifyWebhookStrategy();
    const { reader, calls } = makeReader('brain-id-resolved');

    const result = await strategy.payloadMap(makeCtx({ customer: { id: 99004, email: EMAIL } }));
    await expect(result.sideEffect!(BRAND, mockPool, 'req-redact-1', reader)).resolves.toBeUndefined();
    expect(calls.some((c) => c === `erase:${BRAND}:brain-id-resolved`)).toBe(true);
  });
});
