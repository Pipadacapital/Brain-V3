--
-- 0131_ingest_dedup_retention.sql — ADR-0012: bounded retention for the global ingest dedup index.
--
-- data_plane.ingest_dedup is the global idempotency index for the ingest path: PK (brand_id, event_id),
-- written INSERT … ON CONFLICT DO NOTHING (0129 + IngestDedupRepository; cross-brand helpers in 0130).
-- It is append-only in practice, so without a prune it grows unbounded (one row per event ever ingested).
--
-- RETENTION IS TIME-BASED DELETE, *NOT* PARTITIONING — and this is deliberate. A RANGE partition on
-- ingested_at would force ingested_at into the table's unique constraint (Postgres requires the
-- partition key to be part of every UNIQUE/PK on a partitioned table). The SAME (brand_id, event_id)
-- re-ingested on two different days would then land in two different partitions and NO LONGER collide
-- on the PK — i.e. dedup would silently break. So we keep the flat (brand_id, event_id) PK and prune by
-- deleting old rows instead.
--
-- Forgetting old rows is SAFE: a backfill only ever re-ingests RECENT data, so any (brand_id, event_id)
-- older than the longest backfill window will never be presented again. Worst case, a very old re-ingest
-- re-flows exactly once and Silver's per-lane dedup backstops it (no event loss, no double-count downstream).
-- The scheduled prune (infra/helm/cronworkflows) runs with a retention window comfortably larger than any
-- backfill window (180 days at the time of writing). See docs/adr/0012-idempotent-ingest-no-duplicate-events.md.
--
-- SECURITY: prune_ingest_dedup is SECURITY DEFINER with a pinned search_path (an unset one is an injection
-- hole) and REVOKE-d from PUBLIC / EXECUTE-granted to brain_app only — the same ACL shape as
-- filter_unseen_events / mark_events_seen (0130) and every other privileged helper. brain_app has only
-- SELECT + INSERT on ingest_dedup, so the prune MUST be definer-owned to DELETE — we deliberately do NOT
-- grant brain_app DELETE on the table.
--

-- Supports the prune's `WHERE ingested_at < …` scan (and keeps each batch's ctid subselect cheap).
CREATE INDEX ingest_dedup_ingested_at_idx ON data_plane.ingest_dedup (ingested_at);

-- Batched time-based prune. Deletes in bounded chunks so a large backlog prune never holds one giant
-- lock / bloats WAL in a single statement; each batch is its own DELETE. Returns the total rows deleted.
CREATE FUNCTION data_plane.prune_ingest_dedup(p_retain interval, p_batch integer DEFAULT 50000)
    RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, data_plane
    AS $$
DECLARE
  v_deleted   bigint := 0;
  v_batch_rows bigint;
BEGIN
  LOOP
    DELETE FROM data_plane.ingest_dedup
    WHERE ctid IN (
      SELECT ctid
      FROM data_plane.ingest_dedup
      WHERE ingested_at < now() - p_retain
      LIMIT p_batch
    );
    GET DIAGNOSTICS v_batch_rows = ROW_COUNT;
    v_deleted := v_deleted + v_batch_rows;
    EXIT WHEN v_batch_rows = 0;
  END LOOP;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION data_plane.prune_ingest_dedup(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_plane.prune_ingest_dedup(interval, integer) TO brain_app;
