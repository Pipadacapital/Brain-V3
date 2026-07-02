/**
 * bronze-source-import.test.ts — AUD-ARCH-003 regression guard.
 *
 * The module previously crashed at import under the default BRONZE_SOURCE=legacy
 * (self-referential const ternary → TDZ ReferenceError). These tests import the
 * module dynamically per BRONZE_SOURCE value and assert the table name resolves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL = process.env['BRONZE_SOURCE'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['BRONZE_SOURCE'];
  else process.env['BRONZE_SOURCE'] = ORIGINAL;
  vi.resetModules();
});

describe('data-quality import under BRONZE_SOURCE (AUD-ARCH-003)', () => {
  it('imports cleanly with BRONZE_SOURCE unset (legacy default) and uses collector_events', async () => {
    delete process.env['BRONZE_SOURCE'];
    vi.resetModules();
    const mod = await import('./index.js');
    const freshness = mod.DQ_CHECKS.find((c) => c.category === 'freshness');
    expect(freshness).toBeDefined();
    expect((freshness as { tableName: string }).tableName).toBe('brain_bronze.collector_events');
  });

  it('imports cleanly with BRONZE_SOURCE=legacy and uses collector_events', async () => {
    process.env['BRONZE_SOURCE'] = 'legacy';
    vi.resetModules();
    const mod = await import('./index.js');
    const freshness = mod.DQ_CHECKS.find((c) => c.category === 'freshness');
    expect((freshness as { tableName: string }).tableName).toBe('brain_bronze.collector_events');
  });

  it('BRONZE_SOURCE=events flips to the unified brain_bronze.events table', async () => {
    process.env['BRONZE_SOURCE'] = 'events';
    vi.resetModules();
    const mod = await import('./index.js');
    const freshness = mod.DQ_CHECKS.find((c) => c.category === 'freshness');
    expect((freshness as { tableName: string }).tableName).toBe('brain_bronze.events');
  });
});
