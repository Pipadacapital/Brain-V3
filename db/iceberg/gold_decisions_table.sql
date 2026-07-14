-- SPEC: H
-- ============================================================
-- gold_decisions — Decision Engine record (Wave H SCAFFOLD, INERT)
-- ------------------------------------------------------------
-- STATUS: scaffold DDL only. This table is NOT wired into tools/dev/v4-refresh-loop.sh
--         and NO Spark builder writes it (there is intentionally no
--         db/iceberg/spark/gold/gold_decisions.py). It is inert until Wave H logic
--         (evaluation engine + EV models + arbitration) ships behind flag
--         `decision.engine` (packages/platform-flags, DEFAULT OFF).
--
-- PURPOSE (PLAN-OF-RECORD §PART 6.H): persist the DECISION RECORD — every candidate
--         action WITH its per-candidate expected value and constraint evaluations, the
--         SELECTED candidate, the policy version that arbitrated, and the rationale.
--         "The road not taken persisted" — auditability of candidates that LOST, not
--         just the winner.
--
-- INVARIANTS honoured:
--   - §1: brand_id is the FIRST column and the partition-bucket anchor (tenant isolation).
--   - §1.4/I-S07: money is bigint MINOR units + a sibling currency_code, per candidate.
--     expected_value_minor rides INSIDE each candidate object in `candidates` (never a float,
--     never blended across currencies — each candidate carries its own currency_code).
--   - I-E02 schema evolution: ADDITIVE-OPTIONAL only (never drop a column; new columns
--     nullable). Append-only fact — a decision is immutable once recorded.
--   - Constraints reference CERTIFIED metrics ONLY BY NAME (Wave D certified set); the metric
--     NAMES + evaluated values live in the candidates' constraint_evaluations JSON — this table
--     stores no metric SQL, it references certified names (why Wave D precedes Wave H runtime).
--
-- Run via spark-sql against the Gold catalog (rest + MinIO/S3), mirrors bronze_table.sql style.
-- ============================================================

CREATE NAMESPACE IF NOT EXISTS brain_gold;

CREATE TABLE IF NOT EXISTS brain_gold_local.gold_decisions (
  -- ── Tenant + identity (brand_id FIRST — §1) ──────────────────────────────────
  brand_id         STRING     NOT NULL COMMENT 'UUID — tenant key. Partition bucket source. RLS anchor. FIRST column (§1).',
  decision_id      STRING     NOT NULL COMMENT 'UUID — idempotency key component: (brand_id, decision_id). One row per decision.',

  -- ── What the decision is about ───────────────────────────────────────────────
  subject          STRING     NOT NULL COMMENT 'JSON: the decision subject, e.g. {"type":"customer","id":"BRN-..."}. type ∈ customer|product|campaign|order.',

  -- ── The road not taken (candidates WITH scores) ──────────────────────────────
  -- JSON array. Each element persists the FULL evaluation of one candidate action — winners AND
  -- losers — so the decision is auditable end-to-end. Element shape (schema-of-record, validated at
  -- write time by the Wave-H writer, NOT by Iceberg):
  --   {
  --     "candidate_id": "whatsapp_nudge",
  --     "action_type": "messaging",
  --     "expected_value_minor": 125000,        -- bigint minor units (I-S07); NEVER a float
  --     "currency_code": "INR",                -- sibling currency for expected_value_minor
  --     "constraint_evaluations": [            -- per-candidate guardrail results, certified metrics BY NAME
  --       {"metric":"cm2_pct","op":"gte","threshold":0.20,"observed":0.27,"passed":true},
  --       {"metric":"rto_rate","op":"lte","threshold":0.15,"observed":0.08,"passed":true}
  --     ],
  --     "eligible": true,                      -- all hard constraints passed
  --     "rank": 1                              -- arbitration rank (1 = would-be winner)
  --   }
  candidates       STRING     NOT NULL COMMENT 'JSON array of candidates WITH per-candidate expected_value_minor + currency_code + constraint_evaluations. The road not taken persisted.',

  -- ── The chosen candidate ─────────────────────────────────────────────────────
  selected         STRING              COMMENT 'candidate_id of the arbitration winner. NULL = a null decision (no eligible candidate) — itself an audited outcome.',

  -- ── Which policy arbitrated ──────────────────────────────────────────────────
  policy_version   STRING     NOT NULL COMMENT 'Certified policy identity "<name>@<version>" (decision-policies YAML metadata.name + monotonic version). The road-not-taken is only trustworthy if we know WHICH policy ranked it.',

  -- ── Why ──────────────────────────────────────────────────────────────────────
  rationale        STRING     NOT NULL COMMENT 'JSON explanation: {"strategy":"max_expected_value","tie_breaker":"lowest_cost","notes":"..."} — human/agent-readable justification of the selection.',

  -- ── Time ─────────────────────────────────────────────────────────────────────
  decided_at       TIMESTAMP  NOT NULL COMMENT 'Decision time UTC. Partition days() source. Append-only watermark.',

  -- ── Evolution-safe provenance (additive-optional, nullable — I-E02) ──────────
  engine_version   STRING              COMMENT 'Decision-engine build that produced this record. Nullable until Wave H runtime ships.',
  execution_mode   STRING              COMMENT 'suggest|approve|auto (SPEC §PART 6.F/I). Default meaning "suggest" when null; auto unreachable until Wave I governance.'
)
USING iceberg
PARTITIONED BY (
  bucket(16, brand_id),
  days(decided_at)
)
TBLPROPERTIES (
  'write.format.default'              = 'parquet',
  'write.parquet.compression-codec'  = 'zstd',
  'write.target-file-size-bytes'     = '134217728',
  'write.metadata.compression-codec' = 'gzip',
  'format-version'                   = '2',
  'write.upsert.enabled'             = 'false',

  -- Append-only decision facts (immutable once recorded)
  'brain.immutable'         = 'true',
  'brain.layer'             = 'gold',
  'brain.schema.evolution'  = 'additive-optional-only',
  'brain.wave'              = 'H',
  'brain.scaffold'          = 'true'
);

-- ============================================================
-- VERIFICATION (after creation)
--   DESCRIBE EXTENDED brain_gold_local.gold_decisions;
--   SHOW TBLPROPERTIES brain_gold_local.gold_decisions;
-- ============================================================
