# Requirement: Review the connector connect→backfill lifecycle fixes (branch `fix/dev-token-reach`)

| Field | Value |
|-------|-------|
| **req_id** | `fix-dev-token-reach` |
| **Title** | Retroactive review — DEV-TOKEN-REACH + connector lifecycle + real-backfill fixes |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-17T11:51:06Z |
| **Mode** | **Retroactive review of an already-implemented branch** (code is committed; run Stage 4 Security ∥ Stage 5 QA → Stage 6 final review → gate) |
| **Tier impact** | Connector connect/backfill path; touches RLS, the secrets seam, the analytics read path |

---

## Lane *(deterministic scan: high_stakes; surfaces: multi_tenancy, connectors, oauth/secrets, pii, money, schema_proto)*

---

## What is under review

The branch `fix/dev-token-reach` (diff vs `master`, 12 files, +278/-52, 2 additive migrations) was implemented **directly during a live debugging session to unblock a real Boddactive backfill** (10,009 orders → ₹2.93Cr provisional on the dashboard). It did NOT go through the normal build pipeline. This requirement runs the **review stages retroactively** so it gets the same VETO-gate scrutiny as every other slice before merge.

Reviewers: review the diff `git diff master...fix/dev-token-reach`. You have VETO. If you find a blocking issue, BOUNCE — the orchestrator will fix and re-review.

### The 8 commits (what each does + the surface to scrutinize)

1. **`9b1bcb3` DEV-TOKEN-REACH — durable cross-process dev secret store (migration 0024).** core `LocalSecretsManager` + worker `WorkerLocalSecretsManager` now back onto a `dev_secret` Postgres table so the stream-worker (separate process) can read the OAuth token core stored, surviving restarts. **Scrutinize:** is this strictly dev-only? Prod path (AwsSecretsManager) untouched? Is storing a token in a Postgres table acceptable as the dev vault stand-in (no prod leak, prod-hard-fail intact)? Is `dev_secret` exposed anywhere it shouldn't be (no API, no analytics)? brain_app grant scope.

2. **`b892577` Disconnected tile → "Connect".** BFF marketplace (`main.ts`) no longer attaches a `disconnected` instance to the tile. **Scrutinize:** correctness only; no isolation/PII impact.

3. **`781fe7f` Reconnect UPSERT (23505).** `PgConnectorInstanceRepository.save()` → `ON CONFLICT (brand_id, provider) DO UPDATE`. **Scrutinize:** does the UPSERT preserve isolation (brand_id in the conflict target)? Could it overwrite another brand's row? (No — brand_id is in the unique key + the values.)

4. **`f6c7994` OAuth callback redirects to the marketplace (not JSON).** `main.ts` callback now `reply.redirect(appBaseUrl/settings/connectors?...)`; `marketplace-view.tsx` toasts the result. **Scrutinize:** HMAC-first + state validation unchanged? Does the redirect leak anything in the query string (only `connected=<type>` / `connect_error=<code>` — no token/PII)? Open-redirect risk (redirect target is the fixed configured appBaseUrl, not user input)?

5. **`68498a2` One sync-status row per connector (migration 0025).** Dedupe + `UNIQUE(brand_id, connector_instance_id)`; `save()` UPSERTs. **Scrutinize:** additive migration; the dedupe DELETE keeps the latest; RLS/grants unchanged.

6. **`55a4d90` Worker brand-GUC robustness + surface provisional.** (a) `run.ts loadConnectorInstance` wraps the brand-scoped read in a txn and sets user/workspace GUCs to a NIL uuid so the `brand_self_read` RLS policy doesn't choke on a stale empty-string (`''::uuid`). (b) `get-revenue-metrics.ts` — "data" now = ANY ledger row (finalized OR provisional), so a brand inside the recognition horizon shows provisional revenue instead of "No data yet"; realized stays an honest 0. **Scrutinize (HIGHEST):** the NIL-uuid GUC trick — does it weaken isolation? (brand_isolation via app.current_brand_id still governs; the membership subquery matches nothing for a nil user.) The analytics change — is "show provisional, realized honestly 0" an acceptable, honest change to the D-2 empty-state contract (not a fabricated zero)?

7. **`f8d7609` Shopify pagination since_id=0 — pulls full history.** `shopify-paged-client.ts` starts page 1 at `since_id=0`. **Scrutinize:** correctness; no security surface.

8. **`4b41adc` Backfill marks connector_sync_status 'connected'.** `run.ts` on completed backfill (records>0) sets sync_status → connected under the brand GUC. **Scrutinize:** the UPDATE is brand-scoped (brand_id + connector_instance_id, GUC set); no cross-brand write.

## Success criteria the reviewers check

- **Isolation (the ONE invariant):** every new query/UPSERT/UPDATE is brand-scoped; the NIL-uuid GUC trick does NOT widen access (verify under `SET ROLE brain_app` that brand A can't touch brand B). Migrations 0024/0025 additive, RLS/grants not weakened.
- **Secrets/PII:** the `dev_secret` store is dev-only, prod-hard-fail intact, no token in any API response/log; the callback redirect query string carries no token/PII; the worker still hashes PII at the boundary (unchanged here).
- **Money:** the analytics change is honest (provisional shown, realized a true 0, never blended); no float; per-currency.
- **No regression:** the existing connector-marketplace + analytics + backfill tests still pass; typecheck core+web clean (note: stream-worker has 3 PRE-EXISTING tsc errors unrelated to this branch — a dual-path dynamic import + 2 test fixtures — confirm they pre-date this branch).

## Non-goals / notes

- This is dev-enablement + bug-fixes, not a new feature. No new deployable.
- Known follow-ups (already acknowledged, not blocking this review): a connect→disconnect→reconnect + real-pagination **regression e2e** is recommended; the Boddactive brand currency was corrected AED→INR (data fix); the recent-orders→realized conversion runs on the finalization schedule.
- The reviewers should flag (not necessarily block) anything that ought to be hardened before this dev-only pattern influences prod (e.g. the `dev_secret` table must never be reachable in prod).
