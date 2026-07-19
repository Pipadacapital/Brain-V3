# Design Review 004 — Identity Projections & the Stitch Seam

**Status:** APPROVED 2026-07-19 (owner: "go all") — EXECUTED with a Part-1 correction (below)

> **Execution correction — Part 1 was largely SUPERSEDED upstream.** Verification against post-#279 `release` found the CORE↔IDENTITY re-split (2026-07-19 freshness incident, `templates/v4-identity.yaml` + `TRANSFORM_CORE_ONLY`): prod already runs a dedicated v4-identity lane as the SOLE writer of all four identity marts, projecting them back-to-back POST-resolution — the exact consistency/single-lane goal of this review, delivered at the orchestration level. Executing the planned file-merge on top of freshly-landed incident machinery would have been churn, so it was NOT done. What remained real and was executed: the DEV shim did not mirror the new prod chain (it re-projected only the map in its identity stage and ran the other three in the CORE silver glob — the exact one-stage-stale split prod eliminated). The shim now runs CORE-ONLY silver + all four projections in the identity stage, prod-parity. The four job files stay as the lane's units (the v4-identity template loops them deliberately, per-job continue-on-error).
**Author:** Data Platform Architect session, 2026-07-19
**Scope:** the Neo4j→Iceberg identity projection lanes; the `connector_journey_stitch_map` vs `ops.silver_journey_stitch` duplication flagged in DR-001
**Companion:** `docs/data-inventory-2026-07-19.md` · DR-001 (#278) · DR-002 (#279) · DR-003 (#282)

---

## Part 1 — Identity projections: four lanes, one graph, split freshness

### 1. Problem

Four separate Python jobs each open their own Neo4j session and project the same identity graph into Iceberg:

| Job | Table | Runs in | Consumed by |
|---|---|---|---|
| `silver_identity_map.py` | `silver_identity_map` (bi-temporal) | **identity stage** (after the node resolver — "so gold reads THIS run's resolutions") | customer_360, journey_events, revenue_ledger, serving `identity_asof`/`identity_current_v` |
| `silver_identity_alias.py` | `silver_identity_alias` | **silver tier** (before the resolver) | gold_revenue_ledger, snap_identity_link, silver_customer, silver_order_state |
| `silver_customer_identity.py` | `silver_customer_identity` | **silver tier** (before) | gold_revenue_ledger, silver_customer, silver_order_state |
| `silver_identity_unmerge.py` | `silver_identity_unmerge` | **silver tier** (before) | gold_journey_events_reversion |

Two structural findings (verified in the tick chain — `tools/dev/duckdb-refresh.sh` / `run_all.py resident` / the v4-medallion workflow all sequence silver → node-identity → map-reprojection → gold):

1. **Split freshness inside a single tick.** The map is re-projected *after* this tick's identity resolutions; alias/customer_identity/unmerge were projected *before* them. Gold therefore reads a fresh map next to one-tick-stale sibling projections of the same graph in the same run. Any gold logic joining both (revenue_ledger does) reconciles two different snapshots of identity truth.
2. **Four independent export lanes** = four Cypher queries, four driver sessions, four env/error surfaces, and four chances to drift — the drift class DR-001 §R11 flagged.

The DR-001 sketch (derive alias/customer_identity as views over the map) **does not survive contact with the schemas**: `lifecycle_state`, `merged_into`, `minted_at` (customer_identity) and `tier`, `is_active` (alias) are not carried by the bi-temporal map. View-derivation would require widening the map — schema surgery on the platform's most load-bearing identity table. Rejected.

### 2. Recommended solution — one projection job, one stage

Consolidate the four jobs into **one** `silver_identity_projection.py` that runs in the **identity stage** (immediately after the node resolver, where the map re-projection already runs): one Neo4j driver session executes the four existing Cyphers back-to-back and writes the four tables unchanged (same schemas, same MERGE discipline, the map keeps its bi-temporal append + dirty-set logic verbatim).

- **Should the four tables exist?** Yes — each carries columns the others don't and each has live consumers. What should NOT exist is four lanes and two freshness classes.
- **Who owns it?** Identity domain; Neo4j stays the sole SoR (ADR-0004); everything Iceberg-side remains projection.
- **Engines:** unchanged. R8 untouched (these are transform-tier jobs; `jobs/silver-identity` remains the one sanctioned node path).
- **Deleted:** 3 job files + 3 tick invocations + 3 Neo4j sessions/tick. **Tables: zero change. Consumers: zero change.**
- **Gained:** all four projections captured back-to-back on one session *after* resolution — gold reads one consistent identity snapshot; one env/error surface; the silver glob tier no longer touches Neo4j at all (cleaner tier boundary: silver = events, identity stage = graph).

Honest limit: back-to-back reads on one session are *near*-consistent, not a true graph snapshot — but strictly better than today's cross-stage split, and the resolver is quiescent between ticks (single-writer advisory lock), so in practice the window is empty.

### 3. Trade-offs / Alternatives
- **Do nothing:** keeps the freshness split gold currently reconciles silently. Rejected.
- **View-derivation over a widened map:** touches the most critical identity schema for cosmetic lane-count. Rejected (above).
- **Merely reorder the three jobs into the identity stage, keep 4 files:** captures most of the freshness win, none of the lane consolidation; run_all's silver glob would still need the same exclusion machinery as the merge. Same plumbing cost, less benefit. Rejected.

### 4. Risks

| Risk | Mitigation |
|---|---|
| Chain touchpoints ×3 (dev shim, `run_all.py resident`, v4-medallion/transformWorker helm) must all move the invocations | One consolidated job replaces the existing map-reprojection call-site — the chain files change one line each; all three verified in-repo |
| Consolidated job failure now blocks all four projections | Same posture as today's map failure (identity stage is continue-on-error in the shim); per-table try/except inside the job preserves partial progress |
| Silver-tier consumers (order_state, customer) now read *last tick's post-resolution* projections instead of *this tick's pre-resolution* ones | These are equivalent states of the graph (pre-resolution(t) ≡ post-resolution(t−1)); no semantic change, and gold — where the money is — gets strictly fresher |
| Parity regression in the port | Per-table row parity gate: old jobs vs consolidated job against the same dev graph before the old files are deleted |

### 5. Validation
1. Parity: run old 4 jobs → snapshot counts/hashes per table → run consolidated job on the same graph → identical.
2. Full refresh chain green (dev shim all stages); revenue_ledger/customer_360 outputs byte-identical on dev data.
3. Naming guard; unit tests for the job's pure logic (dirty-set filter tests move with the map code).

### 6. Rollback
Git revert (job files + 3 one-line chain edits). No schema, no data, no migration.

---

## Part 2 — Journey-stitch "duplication": verdict KEEP (it's the isolation seam, not a copy-paste)

### 1. What the evidence shows

`journey-stitch-export` copies 5 columns from `connectors.connector_journey_stitch_map` → `ops.silver_journey_stitch`. That looked REDUNDANT in DR-001. It is not:

- `connector_journey_stitch_map` is **FORCE RLS** (brand-GUC scoped). The export reads it per-brand under the GUC, precisely because a cross-brand read silently returns 0 rows — a failure mode this exact lane already hit once (the job's own header records it).
- The transform tier (DuckDB PG-attach: `silver_touchpoint.py`, `silver_session_identity.py`) is a **cross-brand** reader. The prod transform PG user has no `BYPASSRLS`; pointing it at the FORCE-RLS table would re-create the silent-zero bug at the heart of the journey pipeline.
- The `ops` schema **is** the sanctioned non-RLS transform read zone (0116). The copy is the boundary between the RLS zone (operational app tables) and the transform zone — the same seam every `ops.silver_*` export uses.

**Rubric answers:** Should both exist? Yes — they are different security domains, not duplicate facts. Could one engine/table own it? Only by punching a `USING (true)` policy or `BYPASSRLS` hole through tenant isolation for the transform role — trading a small table for a standing cross-brand read grant on an RLS table. Isolation wins; the charter's "preserve tenant isolation" outranks "fewer tables." Can it be deleted/merged? No. Simplified? Marginally (the TRUNCATE+reload could become watermark-incremental) — deferred until row volume makes it measurable.

### 2. Actions (small, documentation-grade)
1. Reclassify in the inventory ledger: `ops.silver_journey_stitch` REDUNDANT-suspect → **ACTIVE (isolation seam)**; same note added to both file headers so the next audit doesn't re-flag it.
2. Reaffirm the DR-001 verdict on the PG identity exports (`ops.silver_customer_identity`, `ops.silver_identity_link`): same seam pattern, live operational readers (capi-source, stitch-from-identity, backfill-identity) — KEEP, unchanged by Part 1 (which touches only the Iceberg projections).

---

## Approval items
- **Part 1** — consolidate the four Iceberg identity projections into one identity-stage job (no table/schema changes).
- **Part 2** — accept KEEP verdict + ledger/doc reclassification (no code behavior change).
