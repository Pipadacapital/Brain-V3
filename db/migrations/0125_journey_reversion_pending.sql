-- SPEC: B.2 (WB-B2, AMD-08, AMD-11) — event-driven cross-device journey re-version dirty-set
-- ============================================================================
-- 0125_journey_reversion_pending.sql — ops.journey_reversion_pending: the compact, brand-first,
--   BRAIN-grain "dirty set" that carries an identity map MUTATION (link/merge/unmerge) forward to the
--   Spark journey reversion job so the affected brains' JOURNEYS are rebuilt as version N+1 (B.2).
-- ============================================================================
-- WHY (B.2): a canonical journey (brain_gold.journey_events, brain-grain, event-sourced/versioned) is
--   deterministic on the identity map. When that map MUTATES the affected brain_ids' journeys change:
--     - merge   → the survivor folds in the absorbed brain's touchpoints; the absorbed rows are superseded
--     - unmerge → the split reappears; survivor + restored id are both rebuilt
--     - restitch (identity.linked) → a late identify attaches new sessions to an EXISTING brain (A.5.5),
--                 changing that brain's journey composition
--   This table is the event-driven HAND-OFF: the JourneyReversionDirtyConsumer (stream-worker) marks the
--   affected brain_ids dirty with the CAUSE; the Spark reversion job (gold_journey_events_reversion.py)
--   DRAINS the set each run, rebuilds those journeys as data_version+1, writes journey_version_log
--   {brand_id, brain_id, from_version, to_version, cause, at} (AMD-11), and CLEARS the drained rows AFTER
--   its MERGE commits (crash-safe: a crash → rows survive → the next run reprocesses; the reversion MERGE
--   is idempotent so double-processing is harmless). Mirrors ops.restitch_pending (WA-18) at BRAIN grain
--   instead of session/identifier grain.
--
-- WHY event-driven (not only the existing watermark scan): the reversion job already re-versions on a
--   silver_identity_map watermark at refresh-loop cadence. The dirty set ACCELERATES that hand-off (lower
--   latency) AND carries the restitch cause (identity.linked) that the map-watermark alone does not surface
--   as a journey trigger. Both paths converge on the same idempotent N+1 rebuild.
--
-- DIRTY GRAIN (brand-first, brain-grain): one row per (brand_id, brain_id) to re-version, plus the CAUSE
--   ('merge'|'unmerge'|'restitch') recorded on journey_version_log at re-version time. brain_id is an
--   opaque UUID — NEVER PII (I-S02); no identifier hashes ride this lane (session re-stitch keys live in
--   ops.restitch_pending). No money.
--
-- WHY a NEW ops table (not Redis): the DRAIN runs INSIDE the Spark job (Python 3.8 image, no redis-py)
--   which already speaks PG over JDBC — the same posture as ops.restitch_pending. Additive, flag-gated:
--   the consumer only enqueues for brands with `journey.engine` ON, so with every brand default-OFF this
--   table stays EMPTY and golden journey outputs are byte-identical.
--
-- ISOLATION: brand_id is the PK lead column (I-S01). Like ops.restitch_pending / ops.scoped_recompute_
--   request this is a CROSS-BRAND trusted-ETL queue (the worker + Spark run as brain_app with NO brand GUC
--   and drain all flag-ON brands), so it is NOT RLS-forced; isolation is the explicit brand_id on every
--   row/read.
--
-- node-pg-migrate runs with session search_path = public only → every object is schema-qualified.
-- ADDITIVE. Rollback: DROP TABLE ops.journey_reversion_pending (a derived operational queue, NOT a SoR).
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── ops.journey_reversion_pending — the event-driven journey re-version dirty set ──
CREATE TABLE IF NOT EXISTS ops.journey_reversion_pending (
  brand_id        uuid        NOT NULL,                    -- tenant key / dirty-set namespace (I-S01)
  brain_id        uuid        NOT NULL,                    -- the journey owner to rebuild as N+1
  cause           text        NOT NULL                     -- why the journey is dirty (→ journey_version_log.cause)
                    CHECK (cause IN ('merge', 'unmerge', 'restitch')),
  trigger_event   text        NOT NULL,                    -- 'identity.linked|merged|unmerged'
  source_event_id text,                                    -- the identity event_id that dirtied this brain
  enqueued_at     timestamptz NOT NULL DEFAULT now(),      -- when the consumer marked it dirty
  PRIMARY KEY (brand_id, brain_id)                         -- idempotent: same mutation → same row (upsert)
);

-- Drain read: all pending brains for a brand (the Spark job filters to flag-ON brands then drains).
CREATE INDEX IF NOT EXISTS idx_journey_reversion_pending_brand
  ON ops.journey_reversion_pending (brand_id);

-- brain_app grants: the consumer INSERTs (upsert) + the Spark drain SELECTs and DELETEs.
REVOKE ALL ON ops.journey_reversion_pending FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.journey_reversion_pending TO brain_app;

-- Down Migration

DROP TABLE IF EXISTS ops.journey_reversion_pending;   -- reversible: a derived operational dirty-set, NOT a SoR
