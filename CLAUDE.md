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
- Compute is DuckDB-on-Iceberg: DuckDB is the sole TRANSFORM compute (Silver/Gold), run as `python db/iceberg/duckdb/{silver,gold}/*.py`. Bronze maintenance/retention/erasure (RTBF) is the PyIceberg maintenance client under `db/iceberg/duckdb/maintenance/**` (COW delete/overwrite + snapshot expiry with a physical-file sweep; the erasure lane never issues DuckDB MoR DELETEs — gated by `maintenance_capability_probe.py`). The Spark transform tree (`db/iceberg/spark/**`) is DELETED (Spark→DuckDB cutover, PR #148) — never reintroduce `spark-submit` or a `db/iceberg/spark` path without a new ADR. Bronze LANDING is the Kafka Connect Iceberg sink (ADR-0010, cutover executed 2026-07-05): the compose `kafka-connect` service / `infra/helm/kafka-connect` chart lands the collector lane → `brain_bronze.collector_events_connect` (serving lift view `collector_events_connect_lifted` for operational readers) and the 9 raw lanes → `brain_bronze.<lane>_raw_connect` (auto-created on first record). Bronze stays append-fast at write time and converges to zero-duplicate via compaction-time dedup on `(brand_id, event_id)` (keep-latest, `db/iceberg/duckdb/maintenance/bronze_dedup.py`, ADR-0015); Silver `MERGE` on `(brand_id, event_id)` remains the backstop. NEVER reintroduce a streaming Bronze sink without a new ADR. dbt is REMOVED — never invoke `dbt`; StarRocks is REMOVED; Trino is REMOVED (ADR-0014) — never reintroduce any of them without a new ADR. The dbt-internal DBs `brain_gold` / `brain_silver` are RETIRED (dropped).
- Ingest is direct-to-log (ADR-0015): the collector produces straight to the Kafka log with an idempotent producer (`acks=all`, key = `brand_id`) — the produce-ack is the durability anchor — backed by a bounded local-disk fallback for log-unreachable windows. The Postgres spool (`collector_spool` + drainer/reaper + the PG ingest-dedup gate) is DELETED — never reintroduce a DB spool on the ingest path without a new ADR. Kill switch: `INGEST_DIRECT_TO_LOG` (default ON).
- Identity is resolved in the SILVER transform stage (ADR-0015): a batch, watermark-driven job (`apps/stream-worker/src/jobs/silver-identity/run.ts`, reusing the preserved `IdentityResolver`/matchers/`Neo4jIdentityRepository`, fronted by an `identifier_hash → brain_id` cache) runs between the Silver passes and Gold in `tools/dev/duckdb-refresh.sh` and writes `silver_identity_map`. Neo4j is NEVER wired to the collector, the log, or Bronze — no stream-worker Kafka consumer may import the Neo4j identity repository / the identity-bridge (guard rule R8; `jobs/silver-identity` is the one sanctioned invocation path). Kill switch: `IDENTITY_IN_SILVER` (default ON). RTBF erasure is likewise PG request-driven batch (ADR-0015 WS4 completion): core's ErasureEventPublisher enqueues the trigger into `ops.erasure_request_queue` (0140) and the stream-worker poll lane (`apps/stream-worker/src/jobs/erasure-orchestrator/run.ts`) drains it through the unchanged EraseSubjectUseCase sequence (per-brand ordered, retry-with-backoff, dead-at-MAX = the PG DLQ). The stream-worker runs NO Kafka consumers — never reintroduce one (incl. any `.dlq` topic) without a new ADR.
- The medallion is Iceberg: Bronze/Silver/Gold live in the external Iceberg catalogs `brain_{bronze,silver,gold}_local` (rest catalog + MinIO/S3). Iceberg is the system of record.
- Serving is duckdb-serving fronted by a Redis analytics cache: a stateless HTTP service (`db/iceberg/duckdb/serving/`, FastAPI, `POST /v1/query` on :8091) holding DuckDB attached READ-ONLY to the Iceberg REST catalog; the app/BFF/metric-engine read ONLY the views `brain_serving.mv_*` (local views the service applies at startup — thin projections over the Iceberg Gold/Silver marts, gated by `/readyz`) — never StarRocks, never Trino, never a bare `brain_gold.`/`brain_silver.` DB. Single-query ceiling is doctrine: one query runs on one node; heavy compute belongs in the transform tier — serving reads pre-baked marts. DuckDB transform/maintenance jobs may read the rest-Iceberg catalogs directly.
- Operational state is PostgreSQL — the `ops` schema (former `brain_ops`; `brain_ops`-on-StarRocks is GONE): identity/journey export, ML inference log, stitch shim, isolation-fuzz fixture. PG is operational-only.
- Features are RUNTIME — there is NO permanent feature-precompute table (no `feature_customer_daily`, no `brain_feature`; the latter is dead, torn down). Fold features from the Silver spine at run time.
- Money is bigint minor units + a sibling `currency_code` (never blended, never a float). Tenant isolation is `brand_id`-first on every row/event/key, plus the `${BRAND_PREDICATE}` seam — which injects the brand predicate (`brand_id = ?`) into every serving read (engine-agnostic; unchanged by the Trino removal).
- Refresh the medallion with `tools/dev/duckdb-refresh.sh` (DuckDB Silver→Gold in dependency order against the live Iceberg catalog; the Spark→DuckDB cutover orchestrator). The transform jobs are `db/iceberg/duckdb/{silver,gold}/*.py`; maintenance is `db/iceberg/duckdb/maintenance/**`; serving views are `db/iceberg/duckdb/views/*.sql`.
- These naming/architecture invariants are CI-enforced by `tools/lint/v4-naming-guard.sh` (blocking gate in `.github/workflows/pr.yml`): it forbids retired-DB refs (R1/R4), any dbt invocation (R2), feature precompute (R3), NEW StarRocks coupling in serving app code (R5: mysql2 / `:9030` / `STARROCKS_*`), NEW Spark coupling (R6: `spark-submit` / `db/iceberg/spark`), and NEW Trino coupling (R7: `trinodb/trino` / `TRINO_*` / `createTrinoPool`-family identifiers / `db/trino` + `db/iceberg/trino` paths / `/opt/brain/trino` / `trino:8080`|`trino…:8090` host forms — never a bare `:8090`, that's the stream-worker metrics port), and stream-tier identity coupling (R8: no stream-worker Kafka consumer path may import `Neo4jIdentityRepository` / the identity-bridge — identity is a Silver-stage batch step per ADR-0015; `jobs/silver-identity` is the allowlisted invocation path), while ALLOWING the duckdb-serving client (`createDuckDbServingPool` / `withServingBrand`) and the DuckDB transform/maintenance tier.

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