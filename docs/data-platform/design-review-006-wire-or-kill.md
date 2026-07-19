# Design Review 006 — Wire-or-Kill: cod_rto & engagement

**Status:** APPROVED 2026-07-19 (owner: "finish all"; wire/kill split per owner's earlier call) — EXECUTED on this branch
**Scope:** the two marts computing truth nobody saw — `gold_cod_rto` (wired) and `gold_engagement` (killed)
**Companion:** `docs/data-inventory-2026-07-19.md` · DR-001…005

## 1. gold_cod_rto — WIRED (product surface shipped)

**Why wire:** COD/RTO is core India-commerce truth (charter: revenue truth, confidence before decisions); the mart had live data and a full silver chain (`silver_cod_rto`) — only a reader was missing.

**What shipped** (sibling-pattern-faithful, no new tables/views/indexes):
- `packages/metric-engine/src/cod-rto.ts` — sole reader of `brain_serving.mv_gold_cod_rto` via the brand seam; bigint-safe money, bps as integers, **NULL passthrough** (the mart emits NULL rate/accuracy when resolved=0 / evaluated=0 — verified against live data; the UI never fabricates 0%).
- Core query `get-cod-rto.ts` + contract schemas (`MinorUnitsSchema` coercion convention) + **route `GET /api/v1/analytics/cod-rto`** (session brand, Redis-cached like siblings).
- Web: "CoD outcomes & prediction accuracy" section on the existing CoD/RTO surface — CoD orders/value, RTO rate, delivered-vs-RTO split, prediction accuracy shown **only when predictions were actually evaluated**; honest insufficient-data states otherwise ("no empty charts as a success state," in both directions).
- Tests: 5-case unit suite for the metric module (empty/full/NULL-bps/coercion/ordering). Verified: contracts, metric-engine (431 tests), core, web typechecks + 130 contract tests green.

## 2. gold_engagement — KILLED (with its cascade)

**Why kill:** zero readers, and the behavior surface it duplicated (page-type mix, funnel) is served by `gold_behavior`/`gold_funnel`. Replayable from Bronze the day an engagement surface is actually designed.

Deleted: `gold_engagement.py` + `mv_gold_engagement.sql` + **cascade `silver_engagement_signal.py`** (its only consumer was gold_engagement — verified zero other references) + both tables (catalog, non-purge) + the parity-harness entry. The raw rage/dead-click/scroll events keep landing in Bronze via the collector — capture is unaffected; only materialization stops (DR-002 doctrine: materialization follows consumers).

## 3. Validation (executed, live stack)
Silver + gold tiers green post-deletion, no table recreated; naming guard passed; cod-rto endpoint stack typechecked + unit-tested; live serving query returned the mart's real rows (2) with correct NULL semantics.

## 4. Rollback
Wire: git revert (pure addition). Kill: git revert + `FULL_REFRESH` replay from Bronze (the standard recipe).

## 5. Prod runbook (rides the next promotion, with DR-005's)
Images first, then catalog drops: `gold_customer_health`, `gold_customer_scores` (DR-005), `gold_engagement`, `silver_engagement_signal` (DR-006). Then one bake-watch tick: 360 scoring columns populated, cod-rto card renders with live data.
