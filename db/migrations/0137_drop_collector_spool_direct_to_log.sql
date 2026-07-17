--
-- 0137_drop_collector_spool_direct_to_log.sql — ADR-0015 WS1: direct-to-log ingest.
--
-- The collector now produces DIRECTLY to the log (idempotent producer, acks=-1; bounded
-- local-disk WAL fallback). The Postgres spool + drainer + reaper are DELETED from the
-- collector, so their storage goes too:
--
--   • data_plane.collector_spool (+ its sequence/indexes, dropped by CASCADE of the table)
--     — the write-then-delete churn buffer PG was never built to be at 40K/sec.
--   • data_plane.filter_unseen_events / mark_events_seen — the 0130 cross-brand SECURITY
--     DEFINER helpers whose ONLY caller was the deleted collector drainer.
--
-- DELIBERATELY KEPT (deviation from the doc-17 "drop ingest-dedup table" line, on evidence):
-- data_plane.ingest_dedup + prune_ingest_dedup (0129/0131) are STILL the connector emit
-- path's dedup gate — apps/stream-worker/src/infrastructure/pg/IngestDedupRepository.ts is
-- live in 10 pull/repull jobs until WS3/PR 3.4 routes them through the log. Dropping the
-- table here would break every connector repull at runtime. It goes in the WS3 teardown.
--
-- Owner confirmed data is dummy — plain DROPs, no archival.
--
BEGIN;

DROP FUNCTION IF EXISTS data_plane.filter_unseen_events(uuid[], uuid[]);
DROP FUNCTION IF EXISTS data_plane.mark_events_seen(uuid[], uuid[]);

DROP TABLE IF EXISTS data_plane.collector_spool;

COMMIT;
