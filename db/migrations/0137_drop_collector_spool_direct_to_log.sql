--
-- 0137_drop_collector_spool_direct_to_log.sql — ADR-0015 WS1: direct-to-log ingest.
--
-- The collector now produces DIRECTLY to the log (idempotent producer, acks=-1; bounded
-- local-disk WAL fallback). The Postgres drainer + reaper are DELETED from the collector, so
-- their DRAINER-ONLY helpers go now:
--
--   • data_plane.filter_unseen_events / mark_events_seen — the 0130 cross-brand SECURITY
--     DEFINER helpers whose ONLY caller was the deleted collector drainer
--     (apps/collector/src/interfaces/jobs/drainer.ts → ingest-dedup.repository.ts). The
--     OLD release's ACCEPT path never calls them (accept-event.usecase.ts only INSERTs into
--     collector_spool via pg-spool.repository.ts), so dropping the functions is safe while
--     old collector pods are still serving during the rollout.
--
-- DELIBERATELY NOT DROPPED HERE (H1 rollout-safety fix, 2026-07-18):
--   • data_plane.collector_spool — this migration runs as a PreSync hook, i.e. BEFORE the new
--     collector image rolls. The OLD collector pods' accept path INSERTs into collector_spool
--     pre-ACK; dropping the table here 500'd every /collect on the not-yet-replaced pods for
--     the whole rollout window — a live ingest outage and PIXEL EVENT LOSS (browsers don't
--     retry). The table (and its indexes/sequence) therefore STAYS through this release as a
--     write-target for draining old pods, and is dropped NEXT release once the collector
--     fleet is fully rolled: see db/migrations/deferred/drop_collector_spool.sql (non-executed
--     staging file — promote it to the next release's numbered migration).
--
-- ingest-dedup NOTE: data_plane.ingest_dedup + prune_ingest_dedup are NOT touched here — the
-- connector emit path's PG dedup gate is retired separately in 0139 (deterministic event_ids +
-- Bronze compaction dedup replace it; see 0139's rollout-safety note). An earlier revision of
-- this header claimed the gate was "live in 10 pull/repull jobs" — that is no longer true in
-- this release (the IngestDedupRepository callers are deleted in the same change as 0139).
--
-- Owner confirmed data is dummy — plain DROPs, no archival.
--
BEGIN;

DROP FUNCTION IF EXISTS data_plane.filter_unseen_events(uuid[], uuid[]);
DROP FUNCTION IF EXISTS data_plane.mark_events_seen(uuid[], uuid[]);

COMMIT;
