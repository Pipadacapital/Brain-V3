# ADR-0017 — Identity resolution + map-export folded into the medallion tick

- **Status:** Proposed (2026-07-21)
- **Amends:** ADR-0016 D2 (re-reverses the CORE↔IDENTITY cron split; folds identity into the single triggered pipeline)
- **Reinforces:** ADR-0004 (Neo4j is identity SoR), ADR-0015 (identity is a Silver-stage batch step; R8 no-stream-consumer rule)
- **Deciders:** Owner + platform (principal data architect)
- **Goal:** collapse identity latency from *hours* (batch cron + serving-mediated reads + cold empty exports) to *one medallion tick*, without leaving the batch-Silver-stage posture ADR-0015 established and without touching the R8 / brand-isolation / RTBF invariants.

## Context

Identity is architecturally correct (a batch, watermark-driven Silver stage — ADR-0015) but its *latency* is dominated by fixed scheduling and cold-connection overhead, not by data volume or graph size. The measured 2026-07-21 incident chain:

1. **A 7-day silent stall.** The `silver-identity` watermark (`ops.silver_identity_watermark`) sat unadvanced for seven days with no alarm — the `BrainSilverIdentityStageStalled` absence-alert did not yet exist. Root trigger: `identity-resolve` reads *new keystone rows over duckdb-serving HTTP* (`brain_serving.mv_silver_collector_event`, keyset-paginated, `${BRAND_PREDICATE}` seam) — and the keystone's ~700-day partition floor over a fragmented `silver_collector_event` (1384–1442 data files × ~200 ms/file cold) exceeded the 25 s serving OLTP default, so every slice timed out and the watermark never moved. `SILVER_IDENTITY_QUERY_TIMEOUT_MS` was added as a batch budget to work around exactly this, but the underlying pattern — a batch transform reading its input through the OLTP serving tier — is fragile by construction.

2. **Serving-mediated batch reads.** The identity job is the only transform-tier job that reads its keystone input *through* `duckdb-serving` rather than direct-attaching the Iceberg catalog like every other `db/iceberg/duckdb/**` job. Serving rotates its DuckDB epoch every 60 s (fresh = cold), enforces a `STATEMENT_TIMEOUT_MAX_MS` ceiling (180 s), and is doctrinally single-query/single-node — it is the wrong tier to page a multi-year keystone through.

