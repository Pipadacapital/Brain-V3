/**
 * bronze-source-import.test.ts — AUD-ARCH-003 regression guard (ADR-0010 form).
 *
 * The module previously crashed at import (self-referential const ternary → TDZ ReferenceError)
 * when it carried the BRONZE_SOURCE env switch. ADR-0010 removed the switch entirely — the Kafka
 * Connect Iceberg sink is the ONLY Bronze writer, so the DQ checks target the single lift view
 * constant regardless of env. These tests assert (a) the module imports cleanly and (b) the table
 * name is the constant lift view with NO env sensitivity (a stray BRONZE_SOURCE must not change it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const LIFT_VIEW = 'brain_bronze.collector_events_connect_lifted';
const ORIGINAL = process.env['BRONZE_SOURCE'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['BRONZE_SOURCE'];
  else process.env['BRONZE_SOURCE'] = ORIGINAL;
  vi.resetModules();
});

describe('data-quality Bronze source is the constant ADR-0010 lift view (AUD-ARCH-003)', () => {
  it('imports cleanly and targets the connect lift view', async () => {
    delete process.env['BRONZE_SOURCE'];
    vi.resetModules();
    const mod = await import('./index.js');
    const freshness = mod.DQ_CHECKS.find((c) => c.category === 'freshness');
    expect(freshness).toBeDefined();
    expect((freshness as { tableName: string }).tableName).toBe(LIFT_VIEW);
  });

  it('is NOT env-sensitive — a stray legacy BRONZE_SOURCE value changes nothing', async () => {
    for (const stray of ['legacy', 'events', 'connect']) {
      process.env['BRONZE_SOURCE'] = stray;
      vi.resetModules();
      const mod = await import('./index.js');
      const freshness = mod.DQ_CHECKS.find((c) => c.category === 'freshness');
      expect((freshness as { tableName: string }).tableName).toBe(LIFT_VIEW);
    }
  });
});
