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
- Compute is Spark-on-Iceberg, and Spark is the sole TRANSFORM compute (Silver/Gold + Bronze maintenance/retention/erasure). Bronze LANDING is the Kafka Connect Iceberg sink (ADR-0010, cutover executed 2026-07-05): the compose `kafka-connect` service / `infra/helm/kafka-connect` chart lands the collector lane → `brain_bronze.collector_events_connect` (Trino lift view `collector_events_connect_lifted` for operational readers) and the 9 raw lanes → `brain_bronze.<lane>_raw_connect` (auto-created on first record). Bronze is append-only; dedup lives in Silver. NEVER reintroduce a Spark streaming Bronze sink without a new ADR. dbt is REMOVED — never invoke `dbt`; StarRocks is also REMOVED (serving moved to Trino). The dbt-internal DBs `brain_gold` / `brain_silver` are RETIRED (dropped: `db/starrocks/teardown/drop_dbt_internal_dbs.sql`).
- The medallion is Iceberg: Bronze/Silver/Gold live in the external Iceberg catalogs `brain_{bronze,silver,gold}_local` (rest catalog + MinIO/S3). Iceberg is the system of record.
- Serving is Trino-over-Iceberg fronted by a Redis analytics cache: the app/BFF/metric-engine read ONLY the Trino views `brain_serving.mv_*` (which resolve to `iceberg.brain_serving.*` — thin projections over the Iceberg Gold/Silver marts) — never StarRocks, never a bare `brain_gold.`/`brain_silver.` DB. Spark jobs may read the rest-Iceberg catalogs directly.
- Operational state is PostgreSQL — the `ops` schema (former `brain_ops`; `brain_ops`-on-StarRocks is GONE): identity/journey export, ML inference log, stitch shim, isolation-fuzz fixture. PG is operational-only.
- Features are RUNTIME — there is NO permanent feature-precompute table (no `feature_customer_daily`, no `brain_feature`; the latter is dead, torn down via `db/starrocks/teardown/drop_dead_feature_db.sql`). Fold features from the Silver spine at run time.
- Money is bigint minor units + a sibling `currency_code` (never blended, never a float). Tenant isolation is `brand_id`-first on every row/event/key, plus the `${BRAND_PREDICATE}` seam — which now injects the brand predicate (`brand_id = ?`) into every Trino serving read.
- Refresh the medallion with `tools/dev/v4-refresh-loop.sh` (Spark Silver→Gold→mv SYNC refresh). The Spark jobs are `db/iceberg/spark/{silver,gold}/*.py` + their run scripts.
- These naming/architecture invariants are CI-enforced by `tools/lint/v4-naming-guard.sh` (blocking gate in `.github/workflows/pr.yml`): it forbids retired-DB refs, any dbt invocation, feature precompute, and NEW StarRocks coupling in serving app code (mysql2 / `:9030` / `STARROCKS_*`), while ALLOWING Trino serving over the iceberg catalog (`iceberg.brain_{gold,silver,serving}.*`).

## Branching & deploys (RELEASE-LAYER, 2026-07-11)
- Feature branches → PR → **`release`** (the default branch). NEVER open or merge a PR to `master`.
- NO CI runs on feature branches or feature→release merges (owner decision). ALL checks (pr/integration/infra/knip) run once, on the **release → master promotion PR**.
- ONLY the repo owner merges `release` → `master`. `master` = production: that merge runs the full `deploy.yml` chain (build images → staging values bump → prod values promote), fires the infra TF lane, and ArgoCD prod apps track `master`.

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