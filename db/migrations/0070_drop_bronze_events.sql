-- 0070_drop_bronze_events.sql
--
-- DB-AUDIT C4 — retire the PG Bronze event store. data_plane.bronze_events held raw analytical events
-- in the OPERATIONAL database (wrong tier — analytical data belongs in the Iceberg lakehouse). The
-- retirement is now complete and safe to drop:
--   • operational reads default to Iceberg (collector_events via StarRocks) — migrations/code committed;
--   • the entire DQ subsystem reads Iceberg, not PG bronze;
--   • the PG Bronze writer is default-OFF (ProcessEventUseCase.pgWriteEnabled=false);
--   • Spark→Iceberg (bronze_materialize.py) is the sole Bronze system-of-record, with the SAME R2/R3
--     admission gate, so no admission/parity regression.
--
-- DEPLOY ORDERING (important): ship the code that disables the PG writer + iceberg-only readers and
-- restart the stream-worker BEFORE running this migration, so no in-flight consumer writes to the
-- table mid-drop. Reversible: the Bronze SoR is intact in Iceberg — re-materialize via Spark if needed.

DROP TABLE IF EXISTS data_plane.bronze_events;

-- ── Guard ────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='data_plane' AND table_name='bronze_events') THEN
    RAISE EXCEPTION '0070 VIOLATION: data_plane.bronze_events still exists after DROP';
  END IF;
END $$;
