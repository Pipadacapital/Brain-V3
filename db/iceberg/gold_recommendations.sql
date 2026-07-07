-- SPEC: G (AMD-21)
-- ============================================================
-- Gold `gold_recommendations` table DDL — Apache Iceberg (brain_gold_local catalog).
-- SCAFFOLD ONLY (Wave G, PART 6 §G). This file is the schema-of-record for the NET-NEW
-- gold_recommendations serving mart. NO writer, NO Spark build job, NO scoring, and NO
-- refresh-loop wiring ship with this scaffold — all models/scoring are DEFERRED (§G).
-- The table is created empty; the first row is only ever written once Wave G models land.
--
-- Mirrors the shared Gold DDL contract (db/iceberg/spark/iceberg_base.py::create_iceberg_table):
-- format-v2, zstd parquet, upsert disabled (append-only-on-no-match MERGE), brand_id-first
-- tenant partitioning. Run via spark-sql / Iceberg REST (local) or Glue (prod).
--
-- EXPLAINABILITY IS SCHEMA-ENFORCED (§G "explainability schema-enforced, not a UI afterthought"):
--   evidence, model_version, business_rules_applied, score, and confidence are all NOT NULL —
--   no recommendation row can ever be written without the features+values it used, the rules
--   applied, its model provenance, AND its confidence ("Confidence before decisions"). This is
--   enforced at write time by the table schema, not by any downstream reader.
-- ============================================================

CREATE NAMESPACE IF NOT EXISTS brain_gold;

CREATE TABLE IF NOT EXISTS brain_gold.gold_recommendations (
  -- ── Tenant (FIRST — §0.5/§1 brand_id-first invariant; partition bucket source; RLS anchor) ──
  brand_id               STRING     NOT NULL COMMENT 'UUID — tenant key. Partition bucket source. Brand-isolation anchor.',

  -- ── Identity / idempotency ──
  recommendation_id      STRING     NOT NULL COMMENT 'Stable per-recommendation id — idempotency key: (brand_id, recommendation_id). Additive to the §G field list (needed for MERGE grain); documented in CONTRACT-G.',

  -- ── Subject: the entity this recommendation is ABOUT ──
  subject_type           STRING     NOT NULL COMMENT 'Entity kind the rec targets: customer | product | campaign. Enum enforced in the (deferred) writer — Iceberg has no CHECK.',
  subject_id             STRING     NOT NULL COMMENT 'Id of the subject within subject_type (brain_id / product_id / campaign_id).',

  -- ── Recommendation kind + body ──
  rec_type               STRING     NOT NULL COMMENT 'Recommendation class: product | campaign | nba (next-best-action). Enum enforced in the (deferred) writer — Iceberg has no CHECK.',
  payload                STRING     NOT NULL COMMENT 'JSON-encoded recommendation body (the actual suggestion). No raw PII (I-S02).',

  -- ── Model outputs (DEFERRED — no scoring ships in the scaffold; columns defined so no row is ever written without them) ──
  score                  DOUBLE     NOT NULL COMMENT 'Model relevance/ranking score. NOT NULL — a scoreless recommendation is never persisted. Produced by the DEFERRED Wave G model.',
  confidence             DOUBLE     NOT NULL COMMENT 'Model confidence [0,1]. NOT NULL — "Confidence before decisions". Produced by the DEFERRED Wave G model.',

  -- ── Explainability (SCHEMA-ENFORCED §G — NOT NULL, not a UI afterthought) ──
  evidence               STRING     NOT NULL COMMENT 'JSON: the feature NAMES + VALUES used to produce this recommendation (as-of feature vector). Schema-enforced explainability.',
  model_version          STRING     NOT NULL COMMENT 'Version of the model/pipeline that produced this row — provenance for reproducibility + audit.',
  business_rules_applied STRING     NOT NULL COMMENT 'JSON: the business rules/guardrails applied (e.g. confidence-gate, eligibility, suppression). Schema-enforced explainability.',

  -- ── Validity window ──
  generated_at           TIMESTAMP  NOT NULL COMMENT 'UTC generation time. Partition days() source. Recency + freshness anchor.',
  expires_at             TIMESTAMP           COMMENT 'UTC expiry (nullable — a recommendation without a TTL never expires). After this, the rec must not be served.'
)
USING iceberg
PARTITIONED BY (
  bucket(16, brand_id),
  days(generated_at)
)
TBLPROPERTIES (
  'format-version'                   = '2',
  'write.format.default'             = 'parquet',
  'write.parquet.compression-codec'  = 'zstd',
  -- Append-only-on-no-match, exactly like the other Gold marts: idempotent MERGE WHEN NOT MATCHED,
  -- never an in-place upsert fast-path. An update issues an explicit MERGE ... WHEN MATCHED.
  'write.upsert.enabled'             = 'false',
  'write.target-file-size-bytes'     = '134217728',

  -- Object-storage per-brand prefix layout
  'write.object-storage.enabled'     = 'true',

  -- Brain layer annotations (informational)
  'brain.layer'                      = 'gold',
  'brain.schema.evolution'           = 'additive-optional-only'
);

-- ============================================================
-- NOT a feature-precompute table (v4-naming-guard): this is a SERVING mart of finished
-- recommendations, not a permanent per-entity feature cache. It carries no feature_*_daily
-- grain and adds no retired-DB (StarRocks / brain_feature / dbt-internal) coupling.
-- ============================================================

-- VERIFICATION (after creation):
-- DESCRIBE EXTENDED brain_gold.gold_recommendations;
-- SHOW TBLPROPERTIES brain_gold.gold_recommendations;
