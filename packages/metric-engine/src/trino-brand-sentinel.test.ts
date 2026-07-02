/**
 * trino-brand-sentinel.test.ts — static guard for the positional brand-binding invariant
 * (AUD-ARCH-013).
 *
 * THE INVARIANT: withTrinoBrand/withSilverBrand replace the FIRST ${BRAND_PREDICATE} sentinel
 * with `brand_id = ?` and append brandId as the LAST param. Client-side substitution is purely
 * positional (substituteParams walks `?` left-to-right), so the sentinel MUST be the LAST
 * placeholder in the SQL — a stray `?` after it would receive the brandId (or shift a data
 * value into the brand_id slot). substituteParams now throws on any count mismatch (runtime
 * guard); this test statically proves the ordering across every SQL template in the serving
 * read paths so a misordered query never ships.
 *
 * Scope: all non-test .ts sources in packages/metric-engine, apps/core, apps/stream-worker
 * (the three Trino serving-read codebases). Two assertions:
 *   1. every template literal containing the sentinel has NO `?` placeholder after it
 *      (SQL line comments and single-quoted literals are stripped first — a `?` in prose
 *      or in a quoted literal is not a placeholder);
 *   2. every INLINE runScoped(`...`) SQL template contains the sentinel (variable-passed SQL
 *      is covered by the seam's fail-closed runtime throw).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages/metric-engine/src'),
  join(REPO_ROOT, 'apps/core/src'),
  join(REPO_ROOT, 'apps/stream-worker/src'),
];

const SENTINEL = '${BRAND_PREDICATE}';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Remove SQL line comments and single-quoted string literals — a `?` inside them is not a placeholder. */
function stripNonPlaceholderText(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
}

/** Extract template literals (heuristic: no nested backticks — true for all SQL templates here). */
function templateLiterals(source: string): string[] {
  return source.match(/`(?:[^`\\]|\\.)*`/gs) ?? [];
}

const files = SCAN_ROOTS.flatMap((root) => walk(root));

describe('brand-predicate sentinel is the LAST placeholder in every serving SQL', () => {
  it('scans a meaningful corpus (sanity: the seam callers are actually visible)', () => {
    expect(files.length).toBeGreaterThan(100);
    const withSentinel = files.filter((f) => readFileSync(f, 'utf8').includes(SENTINEL));
    expect(withSentinel.length).toBeGreaterThan(20);
  });

  it('no template literal has a `?` placeholder AFTER the ${BRAND_PREDICATE} sentinel', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(SENTINEL)) continue;
      for (const tpl of templateLiterals(source)) {
        const at = tpl.indexOf(SENTINEL);
        if (at === -1) continue;
        const tail = stripNonPlaceholderText(tpl.slice(at + SENTINEL.length));
        if (tail.includes('?')) {
          violations.push(
            `${relative(REPO_ROOT, file)}: \`?\` placeholder after ${SENTINEL} — ` +
              `the appended brandId would bind to the wrong slot:\n${tpl.slice(0, 200)}…`,
          );
        }
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });

  it('every inline runScoped(`...`) SQL contains the ${BRAND_PREDICATE} sentinel', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('runScoped')) continue;
      const calls = source.matchAll(/\.runScoped(?:<[^(`]*?>)?\s*\(\s*(`(?:[^`\\]|\\.)*`)/gs);
      for (const m of calls) {
        const tpl = m[1]!;
        if (!tpl.includes(SENTINEL)) {
          violations.push(
            `${relative(REPO_ROOT, file)}: inline runScoped SQL without ${SENTINEL}:\n${tpl.slice(0, 200)}…`,
          );
        }
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });
});
