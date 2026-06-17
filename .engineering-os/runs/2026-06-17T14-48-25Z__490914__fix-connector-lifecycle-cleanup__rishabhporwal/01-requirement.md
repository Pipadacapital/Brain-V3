# Requirement: Review the two regression follow-ups (branch `fix/connector-lifecycle-cleanup`)

| Field | Value |
|-------|-------|
| **req_id** | `fix-connector-lifecycle-cleanup` |
| **Title** | Review — WorkerLocalSecretsManager prod-guard (SEC-CLR-MED-01) + regression-suite tsc cleanup (QA-CLR-LOW-01) |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T14:48:25Z |
| **Mode** | Retroactive review of an already-implemented branch (run Stage 4 Security ∥ Stage 5 QA → Stage 6 final → gate) |
| **Tier impact** | Connector secrets seam (a small prod-guard) + test hygiene |

## Lane *(deterministic: high_stakes; surfaces: connectors, oauth/secrets, multi_tenancy)*

## What is under review

Branch `fix/connector-lifecycle-cleanup` (diff vs `origin/master`, **4 files, +125/-84**) closes the two tracked follow-ups from the connector-lifecycle-regression slice. Review the diff: `git diff origin/master...fix/connector-lifecycle-cleanup -- ':!.engineering-os'`. You have VETO.

### The two changes
1. **SEC-CLR-MED-01 (product):** `apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts` — `WorkerLocalSecretsManager` constructor now hard-fails under `NODE_ENV=production` (mirrors core's `LocalSecretsManager`); the class is now `export`ed. The factory `buildWorkerSecretsManager()` already branches to AwsSecretsManager in prod — this guard defends a direct-instantiation bypass.
2. **QA-CLR-LOW-01 (tests):** removed the 8 tsc errors the regression-suite test files introduced —
   - the regression suite's `it.skip` (worker prod-guard) is now an active, passing test;
   - dropped the cross-`rootDir` import of core's `LocalSecretsManager` from the stream-worker test; **moved** the core write + prod-hard-fail assertions to a NEW in-package test `apps/core/.../secrets/LocalSecretsManager.test.ts`; the worker test now writes/deletes `dev_secret` via raw SQL and asserts the worker's READ;
   - fixed the fetch-stub `Response`/`RequestInfo` type mismatches in `connector-lifecycle-fixtures.ts`.

## Success criteria reviewers check
- **SEC-CLR-MED-01 correct + safe:** the guard mirrors core's exactly (NODE_ENV==='production' → throw); prod path unaffected (factory still selects AwsSecretsManager); exporting the class introduces no leak; no secret/PII in the diff.
- **QA-CLR-LOW-01 preserves coverage:** the core write + prod-hard-fail assertions that moved to apps/core still exist and pass (coverage not lost); the worker prod-guard test is now ACTIVE and NON-INERT (revert the guard → RED); the worker read/delete test still proves the cross-process read; the fetch-stub still drives the pagination test correctly (pagination test still green + non-inert).
- **No regression:** the full regression suite (Track A/B/C) + analytics stay green; stream-worker tsc dropped 11→3 (only PRE-EXISTING: AwsSecretsManager cross-package import + 2 older backfill.e2e ShopifyBackfillOrder fixtures — confirm these pre-date this branch); core typecheck clean.
- **D-safety:** tests seed/clean own brands; never touch 60d543dc.

## Notes
- The 3 remaining stream-worker tsc errors are pre-existing (not introduced by this branch) — acceptable-as-tracked unless a reviewer judges otherwise.
- This was implemented directly (live) to close the two follow-ups; this review gives it the gate scrutiny before merge.
