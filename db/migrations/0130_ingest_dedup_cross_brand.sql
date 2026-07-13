--
-- 0130_ingest_dedup_cross_brand.sql — ADR-0012: cross-brand ingest dedup helpers for the collector.
--
-- The connector emit path (0129 + IngestDedupRepository) runs for ONE brand with the brand GUC set,
-- so it filters/marks data_plane.ingest_dedup under that brand's per-brand RLS policy in a plain
-- query. The COLLECTOR is different: its drainer connects as brain_app and claims a CROSS-BRAND
-- batch from data_plane.collector_spool (all brands at once — brand_id + event_id are projected out
-- of each raw_body). A single per-brand RLS predicate cannot cover a multi-brand batch, so the two
-- helpers below are SECURITY DEFINER (owner-privileged) and bypass the ingest_dedup RLS policy,
-- keying the (brand_id, event_id) pair EXPLICITLY on every row instead. See
-- docs/adr/0012-idempotent-ingest-no-duplicate-events.md.
--
--   filter_unseen_events — positionally pair the two arrays and return the (brand_id, event_id)
--                          pairs NOT yet in ingest_dedup (the ones the drainer should produce).
--   mark_events_seen     — record produced pairs, INSERT … ON CONFLICT DO NOTHING (idempotent; a
--                          re-drain of the same batch is a no-op).
--
-- Call order at the drain site is CRITICAL (ADR-0012): produce to Kafka FIRST, then mark_events_seen
-- + mark spool rows drained in the SAME claim transaction. A crash between produce and commit leaves
-- both uncommitted → the spool re-drains → filter finds the ids unseen → a dup is re-produced and
-- Silver's per-lane dedup backstops it. It NEVER loses an event.
--
-- SECURITY: SECURITY DEFINER with a pinned search_path (an unset one is an injection hole). The
-- functions are REVOKE-d from PUBLIC and EXECUTE-granted to brain_app only — the same ACL shape as
-- erase_contact_pii_for_customer (baseline) and every other privileged helper.
--

CREATE FUNCTION data_plane.filter_unseen_events(p_brand_ids uuid[], p_event_ids uuid[])
    RETURNS TABLE(brand_id uuid, event_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, data_plane
    AS $$
  SELECT pair.brand_id, pair.event_id
  FROM unnest(p_brand_ids, p_event_ids) AS pair(brand_id, event_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM data_plane.ingest_dedup d
    WHERE d.brand_id = pair.brand_id
      AND d.event_id = pair.event_id
  );
$$;

CREATE FUNCTION data_plane.mark_events_seen(p_brand_ids uuid[], p_event_ids uuid[])
    RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, data_plane
    AS $$
  INSERT INTO data_plane.ingest_dedup (brand_id, event_id)
  SELECT * FROM unnest(p_brand_ids, p_event_ids)
  ON CONFLICT DO NOTHING;
$$;

REVOKE ALL ON FUNCTION data_plane.filter_unseen_events(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_plane.filter_unseen_events(uuid[], uuid[]) TO brain_app;

REVOKE ALL ON FUNCTION data_plane.mark_events_seen(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_plane.mark_events_seen(uuid[], uuid[]) TO brain_app;
