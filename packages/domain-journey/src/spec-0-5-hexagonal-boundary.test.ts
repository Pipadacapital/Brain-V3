// SPEC: 0.5
/**
 * SPEC 0.5 — "Hexagonal everywhere … No infrastructure imports inside domain code.
 * Enforce with an ESLint boundary rule added in Wave A." (WA-02)
 *
 * Proves the eslint.config.mjs `domain` boundary zone DEMONSTRABLY FIRES: a fixture
 * (piped via --stdin with a virtual path inside packages/domain-journey/src/) importing an
 * infrastructure client is rejected, a pure-domain fixture passes, and the rule is scoped —
 * the same import from a non-domain path does NOT fire the hexagonal rule.
 *
 * The ESLint CLI is spawned with cwd = repo root because eslint-plugin-boundaries resolves
 * element patterns against process.cwd() (the programmatic ESLint({ cwd }) option is NOT
 * honored by the plugin) — exactly how `pnpm run lint:boundaries` runs it in CI.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'eslint');

// Virtual fixture paths — the files need not exist on disk (--stdin --stdin-filename);
// eslint-plugin-boundaries classifies by path pattern. NOTE: not under a fixtures/ dir and
// not *.test.ts — both are excluded by `boundaries/ignore`, which would make the zone
// (correctly) inert.
const DOMAIN_FIXTURE = 'packages/domain-journey/src/hex-zone-probe.ts';
const NON_DOMAIN_FIXTURE = 'apps/stream-worker/src/hex-zone-probe.ts';

interface LintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
}

function lintVirtual(code: string, virtualPath: string): LintMessage[] {
  let stdout: string;
  try {
    stdout = execFileSync(
      ESLINT_BIN,
      ['--stdin', '--stdin-filename', virtualPath, '--no-warn-ignored', '--format', 'json'],
      { cwd: REPO_ROOT, input: code, encoding: 'utf8' },
    );
  } catch (err) {
    // ESLint exits 1 when errors are reported — the JSON report is still on stdout.
    const e = err as { stdout?: string };
    if (!e.stdout) throw err;
    stdout = e.stdout;
  }
  const report = JSON.parse(stdout) as Array<{ messages: LintMessage[] }>;
  return report[0]?.messages ?? [];
}

describe('SPEC 0.5 — hexagonal boundary zone (packages/domain-*)', () => {
  it('SPEC 0.5: each banned infrastructure client import fires boundaries/external in a domain package', () => {
    for (const client of ['kafkajs', 'ioredis', 'redis', 'neo4j-driver', 'pg', 'trino-client']) {
      const messages = lintVirtual(`import '${client}';\n`, DOMAIN_FIXTURE);
      const hits = messages.filter((m) => m.ruleId === 'boundaries/external');
      expect(hits.length, `expected boundaries/external to fire for '${client}'`).toBeGreaterThan(0);
      expect(hits[0]?.severity).toBe(2); // error, not warn
      expect(hits[0]?.message).toContain('Hexagonal boundary (SPEC: 0.5)');
    }
  });

  it('SPEC 0.5: the in-repo infrastructure adapters (@brain/metric-engine, @brain/db) fire boundaries/element-types in a domain package', () => {
    for (const adapter of ['@brain/metric-engine', '@brain/db']) {
      const messages = lintVirtual(`import '${adapter}';\n`, DOMAIN_FIXTURE);
      const hits = messages.filter(
        (m) => m.ruleId === 'boundaries/element-types' && m.message.includes('Hexagonal boundary (SPEC: 0.5)'),
      );
      expect(hits.length, `expected boundaries/element-types to fire for '${adapter}'`).toBeGreaterThan(0);
      expect(hits[0]?.severity).toBe(2);
    }
  });

  it('SPEC 0.5: pure domain code (ports only, no infrastructure) passes the zone clean', () => {
    const code = [
      'export interface JourneyEventPort { append(brandId: string, eventId: string): Promise<void>; }',
      "export const JOURNEY = 'journey' as const;",
      '',
    ].join('\n');
    const messages = lintVirtual(code, DOMAIN_FIXTURE);
    const boundaryErrors = messages.filter((m) => m.ruleId?.startsWith('boundaries/'));
    expect(boundaryErrors).toEqual([]);
  });

  it('SPEC 0.5: the hexagonal rule is SCOPED to domain packages — infra imports elsewhere do not fire it', () => {
    const messages = lintVirtual("import 'ioredis';\n", NON_DOMAIN_FIXTURE);
    const hexHits = messages.filter((m) => m.message?.includes('Hexagonal boundary (SPEC: 0.5)'));
    expect(hexHits).toEqual([]);
  });
});
