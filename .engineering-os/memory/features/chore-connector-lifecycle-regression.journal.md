# Feature Journal — chore-connector-lifecycle-regression

Regression net pinning the 8 defect classes from fix/dev-token-reach. Tests + minimal test-only harness; NO product behavior change (D-9). Lane high_stakes, paradigm tier-0 deterministic ($0/mo).

## 2026-06-17 — Stage 2 Architecture (architect, Opus 4.8)
- 8 defect classes → test → non-inert revert-RED, mapped in 03-architecture-plan.md §3.
- **ADR-R1:** D-4 pagination tested via `vi.stubGlobal('fetch')` over a 600-order in-memory store behind the REAL ShopifyBackfillClient (since_id=0 revert-RED lives at shopify-paged-client.ts:121). No product injection param added (D-9).
- **ADR-R2:** D-2 callback contract tested via a test-local Fastify `inject()` wiring the REAL HandleOAuthCallbackCommand (no buildApp() refactor — that would violate D-9). Pins 302/Location=fixed appBaseUrl/no-PII/HMAC-first.
- **ADR-R3 (DISCOVERED GAP → D-9 bounce):** WorkerLocalSecretsManager (worker-secrets.ts:69) has NO prod-hard-fail guard (core LocalSecretsManager does, :33-38). Core-side prod-fail asserted (PASS); worker-side is `it.skip` + documented discovered-bug comment + surfaced in residuals. The prod-guard fix is a SEPARATE requirement — not added here.
- **Tracks:** A@data-engineer (lead, owns A0 frozen fixtures: brand UUIDs c0nec701/702, fake-store/fetch-stub, seed/cleanup, assertBrainApp; never 60d543dc) → pagination, worker-guc(brain_app), sync-status+currency, dev-secret. B@backend-developer → reconnect-UPSERT+single-row, oauth-callback inject, provisional reference. C@frontend-web-developer → disconnected-tile→Connect e2e + callback-302 honesty.
- **Discipline:** every isolation assertion under brain_app (appPool=BRAIN_APP_DATABASE_URL) + assertBrainApp (current_user='brain_app', is_superuser=false). superPool for seed/teardown only.
- **No new migration, no new deployable.** COMMIT PER SLICE (A0 commit unblocks B/C).
- **Provisional (defect #5):** REFERENCE revenue-metrics.live.test.ts — do NOT duplicate.
- **Next:** Stage 3 builders (A0 first), GO.

## 2026-06-17T17:35:00Z — QA Engineer — chore-connector-lifecycle-regression
**Stage:** 5 · **Mode:** FULL · **Verdict:** PASS
**Smoke:** All 3 tracks green (A:33/33+1skip, B:116/116, C:9/9) · **Parity:** n/a (tier-0, no cross-runtime metric) · **Validity:** negative-controls confirmed (assertBrainApp on all isolation asserts; 22P02 proven; currency trigger P0001 proven) · **Next:** HANDOFF to Security reconciliation (Security PASSED at stage 4) → Final Approval

**Non-inert spot-checks:**
- #6 pagination: reverted `?? '0'` → `?? null` → 2 RED (since_id=0 assertions) → restored → GREEN
- #2 reconnect-UPSERT: removed ON CONFLICT clause → 1 RED (23505 duplicate key) → restored → GREEN
- #1 disconnected-tile: reverted main.ts:535 to `found` → 1 RED (Playwright input-shop-shopify not visible) → restored → GREEN

**it.skip legitimacy:** CONFIRMED (ADR-R3 — WorkerLocalSecretsManager genuinely lacks prod guard; correctly deferred per D-9)
**60d543dc brand:** ledger=19476 (~19.5k), unchanged, zero SQL references in new tests
**Git status:** CLEAN (product code; only .engineering-os/ pipeline state dirty)
**Findings:** 0 blocking · 1 LOW/deferred (QA-CLR-LOW-01: 8 new stream-worker tsc errors in test-only files; developer report falsely claimed zero new errors)
