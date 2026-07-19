# Design Review 005 — Customer-Scoring Merge

**Status:** APPROVED 2026-07-19 (owner: "finish all") — EXECUTED on this branch
**Scope:** fold `gold_customer_health` + `gold_customer_scores` into `gold_customer_360`; retire the two marts
**Companion:** `docs/data-inventory-2026-07-19.md` · DR-001…004

## 1. Problem — and a dependency inversion the docket missed

Three per-customer scoring marts existed. The docket assumed 360 "already carried" health_band/churn_score so the other two could fold in. Verification showed the **inverse dependency**: 360 *derived* those columns by reading the other two marts — and because `gold_customer_360` sorts before them in the gold glob, it read **last tick's** health/scores every tick. The flagship customer record's health_band and churn_score were structurally one tick stale (the same staleness class DR-004 found in identity).

## 2. Solution executed

- The health derivation (order-spine recency/frequency facts + deterministic score/band) and the RFM/churn scoring (pure per-row CASE ladders off the `silver_customer` spine) were **inlined verbatim** into `gold_customer_360.py` — formulas byte-copied from the retired jobs; the vendored `churn_score_from_risk` / `lifecycle_stage` UDFs unchanged.
- `gold_customer_360` widened additively (9 nullable columns: recency_days, frequency, health_score, last_order_at, days_since_last_order, recency/frequency/monetary_score, churn_risk) — `ensure_table` schema evolution, data-preserving.
- `mv_gold_customer_health` / `mv_gold_customer_scores` became **projections of the 360** with the exact prior reader contracts (health keeps the old grain via `WHERE last_order_at IS NOT NULL`; scores derives scored_on/computed_at from the 360 write clock, data_source='live' — the only value the retired mart ever emitted). All readers (insights briefing, ML platform, serving-freshness probe) untouched.
- `semantic_customer` repointed: RFM columns now read off the 360; the scores join removed.
- Deleted: `gold_customer_health.py`, `gold_customer_scores.py`, both marts (catalog, non-purge), 2 parity-harness entries. `ScopedRecompute` keys retained (they map to the still-live view cache entries) with a DR-005 note.

## 3. Risks & rollback
Reader contracts preserved view-for-view (bind-verified against the live catalog); formulas verbatim so values are identical-or-fresher (the only change is staleness removal). Rollback: git revert + rerun the reverted jobs (marts rebuild from Silver deterministically; non-purge drops recoverable until snapshot expiry).

## 4. Validation (executed, live stack)
Gold tier green with the consolidated 360; all repointed views + `semantic_customer` bind against the widened schema; catalog drops 200 ×2; post-drop silver+gold re-run green with **no mart recreated**; naming guard passed. Dev parity is vacuous (0-row customer spine locally) — flagged for prod bake-watch on first tick: `mv_gold_customer_scores` values should equal the retired mart's last output modulo the removed one-tick lag.

## 5. Outcome
One customer scoring surface, computed once, fresh every tick — three marts that could disagree about the same customer are now one that can't. Gold: −2 tables, −2 jobs/tick. Monitoring: existing tick metrics + the two views' freshness probe (unchanged reader).
