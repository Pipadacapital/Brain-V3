/**
 * nlq-resolution.eval.test.ts — the NLQ-resolution EVAL GATE (Track A / D6).
 *
 * CI-BLOCKING honesty gate. Target: ZERO honesty-gate failures.
 *
 * The model call is MOCKED deterministically from golden-set.json (no live LLM in
 * CI) — each case carries the exact payload the model emits into the constrained
 * tool/JSON-schema. The structural assertions (enum-only, no-SQL, no-number) run
 * WITHOUT the model.
 *
 * Four assertions, all CI-blocking:
 *   1. every-number-traces-to-binding — a number may be surfaced ⇔ a validated
 *      metric_binding exists. No binding → no number (asserted via the resolver's
 *      output union: a refusal carries no metric_id/version a number could attach to).
 *   2. no-SQL / no-number — the resolver output is ONLY { kind:'binding'|'refusal' };
 *      it has no `sql` field and no numeric-answer field, for EVERY golden case.
 *   3. off-domain-refused — off-domain / smuggle questions resolve to kind:'refusal',
 *      never a fabricated binding or number.
 *   4. reproducibility — a binding + its snapshot_id is deterministic: the same
 *      (binding, snapshot_id) round-trips to the same as_of, and re-resolving the
 *      same question yields the byte-identical binding.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ResolverClient, type GatewayTransport } from '@brain/ai-gateway-client';
import { resolveQuestion, type ResolveOutcome } from '../nlq/resolve-question.js';
import { encodeSnapshot, decodeSnapshot } from '../internal/snapshot.js';

interface GoldenCase {
  readonly id: string;
  readonly question: string;
  readonly model_returns: unknown;
  readonly expected: { kind: 'binding'; metric_id: string; version: string } | { kind: 'refusal' };
}

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'golden-set.json'), 'utf8')) as { cases: GoldenCase[] };

/** A deterministic gateway whose model payload is keyed by the exact question. */
function goldenTransport(): GatewayTransport {
  const byQuestion = new Map(golden.cases.map((c) => [c.question, c.model_returns]));
  return async (req) => {
    if (!byQuestion.has(req.question)) {
      throw new Error(`no golden fixture for question: ${req.question}`);
    }
    return byQuestion.get(req.question);
  };
}

function clientFor(): ResolverClient {
  return new ResolverClient({ transport: goldenTransport() });
}

/**
 * Structural guard: a resolver outcome must NEVER carry a `sql` field or a numeric
 * answer. This checks the output STRUCTURE (its keys + any binding params), NOT the
 * human-readable refusal `reason` prose — a refusal may honestly say "rejected a
 * banned sql field" without that being a leaked query.
 */
function assertNoSqlNoNumber(outcome: ResolveOutcome, id: string): void {
  // The ONLY keys the resolver may emit. A `sql`/`value`/`number` key cannot appear.
  const allowed = new Set(['kind', 'reason', 'metric_id', 'version', 'params']);
  for (const k of Object.keys(outcome as unknown as Record<string, unknown>)) {
    expect(allowed.has(k), `[${id}] unexpected key "${k}" in resolver output`).toBe(true);
  }
  // A binding's params may ONLY hold allow-listed keys — never sql / a number.
  if (outcome.kind === 'binding') {
    const paramKeys = new Set(['date_from', 'date_to', 'channel']);
    for (const k of Object.keys(outcome.params)) {
      expect(paramKeys.has(k), `[${id}] unexpected binding param "${k}"`).toBe(true);
    }
    // No params value is numeric — params are all string allow-list values.
    for (const v of Object.values(outcome.params)) {
      expect(typeof v, `[${id}] non-string binding param value`).toBe('string');
    }
  }
}

describe('NLQ-resolution EVAL GATE (CI-blocking honesty gate)', () => {
  it('golden set is non-trivial and mixes bindings + refusals', () => {
    const bindings = golden.cases.filter((c) => c.expected.kind === 'binding').length;
    const refusals = golden.cases.filter((c) => c.expected.kind === 'refusal').length;
    expect(bindings).toBeGreaterThanOrEqual(5);
    expect(refusals).toBeGreaterThanOrEqual(4);
  });

  it('Assertion 1+2+3: every golden case resolves to the expected kind, with no SQL / no number', async () => {
    const client = clientFor();
    const failures: string[] = [];

    for (const c of golden.cases) {
      const outcome = await resolveQuestion(c.question, client);

      // (2) no-SQL / no-number — for EVERY case, binding or refusal.
      assertNoSqlNoNumber(outcome, c.id);

      // (1) every-number-traces-to-binding: a number may only attach to a binding.
      // Expected-binding cases MUST resolve to a binding (so a number CAN be computed);
      // expected-refusal cases MUST resolve to a refusal (so NO number is ever produced).
      if (c.expected.kind === 'binding') {
        if (outcome.kind !== 'binding') {
          failures.push(`${c.id}: expected binding, got ${outcome.kind}`);
          continue;
        }
        if (outcome.metric_id !== c.expected.metric_id || outcome.version !== c.expected.version) {
          failures.push(`${c.id}: bound ${outcome.metric_id}/${outcome.version}, expected ${c.expected.metric_id}/${c.expected.version}`);
        }
      } else {
        // (3) off-domain / smuggle → refusal, NEVER a fabricated binding/number.
        if (outcome.kind !== 'refusal') {
          failures.push(`${c.id}: expected refusal (off-domain/banned), got a binding ${JSON.stringify(outcome)}`);
        }
      }
    }

    expect(failures, `honesty-gate failures:\n${failures.join('\n')}`).toEqual([]);
  });

  it('Assertion 4: a binding + snapshot_id is reproducible (deterministic round-trip + re-resolve)', async () => {
    const asOf = '2026-06-18';
    const snapshotId = encodeSnapshot(asOf);
    // Snapshot round-trips deterministically (the reproducibility handle).
    expect(decodeSnapshot(snapshotId)).toBe(asOf);
    expect(encodeSnapshot(asOf)).toBe(snapshotId);

    // Re-resolving the same question yields the BYTE-IDENTICAL binding (temp-0 +
    // deterministic validation) — the binding half of "same (binding, snapshot) → same number".
    const client = clientFor();
    const q = 'What was my realized revenue from January to June 2026?';
    const a = await resolveQuestion(q, client);
    const b = await resolveQuestion(q, client);
    expect(a.kind).toBe('binding');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('structural ban: NO golden model payload that smuggles SQL/number ever yields a binding', async () => {
    const client = clientFor();
    for (const c of golden.cases) {
      const raw = JSON.stringify(c.model_returns);
      if (/"sql"/i.test(raw) || /"value"|"number"|"amount"/i.test(raw) || /orders_raw_table|customer_email/i.test(raw)) {
        const outcome = await resolveQuestion(c.question, client);
        expect(outcome.kind, `[${c.id}] a smuggled SQL/number/out-of-enum payload must refuse`).toBe('refusal');
      }
    }
  });
});
