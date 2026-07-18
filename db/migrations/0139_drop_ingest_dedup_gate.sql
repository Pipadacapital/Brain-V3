--
-- 0139_drop_ingest_dedup_gate.sql — ADR-0015 WS3: retire the PG ingest-dedup gate.
--
-- The connector emit path (10 pull/repull jobs) no longer consults data_plane.ingest_dedup:
-- every lane's event_id is DETERMINISTIC for the same provider record (hashToUuidShaped /
-- uuidV5From* over provider ids + composite keys), so a re-pulled duplicate re-mints the SAME
-- (brand_id, event_id) and is collapsed by Bronze compaction dedup (bronze_dedup.py, keep-latest)
-- with the Silver MERGE as the final backstop. The IngestDedupRepository + ingest-dedup-prune job
-- are deleted from stream-worker in the same change, so their storage goes too:
--
--   • data_plane.ingest_dedup (0129) — the durable (brand_id, event_id) idempotency index; its
--     RLS policy + ingested_at index (0131) are dropped by CASCADE of the table.
--   • data_plane.prune_ingest_dedup (0131) — the SECURITY DEFINER batched retention prune whose
--     ONLY caller was the deleted ingest-dedup-prune CronWorkflow.
--
-- The 0130 cross-brand helpers (filter_unseen_events / mark_events_seen) were already dropped
-- by 0137. Owner confirmed data is dummy — plain DROPs, no archival.
--
-- ROLLOUT-WINDOW ASSESSMENT (H1 follow-up, 2026-07-18): this PreSync drop shares 0137's shape —
-- OLD-release stream-worker pods still consult data_plane.ingest_dedup (IngestDedupRepository in
-- the 10 pull/repull jobs) until the new image rolls, and their pulls will ERROR against the
-- dropped table during that window. Assessed ACCEPTABLE — deliberately NOT split like 0137's
-- collector_spool: these are SCHEDULED pull jobs (cron/scheduler-driven, minutes-cadence), not a
-- pre-ACK browser ingest path. A failed tick surfaces as a retryable job error, the next tick
-- (on the new image) re-pulls the same provider window, and every lane's event_id is
-- deterministic for the same provider record — so the worst case is a few minutes of connector
-- staleness, NEVER event loss (contrast: dropping collector_spool mid-roll 500'd live pixel
-- ACKs — see db/migrations/deferred/drop_collector_spool.sql).
--
BEGIN;

DROP FUNCTION IF EXISTS data_plane.prune_ingest_dedup(interval, integer);

DROP TABLE IF EXISTS data_plane.ingest_dedup;

COMMIT;
