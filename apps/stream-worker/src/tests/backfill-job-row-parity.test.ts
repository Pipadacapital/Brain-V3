/**
 * SEC-BF-L1 drift-guard — the BackfillJobRow row shape is declared TWICE (apps/core +
 * apps/stream-worker PgBackfillJobRepository) with no shared import (I-E05: no cross-app imports).
 * The split is intentional, but the two row interfaces must stay structurally identical or a column
 * read in one app silently diverges from the other. This pure source-text guard fails on drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const WORKER_REPO = resolve(here, '../infrastructure/pg/BackfillJobRepository.ts');
const CORE_REPO = resolve(
  here,
  '../../../core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts',
);

/** Extract the normalized `field: type;` lines of the BackfillJobRow interface body. */
function backfillJobRowFields(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('interface BackfillJobRow {');
  expect(start, `interface BackfillJobRow not found in ${file}`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('}', start));
  return body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim()) // strip line comments + whitespace
    .filter((l) => l.endsWith(';'))
    .sort();
}

describe('SEC-BF-L1 — BackfillJobRow shape parity (core ↔ worker)', () => {
  it('both interfaces declare an identical field set', () => {
    const worker = backfillJobRowFields(WORKER_REPO);
    const core = backfillJobRowFields(CORE_REPO);
    expect(worker.length).toBeGreaterThan(0);
    expect(worker).toEqual(core);
  });
});
