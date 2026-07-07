-- ============================================================
-- SPEC: F.2 — ops_llm_calls Iceberg table DDL (CONTRACT-F, AI Platform Infrastructure)
-- ============================================================
-- Append-only LLM-call cost/observability LEDGER for every model call routed through the
-- LiteLLM gateway (infra/litellm.config.yaml). One row per gateway request.
--
-- SCAFFOLD-ONLY (PLAN-OF-RECORD §PART 6 / §0.1): this is a DDL scaffold. NO writer is wired.
-- The LiteLLM success/failure callback that would MERGE rows here is a NotImplemented adapter
-- behind the `ai.gateway.call_logging` flag (default OFF) — see packages/ai-platform.
-- This file is NOT in the v4 refresh loop; it creates an inert, empty table.
--
-- WHY ICEBERG (not the PG `ops` schema): this is a high-cardinality, append-only observability
-- FACT stream (every model call), 24-month retentioned like Bronze — the lakehouse append-only
-- pattern, not mutable operational state. It lives in the NET-NEW `brain_ops` Iceberg namespace
-- (the lakehouse ops-log namespace; distinct from the retired StarRocks `brain_ops` DB and the
-- PostgreSQL `ops` schema, neither of which this touches). It does NOT trip v4-naming-guard
-- (R1/R4 scope only the retired dbt DBs brain_gold./brain_silver.; R3 scopes feature-precompute).
--
-- PRIVACY (§1.3 / §F): NO raw prompts, NO raw PII. Only a `prompt_hash` (SHA-256 hex of the
-- normalized prompt) is stored here. The human-readable prompt goes to a SEPARATE redacted-PII
-- prompt store ONLY after passing the masking hook (packages/ai-platform maskPromptForStore) —
-- referenced from this row by `redacted_prompt_ref`, never inlined. deletion = key-shred (the
-- subject envelope columns are carried when a call is subject-linked; registered in the shred
-- manifest — see knowledge-base/privacy/shred-manifest.md).
--
-- MONEY (§1.2): `cost_minor` is bigint MINOR units + a sibling `currency` (ISO-4217). NEVER a float.
-- TENANT (§0.5 / I-S01): `brand_id` is the FIRST column, the bucket() partition anchor, the RLS key.
--
-- Run via spark-sql against the local Iceberg REST catalog (compose `iceberg-rest`) / Glue in prod.
-- ============================================================

-- The NET-NEW lakehouse ops-log namespace (append-only observability facts).
CREATE NAMESPACE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.ops_llm_calls (
  -- ── Tenant + request identity ──────────────────────────────────────────────
  brand_id            STRING     NOT NULL COMMENT 'UUID — tenant key. FIRST column. Partition bucket source. RLS anchor (I-S01).',
  request_id          STRING     NOT NULL COMMENT 'Gateway request id (LiteLLM x-request-id) — idempotency key component: (brand_id, request_id).',
  ts                  TIMESTAMP  NOT NULL COMMENT 'Call time UTC. Partition days() source.',

  -- ── Routing / model ────────────────────────────────────────────────────────
  model               STRING     NOT NULL COMMENT 'The resolved model alias/id the gateway routed to (e.g. small_model → anthropic/claude-haiku-4-5).',
  task_class          STRING              COMMENT 'The task-class alias requested (litellm.config task_class_routing). Nullable for legacy callers.',

  -- ── Prompt provenance (NO raw prompt, NO raw PII — §1.3/§F) ─────────────────
  prompt_hash         STRING     NOT NULL COMMENT 'SHA-256 hex of the normalized prompt. The ONLY prompt provenance stored inline. Never the raw prompt.',
  redacted_prompt_ref STRING              COMMENT 'Opaque pointer into the SEPARATE redacted-PII prompt store (post-masking-hook). Nullable; NEVER an inline prompt.',

  -- ── Usage + cost (integer minor units + currency — §1.2) ───────────────────
  tokens_in           BIGINT     NOT NULL COMMENT 'Prompt tokens.',
  tokens_out          BIGINT     NOT NULL COMMENT 'Completion tokens.',
  cost_minor          BIGINT     NOT NULL COMMENT 'Call cost in ISO-4217 MINOR units (bigint). NEVER a float.',
  currency            STRING     NOT NULL COMMENT 'ISO-4217 code siblings cost_minor (e.g. USD). Money is never blended/floated.',
  latency_ms          BIGINT     NOT NULL COMMENT 'End-to-end gateway latency in whole milliseconds.',

  -- ── Outcome (additive-optional; nullable) ──────────────────────────────────
  outcome             STRING              COMMENT 'success | failure | budget_blocked. Nullable on first write (additive-optional, I-E02).',
  trace_id            STRING              COMMENT 'OTEL trace id from the gateway span (ai-observability-tracing). Nullable.',

  -- ── Crypto-shred envelope (populated ONLY when the call is subject-linked; §1.3) ──
  subject_key_id      STRING              COMMENT 'Per-subject envelope key id when the call is linked to a data subject. Null = not subject-linked. Deletion = destroy this key. Shred-manifest registered.'
)
USING iceberg
PARTITIONED BY (
  bucket(16, brand_id),
  days(ts)
)
TBLPROPERTIES (
  'write.format.default'              = 'parquet',
  'write.parquet.compression-codec'  = 'zstd',
  'write.target-file-size-bytes'     = '134217728',
  'write.metadata.compression-codec' = 'gzip',
  'format-version'                   = '2',
  'write.upsert.enabled'             = 'false',

  -- 24-month rolling retention (parity with Bronze observability facts).
  'history.expire.max-snapshot-age-ms'   = '63072000000',
  'history.expire.min-snapshots-to-keep' = '1',

  'write.object-storage.enabled' = 'true',

  'brain.immutable'        = 'true',
  'brain.layer'            = 'ops',
  'brain.spec'             = 'F.2',
  'brain.retention.months' = '24',
  'brain.schema.evolution' = 'additive-optional-only',
  'brain.scaffold'         = 'true'
);

-- ============================================================
-- VERIFICATION (run after creation)
-- ============================================================
-- DESCRIBE EXTENDED brain_ops.ops_llm_calls;
-- SHOW TBLPROPERTIES brain_ops.ops_llm_calls;
