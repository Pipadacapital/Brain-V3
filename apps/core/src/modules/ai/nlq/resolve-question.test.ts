/**
 * resolve-question.test.ts — the NLQ resolver orchestrator (Track A).
 * Deterministic stub gateway (no live LLM). Proves the registry + allow-list
 * re-validation (defense in depth) collapses anything unresolvable to a refusal,
 * and that the resolver produces ONLY { kind:'binding'|'refusal' } (no number/SQL).
 */

import { describe, it, expect } from 'vitest';
import { ResolverClient, type GatewayTransport } from '@brain/ai-gateway-client';
import { resolveQuestion } from './resolve-question.js';

function clientReturning(payload: unknown): ResolverClient {
  const transport: GatewayTransport = async () => payload;
  return new ResolverClient({ transport });
}

describe('ai/nlq — resolveQuestion (registry + allow-list re-validation)', () => {
  it('valid registry binding → validated binding', async () => {
    const client = clientReturning({ kind: 'binding', metric_id: 'realized_revenue', version: 'v1', params: { date_from: '2026-01-01', date_to: '2026-02-01' } });
    const r = await resolveQuestion('revenue?', client);
    expect(r.kind).toBe('binding');
    if (r.kind === 'binding') {
      expect(r.metric_id).toBe('realized_revenue');
      expect(r.params.date_from).toBe('2026-01-01');
    }
  });

  it('a registry-unknown version → refusal (resolveMetric throws)', async () => {
    const client = clientReturning({ kind: 'binding', metric_id: 'realized_revenue', version: 'v99', params: {} });
    const r = await resolveQuestion('revenue?', client);
    expect(r.kind).toBe('refusal');
  });

  it('an inverted date range (from > to) → refusal', async () => {
    const client = clientReturning({ kind: 'binding', metric_id: 'realized_revenue', version: 'v1', params: { date_from: '2026-06-01', date_to: '2026-01-01' } });
    const r = await resolveQuestion('revenue?', client);
    expect(r.kind).toBe('refusal');
  });

  it('off-domain refusal passes through', async () => {
    const client = clientReturning({ kind: 'refusal', reason: 'no certified metric answers this' });
    const r = await resolveQuestion('weather?', client);
    expect(r.kind).toBe('refusal');
    if (r.kind === 'refusal') expect(r.reason).toBeTruthy();
  });

  it('out-of-enum metric (smuggled) → refusal (gateway coercion + resolver guard)', async () => {
    const client = clientReturning({ kind: 'binding', metric_id: 'orders_raw', version: 'v1', params: {} });
    const r = await resolveQuestion('raw orders?', client);
    expect(r.kind).toBe('refusal');
  });

  it('a valid channel param survives; an unknown one refuses', async () => {
    const ok = await resolveQuestion('first touch paid meta?', clientReturning({ kind: 'binding', metric_id: 'journey_first_touch_mix', version: 'v1', params: { channel: 'paid_meta' } }));
    expect(ok.kind).toBe('binding');
    const bad = await resolveQuestion('first touch x?', clientReturning({ kind: 'binding', metric_id: 'journey_first_touch_mix', version: 'v1', params: { channel: 'telegram' } }));
    expect(bad.kind).toBe('refusal');
  });

  it('resolver output never contains a numeric-answer or sql key', async () => {
    const r = await resolveQuestion('revenue?', clientReturning({ kind: 'binding', metric_id: 'realized_revenue', version: 'v1', params: {} }));
    const keys = Object.keys(r as unknown as Record<string, unknown>);
    expect(keys).not.toContain('sql');
    expect(keys).not.toContain('value');
    expect(keys).not.toContain('number');
  });
});
