// Trino-dialect guard: the gold-ledger money reads MUST cast amount_minor to
// VARCHAR, never bare CHAR. In Trino `CAST(x AS CHAR)` = CHAR(1) and casting a
// bigint to it fails at runtime ("Cannot cast bigint to char(1)", code 58) —
// which silently errored attribution-reconcile for every brand until fixed.
// StarRocks/MySQL treated CAST AS CHAR as a variable string; Trino needs VARCHAR.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const SRC = readFileSync(fileURLToPath(new URL('./reconcile-attribution.ts', import.meta.url)), 'utf8');

describe('reconcile-attribution Trino dialect', () => {
  it('casts amount_minor to VARCHAR (never bare CHAR)', () => {
    expect(SRC).not.toMatch(/CAST\(amount_minor AS CHAR\)/);
    const varcharCasts = SRC.match(/CAST\(amount_minor AS VARCHAR\)/g) ?? [];
    expect(varcharCasts.length).toBe(2); // finalized-orders read + reversals read
  });
});
