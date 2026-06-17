# 11 — Final Review (Stage 6): feat-connector-backfill

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 6 — Final Review (BINDING gate before Stakeholder) |
| **Lane** | high_stakes (auth, connectors, metric_engine, money, multi_tenancy, pii, schema_proto, outbound_channel) |
| **Reviewer** | Engineering Advisor (final-reviewer) |
| **Mode** | DELTA-aware full read (both parallel reviews PASS after one bounce round) |
| **Recommendation** | **APPROVE** → Stakeholder gate (Stage 7) |
| **Blocking** | **0** |
| **Reviewed at** | 2026-06-17T16:10:00Z |

---

## One-line risk

The slice is structurally sound and the payoff is proven in code, but a real live Boddactive dev backfill still needs the OAuth token reachable by the **worker** process (ADR-BF-11, dev env-backed) — a tracked validation follow-up, not a slice blocker.

---

## Verification summary (spot-re-run at source — did NOT trust the reports)

| Gate | Independent result |
|------|--------------------|
| **worker-runs** (SEC-BF-H1 / QA-BF-B1) | **REPLICATED.** Live DB: `list_queued_backfill_jobs` is `prosecdef=t` + `search_path=public` pinned (identical posture to `list_active_brand_ids`). Negative control under `brain_app` (`rolbypassrls=f`, not superuser): bare `SELECT … FROM backfill_job` with no GUC → **0 rows** (FORCE RLS fail-closed, non-inert). T11 re-run green: fn returns the seeded job; the worker poll loop is no longer structurally inert. `run.ts` sets `set_config('app.current_brand_id', brandId, true)` BEFORE the brand-scoped `connector_instance JOIN brand` read (GUC-before-read confirmed at run.ts:265). |
| **payoff-proven** (QA-BF-B2 / SC#10) | **REPLICATED.** Re-ran T12: captured stdout `[revenue-finalization] finalized brand=aa111111… order=T12-PAST-DATED-ORDER-001 amount=250000 INR` / `complete: finalized=1 skipped=0`; idempotent second run `finalized=0 skipped=0`. The REAL `runRevenueFinalization()` executed (not a stub); `event_type='finalization'`, `amount_minor='250000'` (no float drift). The economic point of the slice genuinely runs. occurred_at stored as the past date (D-6), not NOW(). |
| **PII** (D-10) | **CONFIRMED at source.** `order-mapper.ts` consumes `customer.email`/`customer.phone` only to hash, explicitly DROPS the customer object (line 127), and emits only `hashed_customer_email`/`hashed_customer_phone`/`storefront_customer_id` (numeric platform id — not a contact identifier). No raw email/phone/name/address in the event payload. Addresses never fetched into the payload. |
| **isolation** (the ONE invariant) | **REPLICATED.** Live DB: `backfill_job` has `relrowsecurity=t` + `relforcerowsecurity=t`; brain_app grants = SELECT/INSERT/UPDATE, **no DELETE** (D-12). T4 re-run: cross-brand Bronze read under `brain_app` + wrong GUC → 0 rows. The SECURITY DEFINER bypass is minimal: 3 dispatch-only columns (id, brand_id, connector_instance_id), no order/customer/ledger/cursor content. |
| **two-lane** (D-3) | **CONFIRMED at source.** `infra/redpanda/topics.yml`: new dedicated topic `{env}.collector.order.backfill.v1` with **partitions: 1** (natural throughput cap), consumer group `stream-worker-backfill`, distinct from the live `{env}.collector.event.v1`. Different topic (not same-topic-different-group) → backfill storm structurally cannot lag `stream-worker-live`. |
| **money** (D-13) | **CONFIRMED.** `decimalStringToMinor` integer-arithmetic re-run green (T5: `99999.99 → 9999999n` no float error; rejects >2 decimals, negatives). LedgerWriter ON-CONFLICT key byte-identical to core `PgLedgerRepository`. |
| **authz** (D-15) | **REPLICATED.** Backend B3 suite re-run green (11/11), incl. `meetsMinimumRole(manager, brand_admin)===false` (non-inert) and brand_app isolation positive+negative controls. |

Suites re-run from source this review:
- `apps/stream-worker/src/tests/backfill.e2e.test.ts` → **35/35 PASS** (T11 worker-runs + T12 payoff + T4 isolation captured).
- `apps/core … backfill-trigger.live.test.ts` → **11/11 PASS** (authz + isolation).
- Live DB introspection of fn security, RLS force, grants, and the negative control.

(QA's full-suite figure of 67/67 spans all 5 stream-worker test files; the backfill file alone is 35.)

---

## Negative-control validity (Stage-5/4 artifact confirm)

The QA verdict carries a populated `negative_control[]` with captured RED output on the tenancy/money paths:
- backfill_job FORCE-RLS no-GUC → 0 rows (the worker-inert bug's exact failure mode) — **proves the fix is not tautological**.
- bronze_events wrong-GUC → 0 rows; brand_A GUC → 1 row.
- Authz: `meetsMinimumRole` manager negative control.

No bypass-green, no inert probe, no tautological parity. Validity check: **PASS.**

---

## Over-engineering / drift / hard-rule audit

- **Drift:** delivered == plan. Every D-1..D-15 and ADR-BF-1..15 is honored at source. No requirement was dropped or silently re-scoped.
- **No new deployable (I-E05, hard rule):** confirmed — `git diff` shows no new Dockerfile / gitops app / Argo / Helm / new package.json. Worker lives in the existing `stream-worker` as a job (mirrors `revenue-finalization`); the consumer is wired into the existing `main.ts`.
- **Dependency hard-rule:** clean — no new external runtime dependency (lockfile delta is an internal workspace package + a transitive vitest re-resolution).
- **Single-Primitive:** extend-only (one Bronze writer reused, one identity bridge, one finalization job unchanged, one secrets seam, one audit writer, one RBAC guard, one connector_cursor). New additive surface only: 1 table, 1 fn, 1 topic, 1 worker job, 1 lane consumer, 1 scaffolded-but-missing ledger wire.
- **Scope boundary:** no live-sync / Razorpay-settlement / other-connectors / Argo / Silver-Gold / GraphQL-bulk in the diff. In-lane.
- **Paradigm (cost-routing):** tier-0 deterministic throughout, $0/mo model spend. No model call, no escalation beyond plan. The `cost-routing-paradigms` gate is N/A by construction (no path calls a model) and the plan declares it correctly.
- **No WHAT-comments / drive-by refactor:** the only edit to a live route is the 501→202 realization behind the existing brand_admin gate; comments are WHY (ADR refs).

**Over-engineering audit: PASS. Hard-rule deviation check: none.**

---

## Risks remaining (for the Stakeholder to weigh — all non-blocking)

1. **Dev-token reachability for a real live backfill (tracked follow-up, NOT a slice blocker).** ADR-BF-11: the worker is a separate process from core; in dev the worker reads the token via its own env-backed `WorkerSecretsManager`, not core's in-memory Map. The SLICE (fixtures + the proven finalization path) is complete and verified. A real Boddactive dev backfill additionally requires the `SHOPIFY_*` dev token to be reachable by the stream-worker process at run time. If `getSecret` returns null the worker fails with `RECONNECT_REQUIRED` + a checkpoint cursor (graceful, not a silent hang). **Recommend: track as the Stage-validation step (live Boddactive backfill), explicitly out of the automated gate.**
2. **SEC-BF-M2 (MEDIUM, open/deferred):** dual `LedgerWriter` (stream-worker) vs core `PgLedgerRepository` may drift. **Confirmed aligned today** — ON-CONFLICT key `(brand_id, order_id, event_type, (timezone('UTC',occurred_at)::date))` is byte-identical across both; same GUC pattern; same money handling. Post-M1: extract a shared `@brain/ledger-writer`. Acceptable for M1.
3. **SEC-BF-L1 (LOW, open/deferred):** dual `PgBackfillJobRepository` (core + stream-worker). Intentional split (no cross-package import; I-E05). Currently aligned. Post-M1 shared-package extraction.
4. **Documented non-blocking test skips — judged acceptable:**
   - backfill.spec.ts test 3 (manager UI gate) env-skips when the invite UI isn't seeded locally. The server gate is the authoritative control and is unit-proven (B3 T2 `meetsMinimumRole`, non-inert). The UI gate is cosmetic. **Acceptable** — the authoritative gate is server-side and proven.
   - tests 6/7 env-guarded on `SHOPIFY_CONNECTED_CONNECTOR_ID` (live Shopify). Their logic is covered by B3 unit gates. **Acceptable.**
   - SC#4 (paging/429) and SC#8 (terminal states) are not demonstrated end-to-end against a real network (fixture/mock only) — consistent with the plan's "real-network smoke = Stage validation, not a unit gate." **Acceptable for the slice**; folds into the live-Boddactive validation.
5. **Carried debt from upstream merges:** F-SEC-01 (realized-revenue-ledger Argo no-op under FORCE-RLS — the #1 occurrence of this same pattern) remains a pending-stakeholder conscious-accept; this slice's 0023 fn is the same remedy applied to the backfill worker.

---

## /adopt-rule recommendation (auto-candidate — 3rd occurrence)

**RECOMMENDED.** This run is the **3rd distinct occurrence** of the "system/cron job needs to enumerate tenants across a FORCE-RLS table → bare `brain_app` SELECT returns 0 rows → job is structurally inert" failure pattern:
1. `feat-identity-graph` — `phone-guard-reeval.ts` (run c9a1a0, SR-01/QA-04)
2. `feat-realized-revenue-ledger` — `revenue-finalization.ts` (run 2c8eb2, F-SEC-01)
3. `feat-connector-backfill` — `shopify-backfill/run.ts` poll loop (THIS run, SEC-BF-H1 / QA-BF-B1)

The existing `pending-stakeholder-attention.md` line for this pattern explicitly said "wait for a 3rd occurrence to auto-trigger." That bar is now crossed. Per the Stage-6 auto-candidate rule I have **written a rule-proposal and appended to pending-stakeholder-attention — I did NOT adopt it** (human runs `/adopt-rule`).

- Rule-proposal: `.engineering-os/rule-proposals/system-job-force-rls-enumeration.md`

---

## Decision

**APPROVE → Stakeholder gate (Stage 7).** 0 blocking. All five load-bearing gates (worker-runs / payoff-proven / PII / isolation / two-lane) independently replicated at source. Over-engineering, hard-rule, and negative-control checks clean. The residual items are tracked debt + one tracked live-validation follow-up — none blocks the slice.

I did NOT commit and did NOT advance the Stakeholder gate. The mechanical staging command is in `.engineering-os/pending-stakeholder-commit.md`.
