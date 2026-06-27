# StarRocks → Trino + PostgreSQL migration plan

**Directive:** fully remove StarRocks. Serving → Trino-over-Iceberg + Redis cache. Operational state (`brain_ops`) → PostgreSQL. Branch `feat/trino-replaces-starrocks`.

## Footprint (from recon)
- **Serving (Cat A):** 49 metric-engine files read `brain_serving.mv_*` via `withSilverBrand`/`srPool` (mysql2→StarRocks:9030). 35 `db/starrocks/mv/*.sql` (23 gold + 7 silver + 3 snap). `srPool` built in `apps/core/src/main.ts`.
- **Operational (Cat B):** 7 `brain_ops` tables written by jobs (identity-export, journey-stitch-export, ML prediction-log via srPool, `ScopedRecomputeRepository`). Read by Spark Silver/Gold (`silver_order_state.py`, `silver_touchpoint.py`, `gold_revenue_ledger.py`, `snap_identity_link.py`) for brain_id/stitch resolution, and by app (`capi-source.query.ts`, ml module).
- **Config/infra (Cat C):** `STARROCKS_*` in `packages/config/src/{core,stream-worker}.ts`; `srPool`/`srOpsPool` mysql2 pools; `db/starrocks/{bootstrap,external_iceberg_catalog,row_policy_template}.sql`, `ops/run_ops.sh`, `mv/run_mvs.sh`; `docker-compose` `starrocks`+`starrocks-init` services. Trino already built (`trino-deps.ts withTrinoBrand`, `trino-adapter.ts`, `analytics-cache.ts`, `db/trino/catalog/iceberg.properties`, compose `trino` lakehouse-profile).
- **Guards/CI/docs (Cat D):** `v4-naming-guard.sh` R1/R4 (require `mv_*`, forbid bare gold/silver) + R5 (forbid Trino on serving) — INVERT. `integration.yml`/`parity-oracle.yml` spin up StarRocks. `CLAUDE.md` Data-platform section names StarRocks serving + brain_ops StarRocks-native.

## Cutover strategy (low-risk: minimal caller churn)
**Serving seam:** back `withSilverBrand` with the **Trino** path (predicate-injection isolation, no StarRocks session var, honest-empty preserved); `SilverPool`→Trino-pool-compatible. The 49 callers' SQL is UNCHANGED because we expose **`brain_serving.mv_*` as Trino VIEWS over Iceberg Gold/Silver** (Trino default catalog set so 2-part `brain_serving.mv_x` resolves). `apps/core/src/main.ts` swaps the StarRocks mysql2 pool → `createTrinoPool`. Redis `analytics-cache` fronts hot reads via `getOrSet`. `${BRAND_PREDICATE}` isolation seam preserved (already mirrored in `withTrinoBrand`).
**Operational state:** new PG migrations recreate the 7 `brain_ops` tables (brand_id-first, RLS); repoint TS writers/readers to PG pools; Spark jobs read the PG tables via JDBC (same pattern as the per-brand salt read). brain_ops StarRocks DB retired.

## Waves
- **A — Serving → Trino:** Trino `brain_serving.mv_*` views over Iceberg; rewrite `silver-deps.ts` seam to Trino; `createTrinoPool` in core main.ts + BffDeps; Redis cache in the read path. Verify metric-engine tsc + tests + isolation-fuzz.
- **B — Operational state → PostgreSQL:** PG migrations for the 7 tables; repoint identity-export / journey-stitch-export / ML-log / ScopedRecomputeRepository / capi-source / ml-reads; Spark jobs read PG via JDBC. Verify stream-worker/core tsc + tests + py_compile.
- **C — Infra/config teardown:** remove `starrocks`+`starrocks-init` compose; Trino into the default profile + serving wiring; `STARROCKS_*`→`TRINO_*`+PG config; retire mv runners/bootstrap/ops DDL; teardown SQL.
- **D — Guards/CI/docs:** invert `v4-naming-guard` (forbid StarRocks/`mv_*`/`brain_serving` on app serving, allow Trino serving; drop R5); `integration.yml`/`parity-oracle.yml` StarRocks→Trino; update `CLAUDE.md`; isolation-fuzz Silver-seam test → Trino.
