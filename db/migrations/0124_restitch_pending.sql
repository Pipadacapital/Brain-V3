-- SPEC: A.2.3.5 (WA-18, AMD-08) — event-driven re-stitch dirty-set
-- ============================================================================
-- 0124_restitch_pending.sql — ops.restitch_pending: the compact, brand-first "dirty set" that carries
--   an identity map MUTATION (link/merge/unmerge/mint) forward to the Spark stitch job so PAST sessions
--   containing the affected identifier are RE-EVALUATED within one incremental run (A.2.3(5) / A.5.5).
-- ============================================================================
-- WHY (A.2.3(5)): "Re-stitch on identity change … stitch job … finds sessions containing that identifier
--   within the attribution lookback, re-runs 1–3. This mechanism lifts PAST journeys — most of the >40%
--   target." The incremental stitch (silver_session_identity.py) only scans sessions AT/ABOVE its
--   watermark; a day-1 session is far below the watermark when a day-7 identify lands. This table is the
--   HAND-OFF: the RestitchDirtyConsumer (stream-worker) marks the mutation's affected keys dirty; the
--   Spark job DRAINS the set each run, adds the matching historical sessions to its universe, re-resolves
--   them, and CLEARS the drained rows AFTER its MERGE commits (crash-safe: a crash → rows survive → the
--   next run reprocesses; the stitch MERGE is idempotent so double-processing is harmless).
--
-- DIRTY GRAIN (brand-first, two kinds):
--   dirty_kind='identifier_hash' → dirty_key = a 64-hex salted/plain identifier hash (the AMD-08
--     "brand_id+identifier_hash" key). The Spark job re-evaluates lookback-bounded sessions whose
--     identifier set contains this hash. This is THE mechanism for the late-identify (A.5.5) lift.
--   dirty_kind='brain_id'        → dirty_key = a brain_id UUID (merge/unmerge). The Spark job
--     re-evaluates lookback-bounded sessions already stitched to that brain_id (they may now point at a
--     new canonical after a merge, or split back out after an unmerge). Journey re-versioning (B.2) owns
--     the brain-grain rebuild; this only re-points the SESSION stitch.
--
-- WHY a NEW ops table (not a Redis key): the DRAIN runs INSIDE the Spark job (Python 3.8 image, no
--   redis-py) which already speaks PG over JDBC (salt read + legacy dual-write + review bridge). A PG
--   dirty-set is transactionally read+deleted from the same job with no new client. Additive, flag-gated:
--   the consumer only enqueues for brands with `stitch.v2` ON, and the Spark job only drains flag-ON
--   brands, so with every brand default-OFF this table stays EMPTY and golden outputs are byte-identical.
--
-- ISOLATION: brand_id is the PK lead column (I-S01). Like ops.scoped_recompute_request (0116) this is a
--   CROSS-BRAND trusted-ETL queue (the worker + Spark run as brain_app with NO brand GUC and read/drain
--   all flag-ON brands), so it is NOT RLS-forced; isolation is the explicit brand_id on every row/read.
--   MONEY: none (opaque hashes/UUIDs + timestamps only).
--
-- node-pg-migrate runs with session search_path = public only → every object is schema-qualified.
-- ADDITIVE. Rollback: DROP TABLE ops.restitch_pending (a derived operational queue, NOT a SoR).
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── ops.restitch_pending — the event-driven re-stitch dirty set ───────────────
CREATE TABLE IF NOT EXISTS ops.restitch_pending (
  brand_id        uuid        NOT NULL,                    -- tenant key / dirty-set namespace (I-S01)
  dirty_kind      text        NOT NULL                     -- what dirty_key means (drives the drain lane)
                    CHECK (dirty_kind IN ('identifier_hash', 'brain_id')),
  dirty_key       text        NOT NULL,                    -- 64-hex identifier hash OR brain_id UUID
  trigger_event   text        NOT NULL,                    -- 'identity.minted|linked|merged|unmerged'
  source_event_id text,                                    -- the identity event_id that dirtied this key
  enqueued_at     timestamptz NOT NULL DEFAULT now(),      -- when the consumer marked it dirty
  PRIMARY KEY (brand_id, dirty_kind, dirty_key)            -- idempotent: same mutation → same row (upsert)
);

-- Drain read: all pending keys for a brand (the Spark job filters to flag-ON brands then drains).
CREATE INDEX IF NOT EXISTS idx_restitch_pending_brand
  ON ops.restitch_pending (brand_id, dirty_kind);

-- brain_app grants: the consumer INSERTs (upsert) + the Spark drain SELECTs and DELETEs.
REVOKE ALL ON ops.restitch_pending FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.restitch_pending TO brain_app;

-- Down Migration

DROP TABLE IF EXISTS ops.restitch_pending;   -- reversible: a derived operational dirty-set, NOT a SoR