3. **Cron split → stacked latency.** The CORE↔IDENTITY re-split (2026-07-19) gave identity its own `v4-identity` CronWorkflow (`*/5`, `concurrencyPolicy: Forbid`, `tier=v4-identity`) so the slow resolve would stop blocking the core medallion under `Forbid` (ADR-0016 D2 had chained them; the slow ~2 h/6 h-slice resolve was starving core). The split fixed core-blocking but re-introduced inter-stage scheduling wait and a *second* leader election (PG advisory `910_004` vs core's `910_005`), and left identity's own end-to-end latency untouched: 1 h pinned slices (`SILVER_IDENTITY_MAX_SLICE_MS=3600000`) + per-tick leader acquisition + a 15-min empty `map-export`.

4. **The 15-min-on-empty export (recon root cause).** `map-export` runs **4 sequential cold `python .../silver/$j.py` processes** (`silver_identity_map`, `silver_identity_alias`, `silver_customer_identity`, `silver_identity_unmerge`). Each is a Neo4j→Iceberg projection that *never needs the keystone* — but each calls `run_job(..., source_table=GATED_SOURCE)` with the default `GATED_SOURCE = rest.brain_silver.silver_collector_event` (`_base.py:24`), and `run_job`'s first act is `SELECT max(ingested_at) FROM silver_collector_event` to pin `_CURRENT_HI` (`_base.py:368`). On a **cold** connection against the fragmented keystone that watermark-pin is ~4.5–5 min, and it happens **4×** (one cold process per job) ≈ **15–20 min of pure watermark-pin overhead** even when the identity tables and graph deltas are empty. The actual work — reading ~25k Neo4j nodes and MERGE-ing near-empty targets — is seconds. The job then pointlessly *writes* a keystone watermark for each identity job (`_base.py:374`).

Net: hours of identity latency on tiny data — none of it scaling with events or graph size, all of it fixed scheduling + cold-connection tax. This mirrors ADR-0016's core-medallion finding, but identity was left out of that fix by the subsequent split.

Machinery to reuse already exists: `run_all.py` owns `IDENTITY_OWNED_JOBS` (`run_all.py:114`) and can run the identity tier warm; `SILVER_IDENTITY_CMD` (`run_all.py:102`) already knows how to fork the node resolve job inline on the resident/dev path; `run_all.py TRANSFORM_CORE_ONLY` already excludes the 4 identity marts so `v4-identity` stays the single writer per Iceberg table.

## Decision

Two options are presented. **Option A is recommended and self-contained.** Option B is a larger, later, optional follow-on that Option A does not block.

### Option A (recommended) — Fold identity resolve + export into the medallion tick

Make identity two ordered **passes inside `run_all`'s existing lock and warm connection**, between Silver and Gold — not a separate cron, not a separate leader election, not a serving-mediated read. Neo4j stays the identity SoR (ADR-0004 unchanged).

**A1 — Retire the `v4-identity` CronWorkflow; fold both steps into the one triggered pipeline.**
The chained order becomes `keystone → Silver → identity-resolve → map-export → journey-stitch → Gold → serving-refresh`, all under the single core advisory lock (`910_005`). This re-reverses ADR-0016 D2's split — but the *reason* for the split (a slow resolve blocking core under `Forbid`) is removed by A2–A4, not merely accepted. One lock, one election, one schedule.

**A2 — Identity-resolve reads the keystone by direct-attach (or a pre-staged slice), never through serving.**
The resolve pass reads new canonical rows the same way every other transform job does — direct-attached to the rest-Iceberg catalog — or from a slice the just-finished Silver pass already has warm in the shared connection. This deletes the entire "batch job paging a multi-year keystone through the 60-s-epoch OLTP serving tier" failure mode (incident root cause #1/#2) and makes `SILVER_IDENTITY_QUERY_TIMEOUT_MS` moot. `${BRAND_PREDICATE}` brand isolation is preserved on the direct-attach read exactly as on the serving read.

**A3 — `map-export` skips the keystone watermark-pin.**
The 4 Neo4j-projection jobs run with a **cheap `source_table`** (or a `run_job` no-watermark variant) so they never `SELECT max(ingested_at)` off the fragmented keystone and never write a meaningless keystone watermark. This alone removes ~15–20 min/tick of pure overhead on empty/near-empty graph deltas. This is a mechanical `_base.py`/call-site change with no semantic effect on the projections.

**A4 — Run all four projections on ONE warm connection.**
`run_all.py` already owns `IDENTITY_OWNED_JOBS`; run them warm in-process instead of as 4 cold `python` spawns. The per-process cold-attach cost (the other half of the 15-min export) disappears. `v4-identity` as SOLE writer of the 4 marts is preserved because the fold runs them inside the same single-writer lock — no second writer is introduced.

**A5 — Keep the watermark + zero-error advance + absence alert.**
`computeWatermarkWindow`, per-brand leader-locked passes, consent-failure-holds-watermark, zero-error-only advance to the slice ceiling, and `silver_identity_runs_total` (feeding `BrainSilverIdentityStageStalled`) are unchanged. With A2 the slice can widen (or the `MAX_SLICE_MS` pin relax) because the read is no longer serving-timeout-bound.

**Kill switch / rollback for A:** `IDENTITY_IN_TICK` (default OFF at ship; flip ON after a parity + latency bake). OFF = the current `v4-identity` cron path, untouched, is the exact fallback — pure git-revert-free rollback via one env flip.

### Option B (optional, later) — Option A **plus** retire Neo4j into a PG/Iceberg-resident identity graph

Everything in Option A, then relocate the identity SoR off Neo4j into the stores the platform already operates (PG `ops` for the mutable graph + Iceberg marts for the projected reads). This is a **separate, larger decision** (it would amend ADR-0004) and is presented for honest comparison, not recommended now.

**What the graph actually is today (small).** ~25k nodes / ~17k rels for 2 brands: `Customer{brand_id,brain_id,lifecycle_state,merged_into,first_identified_at}`, `Identifier{brand_id,type,hash}` (64-hex hash only, never raw PII), `MergeEvent`/`MergeReview`/`UnmergeEvent`/`SharedUtility`; rels `IDENTIFIES{tier,is_active,confidence,verdict}` and `ALIAS_OF{merge_id,valid_from,valid_to}` (a live alias chain walked `*1..50` to the canonical brain_id). Brand isolation is application-layer Cypher params (no RLS).

**What changes:**
- **Store.** Two PG tables in `ops` — `identity_customer` and `identity_identifier` (unique `(brand_id, type, hash)`), plus an `identity_edge` table carrying the `IDENTIFIES` + bi-temporal `ALIAS_OF` rows (`merge_id, valid_from, valid_to`). Brand isolation becomes **RLS + `brand_id`-first PKs** — strictly stronger than today's app-layer-params posture. `merge`/`unmerge`/`merge-review` become PG transactions.
- **The alias chain.** The `*1..50` canonical-resolution walk (Neo4j's one genuinely graph-shaped operation) becomes a bounded **recursive CTE** over `identity_edge` — well within Postgres at this scale, and the depth cap already exists in the domain logic.
- **The bridge.** `map-export`'s 4 Neo4j→Iceberg projections collapse: `silver_identity_map`/`alias`/`customer_identity`/`unmerge` project directly from the PG identity tables (or become plain Iceberg marts the resolve pass writes), removing the Neo4j read entirely. Downstream is unaffected — Gold (`gold_customer_360`, `gold_revenue_ledger`, `gold_journey_events`, `…_reversion`) and serving (`mv_silver_identity_map`, `identity_current_v`, `identity_asof`, `semantic_customer`) already read `silver_identity_map` only, **never** Neo4j.
- **`Neo4jIdentityRepository` → `PgIdentityRepository`.** The resolver/matchers/`ConfidenceEngine` are store-agnostic (they were built behind a repository port for exactly ADR-0003→0004); swap the adapter, keep the domain.

**What the erasure orchestrator needs.** RTBF (`EraseSubjectUseCase`, the compliance-critical fail-closed lane) today does a Neo4j graph purge (step 2b: tombstone `IDENTIFIES` edges, mark erased) + `readState()` brain_id lookup + identifier-cache purge keyed by graph hashes. Under B this becomes a **PG transaction** (tombstone/delete the `identity_edge` + `identity_identifier` rows, in the same DB as `ops.erasure_request_queue` — so the whole erase step can be *one transaction*, strictly safer than the current cross-store PG-queue↔Neo4j-graph two-phase). Fail-closed semantics (throw → retry/backoff → dead@MAX PG DLQ) are preserved; the identifier-cache purge is unchanged (still keyed by hash).

**What splink / a probabilistic future requires.** Deterministic matching (today's tier) is trivially PG (equality joins on `identifier_hash`). A probabilistic/`splink` future wants *blocking + pairwise scoring over candidate sets* — that is a **columnar set-operation**, which DuckDB-on-Iceberg is *better* at than a property graph: splink itself runs on DuckDB. So B's PG+Iceberg store is not a regression for the probabilistic roadmap — it is the more natural substrate. The one thing Neo4j gives "for free" that B must implement is the transitive alias-chain walk (the recursive CTE above) — cheap at this scale, re-evaluated only if a single brand's chain depth or fan-out explodes.

**Honest costs, both ways, at current scale:**
- *Keeping Neo4j (A only):* one more datastore to operate (backup, upgrade, the `NEO4J_URI` fail-closed coupling in resolve + RTBF), a genuinely graph-shaped alias walk stays a one-liner, and a cross-store RTBF two-phase (PG queue + Neo4j graph) that is already fail-closed but is two stores. At 25k nodes Neo4j is *massively* underutilized — it earns its keep only if the graph gets large/deep or probabilistic merge fan-out becomes graph-shaped.
- *Retiring Neo4j (B):* one fewer datastore, RTBF collapses to a single-DB transaction, brand isolation upgrades to RLS, and the probabilistic roadmap lands on the more natural (columnar) substrate — at the cost of a migration (dual-write bake → parity → cutover → decommission), re-homing the admin mutation surface (`apps/core .../neo4j-identity-reader.ts` merge-review/unmerge/erase), and owning the alias-walk CTE. At 2 brands / 25k nodes the migration is small; the risk is entirely in the cutover discipline, not the data size.

**Migration sketch (B, if ever chosen):**
1. Create the `ops.identity_*` tables + RLS (a pgmigration). Inert.
2. Dual-write: the resolve pass writes both Neo4j and PG behind `IDENTITY_STORE=neo4j|pg|both` (default `neo4j`). Bake `both`.
3. Parity gate: PG-projected `silver_identity_map` vs Neo4j-projected, byte-for-byte on `(brand_id, brain_id, alias interval)` — reuse the ADR-0016 parity-gate idiom.
4. Flip readers/RTBF/admin to `pg`; bake.
5. Decommission Neo4j (compose service, helm, `NEO4J_URI`, the R8 repository, `neo4j-identity-reader` Neo4j paths) — amends ADR-0004, records the R8 rule as satisfied-by-absence.

## Consequences

**Positive (Option A)**
- Identity latency collapses from hours to one tick: no cron stacking, no second leader election, no serving-timeout fragility, no 15-min empty export.
- Deletes the one batch-job-reads-through-serving anti-pattern in the transform tier (the literal cause of the 7-day silent stall).
- Net simplification: one CronWorkflow retired (`v4-identity`), 4 cold `python` spawns → warm in-process passes, `SILVER_IDENTITY_QUERY_TIMEOUT_MS` retired.
- Reuses existing machinery (`run_all.py` `IDENTITY_OWNED_JOBS` / `SILVER_IDENTITY_CMD` / `TRANSFORM_CORE_ONLY`); no new datastore, no architectural reversal.

**Negative / risks (Option A)**
- Re-reversing ADR-0016 D2 (the CORE↔IDENTITY split) re-couples identity into the core tick — the very coupling the 2026-07-19 split undid. Mitigated because the split's actual cause (slow resolve blocking core under `Forbid`) is *removed* by A2–A4, not accepted: post-fold a clean tick is minutes, not the old ~2 h. The identity tier keeps its own Prometheus label so a slow resolve is still attributable, and the `IDENTITY_IN_TICK=OFF` flip restores the split instantly if the fold ever starves core again.
- Folding into core means an identity fault can fail the tick. Mitigated by keeping identity's per-brand, `continueOn`-style isolation (a bad brand holds only its own watermark) inside the pass, and by the kill switch.
- Widened slices (A5) increase per-tick resolve work — bounded by `computeWatermarkWindow`'s `maxCatchup`/`maxSlice`, tunable.

**Additional consequences (Option B, if chosen)**
- One fewer datastore, single-DB RTBF, RLS brand isolation, probabilistic-ready substrate — vs a supervised migration and owning the alias-walk CTE + re-homed admin mutations. Net-positive at scale; not worth the cutover risk *purely* for 25k nodes today — hence deferred.

## What stays true (invariants preserved under both options)
- **R8 (no stream-tier identity coupling).** Identity stays a batch transform-tier step; no stream-worker Kafka consumer imports Neo4j (or, under B, the PG identity repo). `jobs/silver-identity` remains the one sanctioned resolve invocation path — now forked inline by `run_all` under the core lock, not by a separate cron. The stream-worker runs no Kafka consumers.
- **Brand isolation.** `brand_id`-first on every identity row/edge; `${BRAND_PREDICATE}` on the resolve keystone read (A2); RLS + `brand_id` PKs under B (strictly stronger than today's app-layer params).
- **RTBF.** Erasure stays PG-request-driven (`ops.erasure_request_queue`) and fail-closed (throw → retry/backoff → dead@MAX DLQ). Untouched by A; *strengthened* by B (collapses to a single-DB transaction).
- **Identity SoR.** Neo4j remains SoR under A (ADR-0004 honored). Only B relocates it — and only via an explicit ADR-0004 amendment after a parity-gated migration.
- **Single-writer-per-Iceberg-table.** The 4 identity marts keep exactly one writer (the folded passes run inside the single core lock; `TRANSFORM_CORE_ONLY` still excludes them from any other lane).
- **Money / serving doctrine.** No money-path change. Serving still reads `mv_*` / `silver_identity_map`; A *removes* serving from the identity write path (it was only ever a read there), so no serving contract changes.

## Rollout plan (Option A)
1. Ship A behind `IDENTITY_IN_TICK` (default **OFF**). The `v4-identity` cron path is untouched and is the exact fallback.
2. Land A3 (skip keystone watermark-pin in the 4 projections) first — it is a safe, isolated `_base.py`/call-site win that helps *even the current cron path*, and is independently revertible.
3. Bake A2 (direct-attach resolve read) in staging; verify the watermark advances and `BrainSilverIdentityStageStalled` stays green with no `SILVER_IDENTITY_QUERY_TIMEOUT_MS` reliance.
4. Flip `IDENTITY_IN_TICK=ON` in staging; measure end-to-end tick latency and identity freshness; confirm core-tick p95 does not regress.
5. Promote to prod via the release→master flow; retire the `v4-identity` CronWorkflow only after a prod bake (leave it disabled-but-present for one release as a rollback anchor before deletion).

## Principles honored
- **DE:** bounded per-tick work, watermark-driven idempotent replay-safe passes (unchanged), zero-error-only advance, observable freshness (the absence alert stays), parity-gated before any default-on (and before any B cutover).
- **SE:** additive + flag-gated + reversible (one env flip); delete-what-you-replace (retire the cron, the 4 cold spawns, the serving-mediated read, the timeout knob — no parallel stale path); reuse existing lock/health/`run_all` idioms; no new datastore under the recommended option; Neo4j retirement is a separate, explicit, parity-gated decision, never a silent side effect.
