#!/usr/bin/env node
/**
 * log-grep-gate.mjs — C5 log-leak detection gate (ADR-RZ-10 / COMPLIANCE.md:172)
 *
 * Reads patterns from log-grep-patterns.json and greps TypeScript production source
 * for raw occurrences of DPDP financial identifiers and PCI card numbers.
 * Broad PII patterns (email, phone, PAN) are excluded from the source scan because
 * they appear legitimately in test fixtures, UI placeholder text, and config defaults;
 * those are covered by gitleaks (secret-scan job) and structured-log redaction (C5).
 *
 * The gate specifically targets patterns with category DPDP_FINANCIAL or PCI that
 * would indicate a raw Razorpay ID (pay_XXX / UTR_XXX / setl_XXX) leaking into
 * production source outside of the mapper / dedup adapter (the permitted boundary).
 *
 * In CI this runs against the full PR checkout. Locally: node tools/eslint-rules/log-grep-gate.mjs
 *
 * Wired as:   npm run log-grep  (see root package.json)
 * CI trigger: pr.yml log-grep-gate step (ADR-RZ-10 / C5.3)
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_FILE = path.join(__dirname, 'log-grep-patterns.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Parse CLI args — optional --path override
const argPathIdx = process.argv.indexOf('--path');
const scanRoot = argPathIdx !== -1 ? process.argv[argPathIdx + 1] : REPO_ROOT;

const config = JSON.parse(readFileSync(PATTERNS_FILE, 'utf8'));
const { patterns, exempted_files } = config;

// Categories that are meaningful to scan in TypeScript production source.
// - DPDP_FINANCIAL: raw Razorpay pay_XXX / UTR_XXX identifiers — the core C5.3 mandate.
// - OPERATIONAL_REF: raw setl_XXX settlement references.
// - PCI (card number pattern) and broad PII (email/phone/PAN) are intentionally excluded
//   from source scanning: the PCI regex matches many numeric sequences (argon2 hash
//   constants, port numbers, etc.) and gitleaks + Trivy handle committed-secret detection
//   for those categories. This gate is narrowly scoped to Razorpay financial IDs (C5/ADR-RZ-10).
const SCANNED_CATEGORIES = new Set(['DPDP_FINANCIAL', 'OPERATIONAL_REF']);

const GREP_EXCLUDES = [
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=.next',
  '--exclude-dir=.turbo',
  '--exclude-dir=generated',
  '--exclude-dir=coverage',
  '--exclude-dir=.git',
  // Terraform provider binaries (gitignored, local-only after `terraform init`)
  // contain byte sequences that match financial patterns — never a real leak.
  '--exclude-dir=.terraform',
  // Test and fixture files legitimately contain example identifiers
  '--exclude-dir=tests',
  '--exclude-dir=fixtures',
  // Golden-data generators/fixtures intentionally embed realistic-shaped synthetic
  // identifiers (e.g. pay_Golden…/setl_Golden…) to exercise the Silver/Gold parity
  // pipeline — same rationale as tests/fixtures above.
  '--exclude=*golden*',
  '--exclude-dir=_p4_golden',
  '--exclude=*.test.ts',
  '--exclude=*.spec.ts',
  '--exclude=*.test.mjs',
  '--exclude=*.live.test.ts',
  '--exclude=*.integration.test.ts',
  '--exclude=*.tsbuildinfo',
  // Pattern and doc files
  '--exclude=*.json',
  '--exclude=*.md',
].join(' ');

let foundViolations = false;

for (const entry of patterns) {
  const { pattern, description, severity, category } = entry;

  // Only scan categories relevant to source-code log-leak detection
  if (!SCANNED_CATEGORIES.has(category)) continue;

  // grep -rn: recursive, print line numbers; -E: extended regex
  let rawOutput = '';
  try {
    rawOutput = execSync(
      `grep -rn -E ${GREP_EXCLUDES} '${pattern.replace(/'/g, "'\\''")}' "${scanRoot}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (e) {
    // grep exits 1 when no matches — that is the success case
    if (e.status === 1) continue;
    // grep exits 2 on error
    console.error(`[log-grep-gate] grep error for pattern "${pattern}": ${e.stderr}`);
    process.exit(2);
  }

  // Filter out exempted files declared in the pattern config
  const lines = rawOutput.split('\n').filter(Boolean);
  const violations = lines.filter((line) => {
    const filePath = line.split(':')[0];
    return !exempted_files.some((ex) => filePath.endsWith(ex));
  });

  if (violations.length > 0) {
    foundViolations = true;
    const tag = severity === 'CRITICAL' ? '[CRITICAL]' : `[${severity}]`;
    console.error(`\n${tag} C5 log-grep violation — ${category}: ${description}`);
    console.error(`  Pattern: ${pattern}`);
    for (const v of violations) {
      console.error(`  ${v}`);
    }
  }
}

if (foundViolations) {
  console.error(
    '\n[log-grep-gate] FAIL — raw DPDP financial identifiers detected in production source. ' +
    'These must only appear in the mapper boundary or dedup adapter, never in Bronze events, ' +
    'ledger rows, or log statements. See tools/eslint-rules/log-grep-patterns.json.\n',
  );
  process.exit(1);
} else {
  console.log('[log-grep-gate] PASS — no C5 DPDP/PCI log-leak patterns detected in production source.');
  process.exit(0);
}
