/**
 * dispatch.test.ts — end-to-end-ish proof of the READ-ONLY MCP dispatch over its real contract
 * schemas (Brain V4; D5 / I-S08 / I-S01).
 *
 * Proves on the ACTUAL Zod I/O contracts (validated through the dispatch):
 *   - customer360_lookup MONEY path: money leaves as a bigint-MINOR string + currency_code (never a
 *     float), the engine produced it (the dispatch only stringified the bigint), honest-empty works.
 *   - identity_explainability_lookup HASH-ONLY path: identifier_combo is 12-hex salted-hash prefixes
 *     (never raw PII), confidence is an INTEGER 0-100, brand_id comes from the PRINCIPAL.
 *   - brand_id is NEVER read from the tool input (a smuggled brand_id arg is ignored — I-S01).
 *   - disabled segment_lookup FAILS CLOSED (NotImplementedYetError); a principal with no brand scope
 *     fails closed (McpPrincipalScopeError).
 *   - the mount (createMcpDispatch) composes and fails closed without touching a DB.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchMcpTool,
  NotImplementedYetError,
  McpPrincipalScopeError,
  type McpReadSeams,
  type McpPrincipal,
  type McpSchemaProvider,
  type SchemaLike,
} from '@brain/ai-gateway-client';
import {
  MCP_LOOKUP_SCHEMAS,
  Customer360LookupOutputSchema,
  IdentityExplainabilityLookupOutputSchema,
} from '@brain/contracts';
import { createMcpDispatch } from './dispatch-wiring.js';

const BRAND_A: McpPrincipal = { brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const BRAIN_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_BRAIN = '99999999-8888-7777-6666-555555555555';

/** The real contracts Zod registry as the dispatch's schema provider (validates I/O). */
const schemas: McpSchemaProvider = (ref: string): SchemaLike =>
  MCP_LOOKUP_SCHEMAS[ref] as unknown as SchemaLike;

