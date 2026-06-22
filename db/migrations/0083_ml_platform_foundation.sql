-- 0083_ml_platform_foundation.sql
--
-- DB-AUDIT C5 — ML platform foundation. The audit found the feature store write-only/orphaned and NO
-- model registry / serving / lifecycle. This lays the paved path:
--   • ml.model_registry  — versioned models with a GATED lifecycle (training→staging→production→archived),
--     metrics + feature_set provenance, and a "one production model per (brand, name)" invariant.
--   • ml.prediction_log  — append-only, RANGE-partitioned (C4b) inference log: every served prediction
--     is recorded for monitoring + offline eval (closes the train/serve loop the audit flagged missing).
-- Seeded HONESTLY: the existing deterministic RFM/churn scorer (gold_customer_scores) is registered as
-- the current PRODUCTION model per active brand — the registry is non-empty and truthful from day one,
-- and real trained models later promote into the SAME registry on the same grain.
--
-- Tenant-isolated (RLS FORCE, brain_app brand-scoped). prediction_log is append-only by grant and is
-- auto-maintained by public.maintain_time_partitions() (0080) since it auto-discovers partitioned tables.

CREATE SCHEMA IF NOT EXISTS ml;
GRANT USAGE ON SCHEMA ml TO brain_app;

-- ── model registry ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE ml.model_registry (
  model_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  brand_id    uuid        NOT NULL,
  name        text        NOT NULL,
  version     text        NOT NULL,
  stage       text        NOT NULL DEFAULT 'training'
                CHECK (stage = ANY (ARRAY['training','staging','production','archived'])),
  framework   text        NOT NULL DEFAULT 'deterministic',
  feature_set jsonb       NOT NULL DEFAULT '[]'::jsonb,
  metrics     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  trained_at  timestamptz,
  promoted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id),
  UNIQUE (brand_id, name, version)
);
-- Invariant: at most ONE production model per (brand, name) — the gated lifecycle's promotion target.
CREATE UNIQUE INDEX model_registry_one_production
  ON ml.model_registry (brand_id, name) WHERE stage = 'production';
CREATE INDEX idx_model_registry_brand_stage ON ml.model_registry (brand_id, stage);

ALTER TABLE ml.model_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml.model_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY model_registry_isolation ON ml.model_registry
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON ml.model_registry FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON ml.model_registry TO brain_app;  -- UPDATE = lifecycle promotion

-- ── prediction log (append-only, RANGE-partitioned per C4b) ─────────────────────────────────────────
CREATE TABLE ml.prediction_log (
  prediction_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  brand_id      uuid        NOT NULL,
  model_id      uuid        NOT NULL,
  subject_type  text        NOT NULL,            -- e.g. 'customer'
  subject_key   text        NOT NULL,            -- e.g. brain_id
  prediction    jsonb       NOT NULL,            -- the served payload (scores/bands/etc.)
  score         double precision,                -- optional scalar for quick monitoring
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, prediction_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE ml.prediction_log_p2026_06 PARTITION OF ml.prediction_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE ml.prediction_log_pdefault PARTITION OF ml.prediction_log DEFAULT;

CREATE INDEX idx_prediction_log_subject ON ml.prediction_log (brand_id, subject_type, subject_key, created_at DESC);
CREATE INDEX idx_prediction_log_model   ON ml.prediction_log (brand_id, model_id, created_at DESC);

ALTER TABLE ml.prediction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml.prediction_log FORCE ROW LEVEL SECURITY;
CREATE POLICY prediction_log_isolation ON ml.prediction_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON ml.prediction_log FROM brain_app;
GRANT SELECT, INSERT ON ml.prediction_log TO brain_app;  -- append-only

-- ── seed: register the deterministic scorer as PRODUCTION per active brand (honest baseline) ─────────
INSERT INTO ml.model_registry (brand_id, name, version, stage, framework, feature_set, metrics, trained_at, promoted_at)
SELECT b.id, 'customer_churn_rfm', 'v0-deterministic', 'production', 'deterministic',
       '["recency_score","frequency_score","monetary_score","days_since_last_order"]'::jsonb,
       jsonb_build_object('type','rule_based',
                          'source_mart','gold_customer_scores',
                          'note','Deterministic RFM + churn-risk bands; replaced in-place by a trained model on promotion.'),
       now(), now()
FROM tenancy.brand b
WHERE b.status = 'active'
ON CONFLICT (brand_id, name, version) DO NOTHING;
