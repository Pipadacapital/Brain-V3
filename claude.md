# Brain

Brain is an AI-native commerce OS.

## Product purpose
Capture Truth -> Build Trust -> Enable Decisions

## Product sequence
Registration -> Verification -> Organization -> Brand -> Region -> Team -> Shopify -> Pixel -> Verification -> Initial Sync -> Health -> Progressive Unlock -> Centers -> Recommendations -> Outcomes -> Learning

## Core rules
- Data foundation comes before dashboards.
- No empty charts as a success state.
- No event loss.
- Bronze is source of truth.
- Journey before attribution.
- Deterministic first.
- Revenue truth over platform truth.
- Confidence before decisions.

## Data platform (Brain V4 — OFFICIAL)
- Compute is Spark-on-Iceberg, and Spark is the SOLE compute. dbt is REMOVED — never invoke `dbt`, and the dbt-internal StarRocks DBs `brain_gold` / `brain_silver` are RETIRED (dropped: `db/starrocks/teardown/drop_dbt_internal_dbs.sql`).
- The medallion is Iceberg: Bronze/Silver/Gold live in the external Iceberg catalogs `brain_{bronze,silver,gold}_local` (rest catalog + MinIO/S3). Iceberg is the system of record.
- Serving is StarRocks async materialized views: the app/BFF/metric-engine read ONLY `brain_serving.mv_*` (over Iceberg) — never a bare `brain_gold.`/`brain_silver.` DB. Spark jobs may read the rest-Iceberg catalogs directly.
- `brain_ops` holds StarRocks-native operational state (identity/journey export, ML inference log, stitch shim, isolation-fuzz fixture). PG is operational-only.
- Features are RUNTIME — there is NO permanent feature-precompute table (no `feature_customer_daily`, no `brain_feature`; the latter is dead, torn down via `db/starrocks/teardown/drop_dead_feature_db.sql`). Fold features from the Silver spine at run time.
- Money is bigint minor units + a sibling `currency_code` (never blended, never a float). Tenant isolation is `brand_id`-first on every row/event/key, plus the StarRocks `${BRAND_PREDICATE}` seam.
- Refresh the medallion with `tools/dev/v4-refresh-loop.sh` (Spark Silver→Gold→mv SYNC refresh). The Spark jobs are `db/iceberg/spark/{silver,gold}/*.py` + their run scripts.
- These naming/architecture invariants are CI-enforced by `tools/lint/v4-naming-guard.sh` (blocking gate in `.github/workflows/pr.yml`): it fails on retired-DB refs, any dbt invocation, feature precompute, and non-`mv_*`/non-Iceberg Gold/Silver reads.

## Operating standards
- Prefer small, reversible, auditable changes.
- Treat integrations as unreliable.
- Preserve tenant isolation.
- Support replay, backfill, deduplication, and retries.
- Respect regional residency and privacy.
- Add tests for any behavior change.
- Verify with logs, metrics, or reproducible evidence.

## Product areas
- Auth and account setup
- Organization and brand management
- RBAC
- Pixel and browser tracking
- Connector ecosystem
- Identity resolution
- Journey reconstruction
- Revenue truth
- Attribution
- Conversion feedback
- Data quality
- Decision intelligence

## Review checklist
- Is the architecture aligned with Brain’s purpose?
- Does the database support the flow without unnecessary redesign?
- Does the UI build trust before insight?
- Does the system fail safely?
- Can data be replayed and audited?
- Are confidence and freshness measurable?