/** A read-seam surface whose members all throw unless explicitly overridden in a test. */
function makeSeams(overrides: Partial<McpReadSeams>): McpReadSeams {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected seam call: ${name}`);
  };
  return {
    customer360Summary: unexpected('customer360Summary'),
    customerJourneySummary: unexpected('customerJourneySummary'),
    identityTimeline: unexpected('identityTimeline'),
    identityExplain: unexpected('identityExplain'),
    channelRoas: unexpected('channelRoas'),
    campaignRoas: unexpected('campaignRoas'),
    customerScore: unexpected('customerScore'),
    recommendationFeatures: unexpected('recommendationFeatures'),
    ...overrides,
  } as McpReadSeams;
}

describe('MCP dispatch — money + hash-only + principal isolation (I-S08 / I-S01)', () => {
  it('customer360_lookup: engine bigint money → bigint-MINOR string + currency_code; brand from principal', async () => {
    const customer360Summary = vi.fn(async (_brandId: string) => ({
      hasData: true,
      customerCount: 3n,
      totalLifetimeValueMinor: 1234500n, // ₹12,345.00 in minor units — bigint
      totalLifetimeOrders: 7n,
      currencyCode: 'INR',
      topCustomers: [
        {
          brainId: BRAIN_ID,
          lifetimeOrders: 2n,
          lifetimeValueMinor: 900000n,
          deliveredOrders: 2n,
          rtoOrders: 0n,
          firstIdentifiedAt: null,
        },
      ],
    }));
    const seams = makeSeams({ customer360Summary });

    const out = (await dispatchMcpTool(
      'customer360_lookup',
      {},
      BRAND_A,
      seams,
      schemas,
    )) as Record<string, unknown>;

    // brand_id came from the principal — the seam received it.
    expect(customer360Summary).toHaveBeenCalledWith(BRAND_A.brandId);

    // Money is a bigint-minor STRING, never a float/number. The engine produced the value.
    expect(out['total_lifetime_value_minor']).toBe('1234500');
    expect(typeof out['total_lifetime_value_minor']).toBe('string');
    expect(out['currency_code']).toBe('INR');
    expect(out['customer_count']).toBe('3');
    expect((out['top_customers'] as unknown[])[0]).toMatchObject({
      lifetime_value_minor: '900000',
    });

    // The output validates against the REAL contract schema.
    expect(() => Customer360LookupOutputSchema.parse(out)).not.toThrow();
  });

  it('customer360_lookup honest-empty: has_data=false, currency null, zero money string', async () => {
    const seams = makeSeams({
      customer360Summary: async () => ({
        hasData: false,
        customerCount: 0n,
        totalLifetimeValueMinor: 0n,
        totalLifetimeOrders: 0n,
        currencyCode: null,
        topCustomers: [],
      }),
    });
    const out = (await dispatchMcpTool('customer360_lookup', {}, BRAND_A, seams, schemas)) as Record<
      string,
      unknown
    >;
    expect(out['has_data']).toBe(false);
    expect(out['currency_code']).toBeNull();
    expect(out['total_lifetime_value_minor']).toBe('0');
    expect(() => Customer360LookupOutputSchema.parse(out)).not.toThrow();
  });

  it('identity_explainability_lookup: hash-only 12-hex combo + INTEGER confidence; brand from principal', async () => {
    const identityExplain = vi.fn(async (_brandId: string, brainId: string) => ({
      state: 'found' as const,
      brain_id: brainId,
      identifiers: [
        { identifier_type: 'email', identifier_hash_prefix: 'abcdef012345' },
        { identifier_type: 'phone', identifier_hash_prefix: '0123456789ab' },
      ],
      merges: [
        {
          role: 'canonical' as const,
          canonical_brain_id: BRAIN_ID,
          merged_brain_id: OTHER_BRAIN,
          confidence: '0.95', // a 0-1 graph float — normalized to int 0-100 by the dispatch
          rule_version: 'v1-deterministic',
        },
      ],
    }));
    const seams = makeSeams({ identityExplain });

    const out = (await dispatchMcpTool(
      'identity_explainability_lookup',
      { brain_id: BRAIN_ID },
      BRAND_A,
      seams,
      schemas,
    )) as Record<string, unknown>;

    expect(identityExplain).toHaveBeenCalledWith(BRAND_A.brandId, BRAIN_ID);
    expect(out['has_data']).toBe(true);

    const merges = out['merges'] as Array<Record<string, unknown>>;
    expect(merges[0]!['confidence']).toBe(95); // INTEGER 0-100, never money
    expect(typeof merges[0]!['confidence']).toBe('number');

    const combo = merges[0]!['identifier_combo'] as Array<Record<string, unknown>>;
    for (const m of combo) {
      expect(m['identifier_hash_prefix']).toMatch(/^[0-9a-f]{12}$/); // hash-only, never raw PII
    }
    // No money anywhere on the identity-graph read (never coupled to the intelligence aggregate).
    expect(JSON.stringify(out)).not.toMatch(/minor|currency/i);

    expect(() => IdentityExplainabilityLookupOutputSchema.parse(out)).not.toThrow();
  });

  it('[I-S01] brand_id is NEVER read from the tool input — a smuggled brand_id arg is ignored', async () => {
    const customerScore = vi.fn(async (_brandId: string, _brainId: string) => null);
    const seams = makeSeams({ customerScore });

    await dispatchMcpTool(
      'ltv_lookup',
      { brain_id: BRAIN_ID, brand_id: 'evil-other-brand' }, // smuggled brand_id
      BRAND_A,
      seams,
      schemas,
    );

    // The seam was scoped to the PRINCIPAL brand, never the smuggled input brand.
    expect(customerScore).toHaveBeenCalledWith(BRAND_A.brandId, BRAIN_ID);
    expect(customerScore).not.toHaveBeenCalledWith('evil-other-brand', expect.anything());
  });

  it('segment_lookup is DISABLED → fails closed (NotImplementedYetError)', async () => {
    const seams = makeSeams({});
    await expect(
      dispatchMcpTool('segment_lookup', { brain_id: BRAIN_ID }, BRAND_A, seams, schemas),
    ).rejects.toBeInstanceOf(NotImplementedYetError);
  });

  it('a principal with no brand scope fails closed (McpPrincipalScopeError)', async () => {
    const seams = makeSeams({ customer360Summary: async () => ({
      hasData: false, customerCount: 0n, totalLifetimeValueMinor: 0n, totalLifetimeOrders: 0n,
      currencyCode: null, topCustomers: [],
    }) });
    await expect(
      dispatchMcpTool('customer360_lookup', {}, { brandId: '' }, seams, schemas),
    ).rejects.toBeInstanceOf(McpPrincipalScopeError);
  });

  it('the mount (createMcpDispatch) composes and fails closed for the disabled tool', async () => {
    // A stub srPool + identity seams — segment_lookup never touches them (fails closed first).
    const dispatch = createMcpDispatch({
      srPool: {} as never,
      identity: {
        identityTimeline: async (_b, brainId) => ({ state: 'invalid', brain_id: brainId }),
        identityExplain: async (_b, brainId) => ({ state: 'not_found', brain_id: brainId }),
      },
    });
    await expect(
      dispatch('segment_lookup', { brain_id: BRAIN_ID }, BRAND_A),
    ).rejects.toBeInstanceOf(NotImplementedYetError);
  });
});
