# ADR-0016 — Near-real-time serving (incremental + chained + warm transform tier)

- **Status:** Proposed (2026-07-18)
- **Builds on:** ADR-0015 (direct-to-log ingest, Silver-layer identity), the DuckDB-on-Iceberg medallion
- **Deciders:** Owner + platform (principal data architect)
- **Goal:** dashboard freshness from ~15–30 min → **near-real-time (~30–60 s)**, without an architectural reversal.

## Context

The medallion is correct but its *latency* is dominated by fixed overhead, not data volume (a 14-row run takes about as long as a 14M-row run):

1. **Coarse, unchained scheduling** — Silver, identity, and Gold run as *separate* 5-min CronWorkflows, so end-to-end latency stacks to ~15–20 min of pure scheduling wait.
2. **Full-recompute stages** — the identity `map-export` and some Gold marts re-scan/rebuild every run (~20 min), independent of how few rows changed.
3. **Cold start per run** — every tick spins a fresh Argo pod, boots DuckDB, and re-attaches the Iceberg catalog (~1–3 min).
4. **Serving lag** — `duckdb-serving` rotates its catalog epoch every 900 s and the Redis mart cache has its own TTL, so a fresh Gold commit isn't visible for up to ~15 min.

None of these scale with event count, so fixing them helps latency **and** per-tick efficiency at the 40K/sec ramp target (ADR-0015). This is one investment that solves both.

## Decision

Attack the four fixed costs, in three additive phases, reusing machinery that already exists (`SILVER_INCREMENTAL`/`GOLD_INCREMENTAL`, `run_all.py`, `gold.rewritten` invalidation). No reversal of DuckDB-on-Iceberg, batch medallion, or `brand_id`-first isolation.

**D1 — Incrementalize (kill full-recompute).**
- Turn on and validate `GOLD_INCREMENTAL` (already gated, Phase-1b inert).
- Make the identity `map-export` incremental: re-export **only the `brain_id`s the identity job mutated this tick** (it already knows them) instead of rebuilding `silver_identity_map`. `SILVER_INCREMENTAL` is already ON.

**D2 — Chain the stages (kill scheduling stacking).**
- Replace the 3 independent 5-min crons with **one triggered pipeline**: keystone → Silver → identity → `silver_identity_map` → journey-stitch → Gold → serving-refresh, as a single ordered run (an Argo DAG, or the `duckdb-refresh` sequence invoked once). No inter-stage cron wait.

**D3 — Warm resident transform worker (kill cold start).**
- Promote `run_all.py` from a single-shot to a **resident micro-batch worker** (a Deployment holding a warm DuckDB process + attached catalog) that loops the chained pipeline every `TRANSFORM_TICK_MS` (default 30–60 s) over incremental deltas. Warm process = zero per-tick startup cost.

**D4 — Serving freshness (kill epoch lag).**
- Drop `DUCKDB_SERVING_CATALOG_REFRESH_S` to 60 s, and wire the existing **`gold.rewritten` → serving-cache eviction** so the affected `mv_*` marts evict + re-warm the instant Gold commits, rather than waiting for an epoch/TTL.

**D5 — Optional hot tier (only if a tile needs *seconds*).**
- A lightweight resident counter worker consuming the Kafka stream → small incremental aggregates in Redis, powering only the truly-live tiles (revenue/orders/visitors/spend today). Deep analytics (identity, attribution, 360, journeys) stay on the ~1-min batch path. Deferred until a tile actually demands sub-minute.

## Consequences

**Positive**
- ~30–60 s dashboard freshness across the *whole* medallion after D1–D4.
- The same changes make the transform tier efficient at 40K/sec (incremental deltas + warm worker amortize fixed cost over big batches) — solves latency and scale-efficiency together.
- Net code *reduction*: the warm worker (D3) retires the 90-spawn bash orchestrator; incrementality retires full-recompute paths (see cleanup).

**Negative / risks**
- Incremental correctness is the classic DE hazard — an incremental mart must be *provably equivalent* to its full recompute. Mitigated by a parity gate (D1 ships behind a flag, validated by `parity_check.py` against a full run before default-on).
- A resident worker adds a long-running process to operate (health, restart, single-writer lock). Mitigated by reusing the existing leader-lock + `/healthz` patterns.
- Tighter ticks increase Iceberg commit frequency → small-file pressure. Mitigated by the existing compaction/maintenance lane (keep it, just runs more often).

## Principles honored
- **DE:** incremental == full-recompute parity (gated), idempotent replay-safe stages (watermark + MERGE, already the norm), exactly-once via the dedup layers (ADR-0015), bounded per-tick work, observable freshness SLO.
- **SE:** additive + flag-gated + reversible per phase; delete-what-you-replace (no parallel stale paths); one worker reuses existing leader-lock/health idioms; no new datastore, no architectural reversal.
