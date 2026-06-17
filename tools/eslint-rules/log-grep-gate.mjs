#!/usr/bin/env node
/**
 * log-grep-gate.mjs — C5 log-leak detection gate (ADR-RZ-10 / COMPLIANCE.md:172)
 *
 * Reads patterns from log-grep-patterns.json and greps the TypeScript source tree
 * for raw occurrences. Any CRITICAL/HIGH match that is not in an exempted file
 * causes a non-zero exit, blocking CI.
 *
 * Usage:
 *   node tools/eslint-rules/log-grep-gate.mjs [--path <dir>]
 *
 * Defaults to scanning the full workspace src (apps/ packages/) excluding
 * node_modules, dist, generated, and the patterns file itself.
 *
 * Wired as:   npm run log-grep  (see root package.json)
 * CI trigger: pr.yml log-grep-gate step (runs on every PR touching apps/ or packages/)
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

const GREP_EXCLUDES = [
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=.next',
  '--exclude-dir=.turbo',
  '--exclude-dir=generated',
  '--exclude-dir=coverage',
  '--exclude-dir=.git',
  '--exclude=*.json',          // pattern definitions live in JSON — skip them
  '--exclude=*.md',
].join(' ');

let foundViolations = false;

for (const entry of patterns) {
  const { pattern, description, severity, category } = entry;

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

  // Filter out exempted files
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
    '\n[log-grep-gate] FAIL — raw PII/financial identifiers detected in source. ' +
    'These must never appear in logs or unstructured output. ' +
    'See tools/eslint-rules/log-grep-patterns.json for allowed structured-log fields.\n',
  );
  process.exit(1);
} else {
  console.log('[log-grep-gate] PASS — no C5 log-leak patterns detected.');
  process.exit(0);
}
