/**
 * client.test.ts — proves the ResolverClient cost/fail-closed contract (Track A).
 * Uses a DETERMINISTIC stub transport — NO live LLM in CI.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ResolverClient,
  RESOLVER_MAX_OUTPUT_TOKENS,
  RESOLVER_TEMPERATURE,
  type GatewayTransport,
} from './client.js';

describe('ai-gateway-client — ResolverClient (Tier-3, fail-closed)', () => {
  it('makes exactly ONE call at temperature 0 with the output-token cap', async () => {
    const transport: GatewayTransport = vi.fn(async (req) => {
      expect(req.temperature).toBe(RESOLVER_TEMPERATURE);
      expect(req.maxTokens).toBe(RESOLVER_MAX_OUTPUT_TOKENS);
      // The model is handed the constrained schema (enum-only, no sql/number).
      expect(JSON.stringify(req.jsonSchema)).not.toMatch(/"sql"/i);
      return { kind: 'binding', metric_id: 'realized_revenue', version: 'v1', params: {} };
    });
    const client = new ResolverClient({ transport });
    const r = await client.resolve({ system: 'sys', question: 'what is my revenue?' });
    expect(r.kind).toBe('binding');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('coerces an out-of-enum model answer to a refusal (fail-closed)', async () => {
    const transport: GatewayTransport = async () => ({ kind: 'binding', metric_id: 'orders_raw', version: 'v1', params: {} });
    const r = await new ResolverClient({ transport }).resolve({ system: 's', question: 'q' });
    expect(r.kind).toBe('refusal');
  });

  it('coerces a smuggled SQL answer to a refusal', async () => {
    const transport: GatewayTransport = async () => ({ kind: 'binding', sql: 'DROP TABLE x', metric_id: 'realized_revenue', version: 'v1', params: {} });
    const r = await new ResolverClient({ transport }).resolve({ system: 's', question: 'q' });
    expect(r.kind).toBe('refusal');
  });

  it('retries ONCE on transport error then refuses (no retry storm)', async () => {
    let calls = 0;
    const transport: GatewayTransport = async () => {
      calls += 1;
      throw new Error('boom');
    };
    const r = await new ResolverClient({ transport }).resolve({ system: 's', question: 'q' });
    expect(r.kind).toBe('refusal');
    expect(calls).toBe(2); // 1 attempt + 1 retry, then refuse
  });

  it('recovers when the retry succeeds', async () => {
    let calls = 0;
    const transport: GatewayTransport = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { kind: 'refusal', reason: 'off domain' };
    };
    const r = await new ResolverClient({ transport }).resolve({ system: 's', question: 'q' });
    expect(r.kind).toBe('refusal');
    expect(calls).toBe(2);
  });
});
