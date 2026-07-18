--
-- 0138_silver_identity_watermark.sql — ADR-0015 WS3: identity resolves in the Silver stage.
--
-- The Silver identity batch job (apps/stream-worker/src/jobs/silver-identity/run.ts) replaces the
-- streaming IdentityBridgeConsumer: it reads NEW canonical Silver rows since a per-brand watermark
-- (over duckdb-serving), resolves them via the existing BatchResolveIdentityUseCase → Neo4j, and
-- writes the merge/suppress dirty-sets directly. This table is the PG-ops home of that watermark —
-- the operational-state analogue of the transform tier's Iceberg silver_job_watermark side-table.
--
-- Cross-brand trusted-ETL table (like ops.restitch_pending / ops.scoped_recompute_request): the
-- worker runs as brain_app with NO brand GUC, so NOT RLS-forced; isolation is the explicit
-- brand_id in the PK. No money, no PII.
--
BEGIN;

CREATE TABLE IF NOT EXISTS ops.silver_identity_watermark (
    job_name   text NOT NULL,
    brand_id   uuid NOT NULL,
    watermark  timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT silver_identity_watermark_pkey PRIMARY KEY (job_name, brand_id)
);

GRANT SELECT, INSERT, UPDATE ON TABLE ops.silver_identity_watermark TO brain_app;

COMMIT;
