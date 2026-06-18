/**
 * resolver-schema.test.ts — proves the STRUCTURAL HONESTY BAN (Track A / D1).
 *
 * Asserts, WITHOUT any live LLM:
 *   - the JSON schema's metric_id enum == the registry keys (no drift, no extra ids);
 *   - the schema has NO `sql` and NO `value`/`number` property anywhere;
 *   - fail-closed coercion: out-of-enum / malformed / smuggled-number → refusal;
 *   - a well-formed binding survives coercion intact.
 */

import { describe, it, expect } from 'vitest';
import { METRIC_REGISTRY } from '@brain/metric-engine';
import {
  buildResolverJsonSchema,
  coerceResolverResult,
  METRIC_ID_ENUM,
} from './resolver-schema.js';

describe('ai-gateway-client — resolver schema (structural honesty ban)', () => {
  it('metric_id enum == the 16 registry keys (no drift)', () => {
    const registryKeys = Object.keys(METRIC_REGISTRY).sort();
    expect([...METRIC_ID_ENUM].sort()).toEqual(registryKeys);
    expect(METRIC_ID_ENUM.length).toBe(16);
  });

  it('the binding branch metric_id enum is exactly the registry keys', () => {
    const schema = buildResolverJsonSchema();
    const json = JSON.stringify(schema);
    const bindingBranch = (schema.oneOf as Record<string, unknown>[])[0]!;
    const props = bindingBranch.properties as Record<string, { enum?: string[] }>;
    expect(props.metric_id!.enum?.slice().sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    // No SQL / numeric-answer field anywhere in the emitted schema.
    expect(json).not.toMatch(/"sql"/i);
    expect(json).not.toMatch(/"value"/i);
    expect(json).not.toMatch(/"number"/i);
    expect(json).not.toMatch(/"amount"/i);
  });

  it('schema forbids additionalProperties at every level', () => {
    const schema = buildResolverJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    for (const branch of schema.oneOf as Record<string, unknown>[]) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('coerces a well-formed binding intact', () => {
    const r = coerceResolverResult({
      kind: 'binding',
      metric_id: 'realized_revenue',
      version: 'v1',
      params: { date_from: '2026-01-01', date_to: '2026-06-01' },
    });
    expect(r.kind).toBe('binding');
    if (r.kind === 'binding') {
      expect(r.metric_id).toBe('realized_revenue');
      expect(r.params.date_from).toBe('2026-01-01');
    }
  });

  it('fail-closed: metric_id outside the enum → refusal', () => {
    const r = coerceResolverResult({ kind: 'binding', metric_id: 'secret_table', version: 'v1', params: {} });
    expect(r.kind).toBe('refusal');
  });

  it('fail-closed: a smuggled `sql` field → refusal', () => {
    const r = coerceResolverResult({
      kind: 'binding',
      metric_id: 'realized_revenue',
      version: 'v1',
      params: {},
      sql: 'SELECT * FROM realized_revenue_ledger',
    });
    expect(r.kind).toBe('refusal');
  });

  it('fail-closed: a smuggled numeric answer field → refusal', () => {
    const r = coerceResolverResult({ kind: 'binding', metric_id: 'realized_revenue', version: 'v1', value: 4200000 });
    expect(r.kind).toBe('refusal');
  });

  it('fail-closed: a param outside the allow-list → refusal', () => {
    const r = coerceResolverResult({
      kind: 'binding',
      metric_id: 'realized_revenue',
      version: 'v1',
      params: { table: 'orders' },
    });
    expect(r.kind).toBe('refusal');
  });

  it('fail-closed: an unknown channel → refusal', () => {
    const r = coerceResolverResult({
      kind: 'binding',
      metric_id: 'journey_first_touch_mix',
      version: 'v1',
      params: { channel: 'carrier_pigeon' },
    });
    expect(r.kind).toBe('refusal');
  });

  it('fail-closed: a bad date format → refusal', () => {
    const r = coerceResolverResult({
      kind: 'binding',
      metric_id: 'realized_revenue',
      version: 'v1',
      params: { date_from: '01/01/2026' },
    });
    expect(r.kind).toBe('refusal');
  });

  it('passes through an honest refusal', () => {
    const r = coerceResolverResult({ kind: 'refusal', reason: 'no certified metric answers this' });
    expect(r.kind).toBe('refusal');
    if (r.kind === 'refusal') expect(r.reason).toContain('no certified metric');
  });

  it('empty / non-object payload → refusal', () => {
    expect(coerceResolverResult(null).kind).toBe('refusal');
    expect(coerceResolverResult('SELECT 1').kind).toBe('refusal');
    expect(coerceResolverResult(undefined).kind).toBe('refusal');
  });
});
