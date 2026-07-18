--
-- 0141_drop_collector_spool.sql — PROMOTED from db/migrations/deferred/ (ADR-0015 WS1, H1).
--
-- The second (deferred) half of 0137: drops data_plane.collector_spool. Held one release
-- boundary on purpose — the OLD collector accept path INSERTed into this table pre-ACK, so a
-- PreSync DROP in the same release as the direct-to-log cutover would have 500'd every /collect
-- served by a not-yet-replaced pod (live ingest outage + pixel loss). Promoted only after the
-- direct-to-log collector image (digest sha256:e45a7cde…) was verified FULLY ROLLED in prod and
-- the table's INSERT traffic was zero (newest received_at frozen at the 2026-07-18 cutover).
--
-- The spool's sequence + indexes (idx_collector_spool_pending / idx_collector_spool_drained) go
-- with the table. IF EXISTS keeps it idempotent (prod was dropped out-of-band ahead of this file;
-- a re-run is a no-op).
--
BEGIN;

DROP TABLE IF EXISTS data_plane.collector_spool;

COMMIT;
