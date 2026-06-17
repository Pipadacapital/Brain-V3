# Final Review — fix-connector-lifecycle-cleanup

| Field | Value |
|-------|-------|
| **req_id** | `fix-connector-lifecycle-cleanup` |
| **Stage** | 6 (final review) |
| **Reviewer** | Engineering Advisor (final-reviewer, Opus) |
| **Timestamp** | 2026-06-17T19:05:00Z |
| **Branch** | `fix/connector-lifecycle-cleanup` (diff vs origin/master: 4 files, +125/-84) |
| **Upstream** | Security PASS (0 findings) · QA PASS (0 blocking) |

## Recommendation: **APPROVE** (PASS · blocking: 0)

**One-line risk:** Near-zero — a belt-and-suspenders prod-guard (never reached by the factory in prod) plus test-only hygiene; no migration, no RLS/grant, no behavioral product change.

---

## What this branch is

Closes the two tracked follow-ups recommended at the end of `chore-connector-lifecycle-regression`
(confirmed in the cto-advisor journal entry 2026-06-17T18:15:00Z):

1. **SEC-CLR-MED-01 (product):** `WorkerLocalSecretsManager` constructor now hard-fails under `NODE_ENV=production`; class is now `export`ed.
2. **QA-CLR-LOW-01 (tests):** removed the 8 test-file tsc errors — un-skipped A4-3 (now active, non-inert), moved the core write + prod-hard-fail assertions in-package to `apps/core/.../secrets/LocalSecretsManager.test.ts`, fixed the fetch-stub DOM-type mismatch.

Lineage is clean: this branch closes exactly the two debt items the prior run filed — no scope creep.

---

## Independent verification (replicated, captured)

### Spot-confirm — product change mirrors core exactly
- Worker guard `worker-secrets.ts:74` condition `process.env['NODE_ENV'] === 'production'` is **identical** to core `LocalSecretsManager.ts:33`; both throw `[ClassName] FATAL` before any work. Confirmed by reading both files.
- **Prod path unaffected:** factory `buildWorkerSecretsManager()` returns `AwsSecretsManager` at line 46 (prod branch at line 37) **before** reaching `new WorkerLocalSecretsManager()` at line 50. The guard only defends a direct-instantiation bypass — correct threat model.
- **`export` adds no surface:** exporting the class does not change runtime behavior; the guard fires on construction regardless of import path. Added only for the A4-3 test import.

### Gate re-runs (≥3, independently replicated)
| Gate | Command (apps/...) | Result | Replicated QA? |
|------|--------------------|--------|----------------|
| stream-worker tsc | `npx tsc --noEmit` | **3 errors** (1× TS2307 factory require + 2× TS2345 backfill.e2e fixtures) | ✓ matches 11→3 |
| stream-worker dev-secret | `vitest run src/tests/dev-secret.integration.test.ts` | **4 passed / 0 skipped**, A4-3 active+green | ✓ |
| core LocalSecretsManager | `vitest run .../secrets/LocalSecretsManager.test.ts` | **3 passed** (moved coverage present) | ✓ coverage preserved |

### Negative-control re-replication (independent, not trusting QA's capture)
Removed the worker prod-guard → re-ran A4-3 → **RED** (`expected [Function] to throw an error`, 1 failed / 3 passed) → restored → `git diff` **empty**. The test is genuinely non-inert; the QA `negative_controls[]` entry is valid (no bypass-green, no inert probe).

### Pre-existing proof for the 3 residual tsc errors
- TS2307 `require(...AwsSecretsManager...)`: the line exists **verbatim on origin/master** (`git show origin/master:.../worker-secrets.ts`) — it's in the factory, untouched by this diff.
- 2× TS2345 in `backfill.e2e.test.ts`: that file has **zero diff** in this branch → cannot be branch-introduced.

### Data-safety
`60d543dc` grep on diff = **0 matches**. QA confirmed `realized_revenue_ledger` = 19476 rows (untouched). git clean after all operations.

---

## Over-engineering / Single-Primitive audit
**CLEAN.** One guard (mirrors an existing primitive, not a new one), one in-package test move, one type-narrowing fix. No new files beyond the necessary in-package test, no new deps, no new abstractions, no WHAT-comments (the added comments explain *why* — threat model + the cross-rootDir rationale). Diff is surgical: tests-and-one-guard only.

## Cost-paradigm audit
**N/A / tier-0.** No model path, no endpoint, no decision path calling a model. Pure deterministic guard + test hygiene. $0.

## Hard-rule deviation check
**None.** No dependency violation, no Single-Primitive violation, no compliance gap, no paradigm escalation, no un-codified gate-skip. The factory's cross-package `require()` (TS2307) is pre-existing tracked debt, not introduced here.

## Verification-validity confirm
QA `negative_controls[]` populated and independently re-replicated (guard removed → RED → restored). Security validity check confirms A4-3 runs the real module via dynamic import (no mock bypass). No bypass-green, no inert probe, no tautological parity.

---

## My call on the 3 pre-existing stream-worker tsc errors: **ACCEPTABLE-AS-TRACKED** (do not block; recommend a tiny follow-up)

These three pre-date this branch and are proven so (verbatim on master / unchanged file). Blocking a clean, net-positive debt-reduction branch (8→0 of its own errors) on pre-existing errors it didn't create would be process tax against the surgical-changes principle. However:
- TS2307 (the factory's cross-package `require('../../../../../../apps/core/...AwsSecretsManager.js')`) means the stream-worker prod secrets path is effectively **outside the tsc gate** — a latent typing blind-spot on a secrets seam. Worth a small follow-up (proper package import or path alias), **recommend not file** — surface to Stakeholder as tracked debt.
- The 2× TS2345 backfill.e2e fixture errors are pure test-fixture typing — low value, batch into the same follow-up.

This is a recommendation, not a blocker. The branch is mergeable as-is.

---

## Retro (condensed)
Root cause of this branch: a deliberately-deferred MED guard + test-hygiene debt from the prior connector-lifecycle run, now correctly closed in a dedicated PR (D-9 honored: the discovered gap was surfaced, not silently fixed, then fixed in its own branch). No new rule-proposal: recurrence threshold for a new durable rule not met; the relevant rule (`system-job-force-rls-enumeration`) is already adopted and honored. The one process lesson worth noting — the prior dev-report's "zero new tsc errors" claim was false and QA caught it; that Stage-5 catch is what produced QA-CLR-LOW-01. The gate worked.

## Risks remaining
- **Latent (tracked):** stream-worker prod secrets path is outside the tsc gate (TS2307 cross-package require). Recommend a tiny follow-up; not a release blocker.
- No other open risk. Prod path provably unaffected.

## Verdict: **PASS → Stakeholder gate (Stage 7).** Did NOT commit. Did NOT advance the gate.
