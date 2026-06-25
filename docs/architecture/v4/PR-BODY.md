## Brain V4 — the official architecture, implemented

Migrates Brain to the V4 architecture end-to-end, parity-gated and committed phase-by-phase for review:

**Sources → Collector/Connector → Redpanda → Iceberg Bronze → Spark (validate/dedup/enrich/normalize) → Iceberg Silver → Spark Gold → Iceberg Gold → StarRocks `mv_*` (serving) → Redis → Features/AI/Decision/Dashboards.**

Spark is the **sole compute**; dbt is **removed**; Gold lives in **Iceberg**; StarRocks is **serving-only** (`mv_*`); PostgreSQL is **operational-only**; Neo4j owns identity; the ML inference log + identity/journey export tables live in an operational `brain_ops` StarRocks DB.

### Phases (one or more commits each)
- **P0** — Iceberg Silver/Gold foundations + parity harness (IaC: Terraform S3/Glue + local MinIO).
- **P1 / P1b** — Spark Silver dual-run: 16 canonical entities + 13 category/pixel coverage-gap tables → **29 Silver tables** covering every connector category + the full pixel taxonomy.
- **P2** — Spark Gold → Iceberg: **23 marts** — 13 byte/minor-unit **parity-exact** vs dbt+TS (revenue recognition, CM2, CAC, executive metrics, attribution apportionment) + 10 net-new GAP products. Drops `feature_customer_daily` (features are runtime).
- **P3** — StarRocks `mv_*` serving over Iceberg Gold: 23 MVs, each serving **exact** vs source.
- **P4 (BREAKING)** — read-seam cutover: every app/worker read repointed to `brain_serving.mv_*` (30 MVs), `${BRAND_PREDICATE}` tenant sentinel preserved.
- **P5 (BREAKING)** — Decision/AI runtime over `mv_*`; PG confirmed operational-only; ML log relocated off `brain_gold`.
- **P6 (BREAKING)** — dbt fully removed (tree, CI, refresh loop); natives relocated to `brain_ops`; legacy TS attribution-writer retired; the dbt-internal `brain_gold`/`brain_silver` StarRocks DBs removed; Spark jobs read Iceberg only.
- **P7** — hardening (full pipeline ordering, retry, Argo crons), observability (structured per-job logging + serving-freshness surface), a naming-lint CI guard, and `docs/architecture/v4/parity-report.md`.

### Parity
All Silver byte/minor-unit exact (3 live-timing flags, `missing_in_new=0`); all 13 Gold-group marts exact; 30 `mv_*` exact vs Iceberg. Money is per-currency bigint minor units, never blended. See `docs/architecture/v4/parity-report.md`.

### Interleaved app fixes/UX (same branch)
- **Charts: Invalid Date + duplicate React keys fixed** — V4 typed-DATE columns surfaced a latent `String(date).split('T')` bug; timeseries now emit `YYYY-MM-DD` strings; trend-chart filters to primary currency.
- **Orders + Order Status merged** into one tabbed, redesigned page (old route redirects).
- **Custom date-range filter + table search** primitives wired across record pages.

### ⚠️ Operator action required (blocked by the live-SQL safety guard)
Run once against StarRocks: `db/starrocks/analytics_grants.sql` — grants the read-only `brain_analytics` user SELECT on `brain_serving` + `brain_ops` (was stale on the removed dbt DBs). Until applied, the serving-freshness surface and the attribution journey-stitch read return `no_data`. After it runs, re-run `pnpm dev:v4-refresh` and attribution credit flows end-to-end.

### Open data-state notes (not regressions)
Attribution credit / customer rollups populate once identity-export + journey-stitch run on real data; logistics/settlement marts fill as those connectors sync.

Typecheck green throughout (63/63). dbt entirely gone; the compute+serving inversion is corrected.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
