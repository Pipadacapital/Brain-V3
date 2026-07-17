--
-- 0140_erasure_request_queue.sql — ADR-0015 WS4 completion: the ERASURE lane goes PG request-driven.
--
-- The DPDP/PDPL crypto-shred erasure orchestrator was the LAST stream-worker Kafka consumer
-- (group stream-worker-erasure-orchestrator on {env}.collector.event.v1). It is now a batch/poll
-- lane: core's ErasureEventPublisher INSERTs the SAME CollectorEventV1-shaped trigger envelope
-- into this queue (durable, local PG — no Kafka hop), and the stream-worker poll loop
-- (jobs/erasure-orchestrator/run.ts) claims rows and runs the UNCHANGED EraseSubjectUseCase
-- ordered sequence (DEK shred → contact_pii → surrogate → Neo4j purge → Gold re-projection +
-- cache eviction → Bronze raw sweep (Argo) → CAPI deletion → complete).
--
-- SEMANTICS PRESERVED FROM THE KAFKA LANE:
--   - id = the envelope event_id (PK; ON CONFLICT DO NOTHING = idempotent re-INSERT of the same
--     trigger — the produce-side dedup the idempotent Kafka producer gave us).
--   - Per-brand ordering: the claim query only takes the OLDEST pending-or-processing row per
--     brand (the head), mirroring Kafka's partition-by-brand_id serialization. A processing or
--     backoff-delayed head blocks its brand's queue exactly like an uncommitted offset did.
--   - Retry-with-poison: attempts + next_attempt_at backoff replace the Redis retry counter
--     (T2-8 durability now lives in the row itself); attempts >= 5 → status='dead' — the PG
--     replacement for the retired collector.event.v1.dlq. 'invalid' envelopes go dead
--     immediately (no retry helps), matching the old DLQ-immediate path.
--   - Audit trail: identity.pii_erasure_log (0114/0115) remains the compliance record; this
--     queue additionally keeps requested_at/attempts/last_error/outcome for the operator.
--
-- PII NOTE (deliberate, mirrors the audit-ratified Kafka envelope): payload carries the raw
-- subject email/phone when the entry point holds it — the exact envelope shape
-- EraseSubjectUseCase was designed to consume. The worker CLEARS payload on status='done'
-- (the Kafka copy aged out with topic retention; a done row must not retain raw PII).
-- 'dead' rows keep the payload for operator redrive/forensics (the DLQ kept 30d — an operator
-- resolves or purges dead rows). subject_ref is NEVER raw PII: brain_id UUID, or an unsalted
-- SHA-256 digest of the raw identifier (ops/dedup handle only — resolution always re-hashes
-- the payload subject with the per-brand salt).
--
-- Cross-brand trusted-ETL table (like ops.restitch_pending / ops.scoped_recompute_request):
-- core + worker run as brain_app with NO brand GUC, so NOT RLS-forced; isolation is the
-- explicit brand_id column on every row and every downstream write is (brand_id, brain_id)-
-- scoped inside the use case. No money.
--
BEGIN;

CREATE TABLE IF NOT EXISTS ops.erasure_request_queue (
    -- The trigger envelope's event_id: idempotency key (re-issue of the same envelope no-ops).
    id              uuid NOT NULL PRIMARY KEY,
    brand_id        uuid NOT NULL,
    -- Primary subject address kind carried by the trigger: 'brain_id' | 'email' | 'phone'.
    subject_kind    text NOT NULL
        CONSTRAINT erasure_request_queue_subject_kind_check
        CHECK (subject_kind IN ('brain_id', 'email', 'phone')),
    -- brain_id UUID, or unsalted sha256 hex of the raw identifier. NEVER raw PII.
    subject_ref     text NOT NULL,
    -- Which RTBF entry point fired ('consent.withdraw' | 'identity.erase' | 'shopify.customers_redact').
    source          text NOT NULL,
    -- The full CollectorEventV1-shaped trigger envelope (+ top-level region_code) —
    -- fed byte-identically to EraseSubjectUseCase. NULLed on 'done' (PII hygiene).
    payload         jsonb,
    status          text NOT NULL DEFAULT 'requested'
        CONSTRAINT erasure_request_queue_status_check
        CHECK (status IN ('requested', 'processing', 'done', 'dead')),
    -- Terminal EraseSubjectUseCase outcome ('erased' | skip outcomes | 'invalid') for ops.
    outcome         text,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    claimed_at      timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_error      text
);

-- Claim path: head-of-brand scan over pending rows.
CREATE INDEX IF NOT EXISTS erasure_request_queue_claim_ix
    ON ops.erasure_request_queue (brand_id, requested_at, id)
    WHERE status IN ('requested', 'processing');

-- brain_app: SELECT/INSERT/UPDATE (status transitions are UPDATEs; the queue is never DELETEd
-- by the services — dead/done rows are an operator-lifecycle concern).
GRANT SELECT, INSERT, UPDATE ON TABLE ops.erasure_request_queue TO brain_app;

COMMIT;
