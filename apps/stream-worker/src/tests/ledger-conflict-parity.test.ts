/**
 * SEC-BF-M2 drift-guard — the realized_revenue_ledger dedup arbiter index is PARTIAL (migration
 * 0054: WHERE event_type <> 'refund'; carried forward as realized_revenue_ledger_dedup_p in the
 * C4b partition migration 0073). Postgres can only infer a partial index as the ON CONFLICT arbiter
 * when that predicate is restated in the clause; a dedup-tuple ON CONFLICT WITHOUT it fails plan-time
 * inference on EVERY insert ("no unique or exclusion constraint matching the ON CONFLICT
 * specification"). The clause is hand-written in multiple places (PgLedgerRepository, LedgerWriter,
 * revenue-finalization, …) with no shared import, so this guard scans the WHOLE codebase and fails
 * if ANY dedup-tuple ON CONFLICT is missing the predicate. Pure source-text (no DB) → unit tier.
 *
 * C4b note: the arbiter tuple is now (brand_id, order_id, event_type, occurred_date) — occurred_date
 * is an app-set NOT NULL column (CHECK-pinned to timezone('UTC', occurred_at)::date) and the table's
 * RANGE partition key, replacing the old expression-index tuple (…, (timezone('UTC', occurred_at)::date)).
 * Semantics are identical (occurred_date == the old expression); the predicate is still mandatory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..'); // apps/stream-worker/src/tests → repo root

const SCAN_ROOTS = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages')];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);

// The dedup arbiter tuple (migration 0018/0054 → 0073 partition). The capture group is the rest of that line.
const DEDUP_TUPLE = /ON CONFLICT\s*\(brand_id,\s*order_id,\s*event_type,\s*occurred_date\)([^\n]*)/g;
const REQUIRED_PREDICATE = "WHERE event_type <> 'refund'";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** All { file, tail } occurrences of the dedup-tuple ON CONFLICT across the source tree. */
function dedupClauseSites(): Array<{ file: string; tail: string }> {
  const sites: Array<{ file: string; tail: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(DEDUP_TUPLE)) {
        sites.push({ file: file.replace(REPO_ROOT + '/', ''), tail: m[1] ?? '' });
      }
    }
  }
  return sites;
}

describe('SEC-BF-M2 — every realized_revenue_ledger dedup ON CONFLICT carries the partial predicate', () => {
  const sites = dedupClauseSites();

  it('finds the known dedup-tuple writers (guards against a silent rename)', () => {
    // PgLedgerRepository + LedgerWriter (6) + revenue-finalization were the known writers.
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('NO dedup-tuple ON CONFLICT anywhere is missing the partial predicate', () => {
    const offenders = sites.filter((s) => !s.tail.includes(REQUIRED_PREDICATE));
    expect(offenders, `predicate-less dedup ON CONFLICT in: ${offenders.map((o) => o.file).join(', ')}`).toEqual([]);
  });
});
