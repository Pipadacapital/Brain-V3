# Near-real-time serving — Implementation Plan (ADR-0016)

Target: dashboard freshness ~15–30 min → **~30–60 s**, low complexity, no architectural reversal, and a **net reduction** in code (delete-what-we-replace). Ships in phases; each is flag-gated, parity-verified, and independently reversible.

Guiding rule (DE): **every incremental path must be provably equal to its full-recompute output before it becomes the default.** `parity_check.py` is the gate, not a formality.

---

## Phase 1 — Incrementalize (days) → ~3–5 min freshness, ~80% of the win

### PR 1.1 — Validate + default-on `GOLD_INCREMENTAL`
- **Files:** `db/iceberg/duckdb/_base.py` (flag already defined), the Gold jobs using `incremental_window()`; `infra/helm/cronworkflows/values*.yaml` (env).
- **Do:** run a full Gold pass and an incremental pass on the same Bronze snapshot; assert byte-identical money + row parity via `db/iceberg/duckdb/parity_check.py` (harness exists). Only then flip `GOLD_INCREMENTAL=1` in prod values.
- **Gate:** money byte-exact, no orphan drift (the `gold_revenue_ledger` orphan-shed path stays).

### PR 1.2 — Incremental `map-export` (the single biggest win: ~20 min → seconds)
- **File:** `db/iceberg/duckdb/silver/silver_identity_map.py` (already bi-temporal MERGE, append-per-mutation).
- **Do:** scope its read to the **`brain_id`s mutated this tick** rather than the full identity source. The Silver identity job (`apps/stream-worker/src/jobs/silver-identity/run.ts`) already produces the changed-`brain_id` set (it writes `ops.*_pending` dirty rows) — pass that dirty-set as the map-export's input filter (env/param `IDENTITY_DIRTY_ONLY`, default on; `FULL_REFRESH=1` still forces a full rebuild for recovery).
- **Gate:** parity vs a full map rebuild over the same window; the bi-temporal validity columns unchanged (AMD-07 invariant).

### PR 1.3 — Serving freshness on commit
- **Files:** `db/iceberg/duckdb/serving/` (refresh cadence), the `gold.rewritten` producer (`apps/stream-worker/.../gold-rewritten-publish` — already converted to direct Redis eviction in ADR-0015), `packages/metric-engine/src/serving-cache.ts`.
- **Do:** set `DUCKDB_SERVING_CATALOG_REFRESH_S=60`; ensure the post-Gold cache-bust evicts **only the affected brand+mart keys** (already brand-scoped) and re-warms lazily on next read. Serving already sees new Iceberg commits on re-query — this removes the epoch/TTL lag.
- **Gate:** a Gold commit is visible in `mv_*` within ≤ 60 s.

**End of Phase 1:** ~3–5 min freshness, purely from incrementality + serving-refresh. Mostly config + one focused job change.

---

## Phase 2 — Chain + warm worker (~1–2 weeks) → ~30–60 s freshness

### PR 2.1 — Chain the stages into one ordered run
- **Files:** `tools/dev/duckdb-refresh.sh` (already the keystone→silver→identity→gold sequence), `infra/helm/cronworkflows/templates/v4-transform.yaml`.
- **Do:** collapse the separate `v4-identity` / `v4-gold` crons into **one chained pipeline** (Argo DAG or the single `duckdb-refresh` invocation) that runs stages back-to-back with no inter-stage cron wait. One schedule, sequential, dirty-set-driven.
- **Gate:** end-to-end run of a small delta completes < 60 s warm.

### PR 2.2 — Resident warm transform worker
- **File:** `db/iceberg/duckdb/run_all.py` (today a single-shot single-process runner, gated by `sparkV4.singleProcess`) → extend to a **resident loop**: hold one warm DuckDB connection + attached catalog, run the chained pipeline every `TRANSFORM_TICK_MS` (default 45 s) over incremental deltas, exit-on-signal.
- **Infra:** new `infra/helm/transform-worker/` Deployment (mirror the stream-worker chart: leader-lock via the existing `LeaderLock` pattern so only one writer runs, `/healthz`, resource requests, IRSA SA). Replaces the per-tick CronWorkflow pods.
- **Gate:** 24 h soak; warm-tick p95 < 60 s; leader-lock prevents double-writers; parity vs the bash orchestrator holds.

