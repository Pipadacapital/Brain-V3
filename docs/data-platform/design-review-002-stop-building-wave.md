# Design Review 002 — Stop-Building Wave

**Status:** APPROVED 2026-07-19 (owner: "go all" — Groups 1–4 + D1–D3) — EXECUTED on this branch; prod catalog steps in §7 remain post-promotion

> **Execution correction:** `gold_measurement_refunds` / `gold_measurement_settlements` were NOT strictly consumer-less — the §C.5.1 metrics-lineage endpoint (live in analytics routes + web) audited their row counts. Resolution: lineage's `refunds`/`settlements` fact descriptors were remapped to the canonical populated Silver facts (`silver_refund`, `silver_settlement`) the marts merely re-projected — the audit now counts real sources of truth instead of empty gold copies — and the marts were then deleted as planned. Functionality preserved and improved.
**Author:** Data Platform Architect session, 2026-07-19
**Scope:** transform jobs materializing tables no consumer reads — up to 16 jobs / 19 Iceberg tables
**Companion:** `docs/data-inventory-2026-07-19.md` (ledger) · DR-001 (merged, PR #278)

---

## 1. Problem

The transform tier spends every tick materializing tables that nothing reads. DR-001 removed their serving views; the jobs and tables underneath still run and commit on every tick — snapshot churn, maintenance/compaction surface, RTBF sweep surface, and wall-clock, all for zero consumers. The capture path is unaffected: connectors keep landing every event in Bronze, so all of this is **deferral of materialization, not loss of truth** — any table here is one replayed job away when a real consumer ships.

### Objects in scope, classified (all re-verified against post-#278 `release`, 2026-07-19)

**Group 1 — write-only Silver (7 jobs, 7 tables) → DELETE CANDIDATE**

| Table | Rows (dev) | Reference check |
|---|---|---|
| silver_product | 0 | 1 app hit = comment in get-product-categories.ts ("neither gold_product_detail nor silver_product carries category") |
| silver_product_variant | 0 | comment-only hits (silver_inventory_level docstring, woo-mapper docstring) |
| silver_coupon | 0 | zero non-writer references |
| silver_dispute | 0 | zero |
| silver_search | 0 | zero |
| silver_message_send | 0 | zero |
| silver_ad_account | 0 | zero |

**Group 2 — consumer-less measurement marts (3 jobs, 3 tables) → DELETE CANDIDATE**
`gold_measurement_refunds`, `gold_measurement_settlements`, `gold_measurement_inventory` — cross-references in sibling jobs are comments only ("matches the established pattern"). **Explicitly kept:** `gold_measurement_costs` and `gold_measurement_fees` — verified direct inputs to `gold_order_economics` (CM chain); `_fees` reads `silver_settlement` directly, which keeps `silver_settlement` ACTIVE.

**Group 3 — spend breakdown grains (2 jobs, 5 tables) → DELETE CANDIDATE**
`silver_marketing_spend_breakdowns.py` (one job writing all 4 `silver_marketing_spend_by_{demographic,geo,hour,placement}`) + `silver_keyword_spend.py`. Views died in DR-001; zero remaining readers. The base `silver_marketing_spend` fact (5 gold consumers) is untouched.

**Group 4 — fold `silver_shipment_event` into `silver_shipment` (−1 job, −1 table) → SIMPLIFY**
Its only reader is `silver_shipment.py` itself (the metric-engine hit is a docstring; queries go to `mv_silver_shipment`). Fold the transition derivation into the shipment job as an intermediate relation. *Caveat: keep it instead if you want a durable per-transition audit ledger — but Bronze already retains every raw shipment webhook, so the ledger is replayable; materializing it twice is not the audit story.*

**Cascade + extended candidates discovered during verification (evidence-backed, decision-gated):**

| # | Object | Finding | Recommendation |
|---|---|---|---|
| D1 | `silver_inventory_level` (+ job) | Its ONLY consumer is `gold_measurement_inventory` (Group 2). Approving Group 2 makes it write-only. | Cascade-delete with Group 2 |
| D2 | `gold_settlement_summary` (+ job) | INTERNAL, no view, zero readers (only parity_check mapping + a sibling comment) | Delete |
| D3 | `gold_logistics_performance` (+ job) | INTERNAL, no view, zero readers (delivery_time hit is a comment) | Delete |

## 2. Analysis

- Every Group 1–3 table is 0 rows in dev and reader-less in code — they were built speculatively during the connector-depth and Wave-C programs and no consumer ever shipped.
- **Compliance angle (in favor of deletion):** `silver_message_send` carries `recipient_hash` and `silver_search` carries session identifiers, yet **neither appears in any RTBF erasure lane** (grep across maintenance/ and stream-worker erasure paths: zero hits). Today they are subject-data tables outside the erasure surface — a latent compliance gap that deletion closes outright.
- The `measurement.inventory_movement` platform flag (Wave C, spec C.2.6) exists only as a registry entry; no code checks it. It goes with Group 2/D1.
- `parity_check.py` carries mappings for `gold_measurement_settlements`, `gold_measurement_inventory`, `gold_settlement_summary`, `gold_logistics_performance` — harness entries to trim at execution.
- Wall-clock: ~16 fewer job invocations per tick on top of DR-001's ~22; each removed job also removes per-tick Iceberg commits (snapshot churn scales with commit count, and maintenance cost scales with snapshot churn).

## 3. Trade-offs

| Option | Gain | Cost |
|---|---|---|
| Delete jobs + tables (recommended) | −16 jobs/tick, −19 tables of snapshot/compaction/sweep surface; smaller wedge surface; compliance gap closed | Re-shipping a surface later costs one job revert + one `FULL_REFRESH=1`-style replay from Bronze |
| Keep building | Zero change risk | The largest recurring dead cost in the transform tier persists, growing with event volume forever |
| Disable via flag, keep code | Reversible without git | Dead code + dead flags are the debt this program exists to remove; flags for nothing measurable |

The asymmetry is decisive: keep-cost recurs on every tick for years; recreate-cost is paid once, only if a consumer ever ships, and is fully deterministic (Bronze → Silver → Gold replay).

## 4. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A product surface ships next quarter needing one of these | Plausible (product/coupon analytics are roadmap-shaped) | One-time replay to rebuild; days of data NOT lost (Bronze retains all events) | Documented replay recipe per table in §8; git history preserves every job verbatim |
| Hidden reader outside repo | Very low (serving views already deleted in DR-001 — a week of zero fallout) | Query error, one-file view + job revert | Post-DR-001 serving logs show no failed lookups |
| Stale-image tick recreates dropped tables | Medium during rollout | Empty orphan tables | Same DR-001 discipline: images first, catalog drops after, post-check |
| Group 4 fold changes silver_shipment output | Low | Shipment state drift | Fold is read-path-internal; validate `silver_shipment` row/byte parity before vs after on dev data |
| D1–D3 judged too aggressively | — | Same replay guarantee | Each is individually gated; reject any without affecting the groups |

## 5. Alternatives considered

1. **Wire them instead** — rejected for now: wiring 19 tables to surfaces nobody asked for is inventing product to justify plumbing. DR-006 (wire-or-kill) handles the two marts with genuine product pull (cod_rto, engagement).
2. **Keep Silver, delete only Gold** — rejected: a Silver table with no Gold consumer and no view is exactly as dead as a Gold mart with no reader.
3. **Archive tables to cold storage before drop** — rejected: they are 0 rows in dev and deterministically rebuildable in prod; archiving nothing is ceremony.

## 6. Recommended solution

Approve per group: **Group 1** (7 write-only Silver), **Group 2** (3 measurement marts), **Group 3** (spend grains), **Group 4** (shipment_event fold), **D1** (inventory cascade), **D2**, **D3**. Execution mirrors DR-001: one branch, staged commits, PR → release; catalog drops per environment AFTER image rollout.

## 7. Implementation

**Repo deletions:** `silver/{silver_product,silver_product_variant,silver_coupon,silver_dispute,silver_search,silver_message_send,silver_ad_account,silver_marketing_spend_breakdowns,silver_keyword_spend}.py`; `gold/{gold_measurement_refunds,gold_measurement_settlements,gold_measurement_inventory}.py`; D1: `silver/silver_inventory_level.py`; D2/D3: `gold/{gold_settlement_summary,gold_logistics_performance}.py`; Group 4: delete `silver/silver_shipment_event.py`, fold its derivation into `silver_shipment.py` as an internal relation (parity-checked).
**Reference trims:** parity_check.py mappings (4 entries), platform-flags `measurement.inventory_movement` registry entry, stale docstring mentions.
**Catalog drops (runbook, per env, post-rollout):** the 19 tables via REST `DELETE /v1/namespaces/{ns}/tables/{t}?purgeRequested=false` (non-purge; dev tables are 0 rows, prod rebuildable).
**No PG migration in this wave.**

## 8. Validation steps

1. `run_all silver` + `gold` green from current dev volumes; failure count 0.
2. `silver_shipment` parity: row count + content hash identical before/after the Group 4 fold on the same input.
3. Repo grep: zero non-comment references to every deleted identifier; naming guard green; touched unit tests green.
4. Tick wall-clock before/after recorded (this wave should show a measurable drop).
5. App smoke: orders, revenue, journey, logistics (delivery-time card) unchanged.

**Replay recipe (the rollback-forward path):** revert the job file → run once with `FULL_REFRESH=1` → table rebuilds from Silver/Bronze history → recreate view if serving is wanted. Deterministic; no event was ever lost.

## 9. Rollback strategy

Git revert per commit (groups are separate commits). Catalog: non-purge drops leave metadata recoverable via `register_table` until snapshot expiry; after expiry, the replay recipe rebuilds from Bronze — which is the durable guarantee this platform is built on.

## 10. Monitoring requirements

- Transform tick duration + per-tier failure counts, one week before/after (existing metrics).
- Iceberg commit rate per tick (expect −16); maintenance sweep duration (fewer tables).
- Serving: no change expected (these had no views since DR-001) — absence of new errors is the check.

## 11. Future scalability

This is the wave with compounding returns: per-tick cost scales with job count × event volume, so every deleted job is a permanent slope change, not a one-time saving. It also sets the precedent the charter needs — *materialization follows consumers*, never the other way. When product ships a coupon/product/messaging surface, the replay recipe turns "we deleted it" into a one-day rebuild with a real consumer attached.
