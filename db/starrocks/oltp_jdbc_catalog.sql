-- ============================================================================
-- StarRocks External JDBC Catalog over Postgres — brain_oltp_pg
-- feat-silver-tier-order-state (Stage 3, @data-engineer). Tier-0 deterministic.
-- ============================================================================
-- WHAT: A read-only JDBC external catalog that lets StarRocks (and therefore dbt,
--       which runs against StarRocks) SELECT the canonical order/commerce truth that
--       lives in Postgres — primarily `public.realized_revenue_ledger` (0018 + 0030).
--       The Silver `silver.order_state` mart is built by dbt from cross-catalog reads
--       of this catalog into a native `brain_silver` PRIMARY KEY table.
--
-- WHY this mechanism (architecture §1): smallest + most reversible dev bridge.
--   * Native StarRocks 3.x feature (PostgreSQL JDBC supported since v3.0).
--   * Zero new deployable, zero sync job, zero new topic (I-E05).
--   * dbt reads LIVE Postgres truth directly → replay = re-run dbt (nothing to drift).
--   * Reversible: `DROP CATALOG brain_oltp_pg;` removes the entire read path cleanly.
--
-- ── DEV BOUNDARY (stated honestly — do NOT fake "Silver is live") ────────────
--   1. RLS BYPASS: this catalog connects to Postgres as the configured `user`. In dev
--      that user is `brain` (superuser), which BYPASSES Postgres RLS
--      (MEMORY: dev-db-superuser-masks-rls). Therefore the JDBC-sourced STAGING read is
--      cross-brand BY CONSTRUCTION — dbt builds Silver for ALL brands. This is CORRECT
--      and intended: dbt is the ETL writer (exactly like the stream-worker writes the
--      ledger cross-brand under a privileged role). Per-brand isolation is NOT enforced
--      at the dbt/staging layer; it is enforced at the Silver READ path (the metric-engine
--      seam, I-ST01 sole reader). See tools/isolation-fuzz/src/silver-order-state.test.ts.
--
--   2. JDBC DRIVER JAR: StarRocks downloads the Postgres JDBC driver from `driver_url`
--      (Maven) on first catalog use. If the dev box has no outbound network, mount the
--      jar locally and point `driver_url` at a `file:///` path instead. Verified in this
--      environment: brainv3-starrocks-1 reaches repo1.maven.org (HTTP 200).
--
--   3. HOST: brainv3-postgres-1 is reachable from brainv3-starrocks-1 on the shared
--      docker network `brainv3_default` at host `postgres:5432`, db `brain` (verified).
--
-- ── PROD SWAP (documented intent, NOT this slice) ───────────────────────────
--   In prod the staging `source()` swaps from this JDBC catalog to the Iceberg Bronze
--   catalog (brain_bronze_prod, Glue+S3) once the Phase-3 Iceberg Bronze flip lands —
--   with NO mart/intermediate change (the boundary is isolated in models/staging/_sources.yml).
--   This is the ADR-002 one-way Iceberg → dbt → StarRocks → Analytics API end state; the
--   JDBC catalog is the M1 dev/transition mechanism.
--
-- IDEMPOTENT: CREATE EXTERNAL CATALOG IF NOT EXISTS — safe to re-run.
-- ============================================================================

CREATE EXTERNAL CATALOG IF NOT EXISTS brain_oltp_pg
COMMENT "Dev JDBC catalog over Postgres OLTP — canonical order/commerce truth (realized_revenue_ledger). Connects as superuser brain (RLS-bypass, ETL-writer posture). Prod swaps to Iceberg Bronze catalog."
PROPERTIES (
  "type"        = "jdbc",
  "user"        = "brain",
  "password"    = "brain",
  "jdbc_uri"    = "jdbc:postgresql://postgres:5432/brain",
  "driver_url"  = "https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.4/postgresql-42.7.4.jar",
  "driver_class"= "org.postgresql.Driver"
);