**End of Phase 2:** whole-medallion near-real-time (~1 min), including identity + attribution.

---

## Phase 3 — Optional hot tier (deferred; only if a tile needs *seconds*)
- A small resident counter worker consuming the Kafka collector lane → incremental aggregates in Redis for the few "today" tiles (revenue/orders/visitors/spend). Batch path unchanged for deep analytics. **Do not build until a specific tile demands sub-minute** (YAGNI).

---

## Cleanup — delete what we replace (no stale code)

Ship these *with* the phase that supersedes them, so no parallel dead paths linger:

| Remove | When | Why dead |
|---|---|---|
| The 90-spawn **bash orchestrator loop** in `tools/dev/duckdb-refresh.sh` (keep a thin dev shim) | after PR 2.2 warm worker validated | replaced by the resident single-process worker |
| `sparkV4.singleProcess` **feature flag** + the dual-path branch | after PR 2.2 default-on | single-process becomes the only path |
| Full-recompute branches guarded by `if not INCREMENTAL` in Gold jobs | after PR 1.1 default-on (keep `FULL_REFRESH` recovery) | superseded by incremental + `FULL_REFRESH` covers recovery |
| **9 raw-lane Connect sinks** (`infra/kafka-connect/iceberg-bronze-{meta-spend,google-spend,ga4-rows,shopify-orders,woocommerce-orders,shopflo-checkout,shiprocket-shipments,gokwik-events,razorpay-settlement}.json`) + their topics | this program (independent) | verified dead 2026-07-18 — connectors emit canonical events to the collector lane; raw lanes never receive data |
| `db/iceberg/duckdb/silver/silver_ad_spend_normalize.py` (shadow normalize reading the empty raw lanes) | with the raw-lane removal | redundant — `silver_marketing_spend`/`silver_keyword_spend` read `spend.live.v1` from the keystone directly |
| Retired `collector.event.v1.dlq` / `.quarantine` KafkaTopic CRs still in prod | this program | ADR-0015 retired them; quarantine is `silver_quarantine`, DLQ is the erasure PG lane |
| Stale `v4-silver`-named artifacts / dead cron templates once chained | after PR 2.1 | the separate-stage crons are replaced by the chained pipeline |

Every removal is grep-verified for zero live importers first, and gated by `knip` + `v4-naming-guard`.

---

## Testing & rollout discipline

- **Parity is the gate for every incremental change** (`parity_check.py`): incremental output == full recompute, money byte-exact. A non-parity delta blocks the flag flip.
- **Freshness SLO + alert:** add a `medallion_freshness_seconds` gauge (max(now − serving max ingested_at)) + alert > 5 min; this is the objective proof of the improvement and the guardrail against regressions.
- **Flag-gated + reversible:** `GOLD_INCREMENTAL`, `IDENTITY_DIRTY_ONLY`, `TRANSFORM_TICK_MS`, warm-worker `enabled` — each a kill switch back to the prior path.
- **Ships via** `feature/* → release → master`; the promotion PR runs the full suite; owner-gated to master (unchanged flow).

## Effort & sequencing
- Phase 1 ≈ **1 week** (config + incremental map-export + serving wiring + parity) → ~3–5 min, biggest perceived win.
- Phase 2 ≈ **1–2 weeks** (chain + warm worker + soak + cleanup) → ~30–60 s.
- Phase 3 deferred.
- Critical path: PR 1.2 (incremental map-export) → PR 2.1 (chain) → PR 2.2 (warm worker). Cleanup rides each superseding PR.

## Interlock with the 40K/sec ramp (ADR-0015)
Incremental deltas + the warm worker are *also* the transform-tier efficiency story for the ramp — one investment, both problems. This plan should land **before** the ramp crosses ~10K/sec, where per-run cold-start + full-recompute would otherwise blow the 5-min window.
