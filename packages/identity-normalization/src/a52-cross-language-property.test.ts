// SPEC: A.5.2
/**
 * a52-cross-language-property.test.ts — MANDATORY cross-language hash-equivalence property
 * test (WA-06): 12k deterministic mixed identifiers (unicode emails, NFC/NFD variants,
 * IN/GCC phone formats, garbage) hashed by TS (@brain/identity-normalization) and re-derived
 * by Python (db/iceberg/spark/_identity_normalization.py) — required byte-identical,
 * 0 mismatches. Hash drift silently destroys stitch rates (SPEC A.1.3).
 *
 * Skips (loudly) only when python3 + `phonenumbers` are unavailable in the environment;
 * the same flow is runnable standalone via scripts/run-a52-property-test.sh.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { corpusJsonl } from './a52-gen-corpus.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PY_DIFFER = join(REPO_ROOT, 'db/iceberg/spark/_identity_normalization_xlang_test.py');

const pythonAvailable = ((): boolean => {
  try {
    execFileSync('python3', ['-c', 'import phonenumbers'], { stdio: 'pipe' });
    return true;
  } catch {
     
    console.warn(
      '[A.5.2] SKIPPED: python3 with `phonenumbers` not available — run ' +
        'scripts/run-a52-property-test.sh in an environment with the pinned dep (see Dockerfile).',
    );
    return false;
  }
})();

describe.skipIf(!pythonAvailable)('A.5.2 cross-language hash equivalence (TS <-> Python twin)', () => {
  it('12k mixed identifiers: normalized + interop + internal byte-identical, 0 mismatches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a52-'));
    const corpusPath = join(dir, 'corpus.jsonl');
    try {
      const jsonl = corpusJsonl();
      writeFileSync(corpusPath, jsonl, 'utf8');

      const out = execFileSync('python3', [PY_DIFFER, corpusPath], { encoding: 'utf8' });
       
      console.log(out.trim());

      expect(out).toMatch(/MISMATCHES=0(\s|$)/);
      const rows = Number(/ROWS=(\d+)/.exec(out)?.[1] ?? 0);
      expect(rows).toBeGreaterThanOrEqual(10000); // A.5.2: 10k+ identifiers
      const hashed = Number(/HASHED=(\d+)/.exec(out)?.[1] ?? 0);
      expect(hashed).toBeGreaterThan(5000); // corpus must be meaningfully non-degenerate
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
