--
-- DEFERRED — NOT EXECUTED. db/migrations/deferred/ is INERT: the migration runner
-- (scripts/migrate.mjs → node-pg-migrate -m db/migrations) only picks up top-level FILES in
-- db/migrations/ (readdir + dirent.isFile() — subdirectories are never descended into), so
-- nothing here runs until it is PROMOTED to a numbered top-level migration.
--
-- drop_collector_spool.sql — the second half of 0137 (ADR-0015 WS1 direct-to-log ingest).
--
-- WHY THIS MUST NOT SHIP IN THE SAME RELEASE AS 0137 (H1, 2026-07-18):
--   Migrations run as a PreSync hook — BEFORE the new collector image rolls. The OLD release's
--   collector accept path INSERTs into data_plane.collector_spool pre-ACK (durability anchor,
--   apps/collector/src/application/accept-event.usecase.ts on release). Dropping the table in
--   the same release as the direct-to-log cutover 500'd every /collect served by a
--   not-yet-replaced pod for the whole rollout window: a live ingest outage and pixel EVENT
--   LOSS (browsers don't retry a 500). The table must survive one full release boundary so
--   every pod that can write to it is gone before it is dropped.
--
-- WHEN TO PROMOTE: in the NEXT release after the ADR-0015 WS1 collector (direct-to-log) image
-- is fully rolled in prod (verify: no pod runs the spool-writing collector —
-- `kubectl -n collector get pods -o jsonpath='{..image}'` shows only post-cutover digests; the
-- table's INSERT traffic is zero). Then: move this file to db/migrations/<next-ordinal>_drop_
-- collector_spool.sql (top level), delete this deferred copy, and let the normal migrate lane
-- apply it.
--
-- Owner confirmed data is dummy — plain DROP, no archival. The spool's sequence + indexes
-- (incl. idx_collector_spool_pending / idx_collector_spool_drained) go with the table.
--
BEGIN;

DROP TABLE IF EXISTS data_plane.collector_spool;

COMMIT;
