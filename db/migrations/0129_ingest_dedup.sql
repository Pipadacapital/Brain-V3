--
-- 0129_ingest_dedup.sql — ADR-0012 core: durable event_id dedup gate.
--
-- Amends the ratified "Bronze is append-only; dedup lives in Silver" invariant (CLAUDE.md) so a
-- duplicate connector event is dropped at the ingest boundary BEFORE it is produced to Kafka /
-- landed in Bronze, instead of being collapsed one stage later in Silver. See
-- docs/adr/0012-idempotent-ingest-no-duplicate-events.md.
--
-- data_plane.ingest_dedup is the durable full-history index of ingested (brand_id, event_id): the
-- connector emit path (shiprocket re-pull, backfill, retry, replay) checks it and produces ONLY the
-- unseen ids, then records the produced ids INSERT … ON CONFLICT DO NOTHING (produce-first,
-- mark-after — a crash between at worst re-produces a dup on retry, which Silver backstops; it never
-- loses an event). brand_id-first (tenant isolation); FORCE RLS matches every other data_plane table.
--
-- App gets SELECT + INSERT only — the ingest gate never updates or deletes an already-ingested id
-- (retention/erasure run out of band as a separate lane).
--

CREATE TABLE data_plane.ingest_dedup (
    brand_id uuid NOT NULL,
    event_id uuid NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingest_dedup_pkey PRIMARY KEY (brand_id, event_id)
);

ALTER TABLE data_plane.ingest_dedup ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_plane.ingest_dedup FORCE ROW LEVEL SECURITY;

CREATE POLICY ingest_dedup_brand_isolation ON data_plane.ingest_dedup TO brain_app USING ((brand_id = (current_setting('app.current_brand_id'::text, true))::uuid));

GRANT SELECT,INSERT ON TABLE data_plane.ingest_dedup TO brain_app;
