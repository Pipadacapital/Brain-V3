# ADR-0010 — Kafka Connect + Iceberg Sink reinstated as the Bronze landing writer

Status: **Accepted** (2026-07-05)
Supersedes: the ADR-0006 **K2b withdrawal note** (2026-06-28) for decision D1 only.
Relates to: ADR-0006 (D2/D3/D4 stand unchanged), ADR-0002.
Runbook: `docs/runbooks/adr-0010-kafka-connect-bronze.md`.

## Context

ADR-0006 D1 adopted the Iceberg Kafka Connect sink as the Bronze writer; task K2b withdrew it on
2026-06-28 in favor of Spark Structured Streaming ("exactly ONE compute, no extra Connect infra to
operate"). Since then the Spark landing consolidated into one host-run container
(`bronze_landing.py`, 4g driver heap / 7g container cap locally; a 15-min availableNow Argo cron in
the prod blueprint).

The K2b rationale traded infrastructure count for memory footprint. For a bootstrapped company the
trade now runs the other way: the Spark streaming container is the single largest always-on consumer
of local RAM, and keeping the landing path always-on in prod prices a Spark driver, not a ~1G-heap
JVM. **This is an explicit, cost-driven user decision (2026-07-05) to reverse K2b**, taken with the
known trade-offs on the record (below).

## Decision

1. **Writer**: the **Apache** Iceberg Kafka Connect sink (`org.apache.iceberg:iceberg-kafka-connect`
   **1.9.2** — version-locked to the stack's Iceberg runtime; the Tabular fork K2b-era configs used
   is archived) runs in a single Connect worker (compose service `kafka-connect`, 1G heap / 2g cap;
   prod: one small Deployment). Connector configs live in `infra/kafka-connect/` and are registered
   idempotently by `kafka-connect-init`.
2. **Tables — a writer swap, not a table swap** (the ADR-0006 Bronze contract is writer-agnostic):
   - **Collector lane** → `brain_bronze.collector_events_connect`: VERBATIM envelope `payload`
     (StringConverter + HoistField) + kafka coordinates (InsertField). Truly-raw — no lifted
     envelope scalars, no gate, no dedup (ADR-0006 D2 fully realized).
   - **9 raw lanes** → FRESH per-provider `brain_bronze.<lane>_raw_connect` tables, schemaless
     JsonConverter (exploded envelope — the struct schema the P4 normalize jobs were built against,
     restoring the pre-K2b shape the G1 skip-guards have been waiting on). Fresh tables, NOT the
     legacy `*_raw`: the Spark-written `*_raw` schemas carry required (NOT NULL) columns
     (dedup_key/payload) an exploded Connect record can't satisfy — verified live, the Parquet
     writer NPEs on the required-column null.
   - The Spark-SS writers (`bronze_landing.py` → `brain_bronze.events`) keep their own tables; the
     two writers NEVER share a table, so parallel-run/bake is safe by construction.
3. **Exactly-once**: the sink's **commit coordination** — an elected coordinator serializes Iceberg
   commits through the `control-iceberg` topic and stores consumed offsets in the Iceberg snapshot
   metadata (KIP-447-style). This is NOT worker `exactly.once.support` (which is source-connector
   only). Commit interval 30s (`iceberg.control.commit.interval-ms`) — freshness vs small-file
   trade; `bronze_maintenance.py` compaction absorbs the file count.
4. **Dedup moves fully to Silver** (Bronze is append-only): connector-restart duplicates are
   prevented by commit coordination; PRODUCER-side duplicates (webhook redelivery, re-pulls, topic
   replay — same `event_id`, NEW offset) are collapsed by `silver_collector_event`'s
   (brand_id, event_id) window+MERGE and by `_raw_normalize.dedupe_latest` in the 7 normalize jobs.
5. **Read seams** (`BRONZE_SOURCE=connect`): Spark Silver (`silver_collector_event.py` lifts the
   envelope scalars in-job; `_raw_normalize` reads the same `*_raw` tables as legacy), Trino
   operational readers via the lift view `brain_bronze.collector_events_connect_lifted`
   (`db/trino/views/mv_bronze_collector_events_connect.sql`). One env flips landing + reads:
   `BRONZE_LANDING=connect` (see `dev-bronze-streaming.sh` guard + `v4-refresh-loop.sh`).
6. **The Spark streaming Bronze job is retired at cutover** (not deleted until the bake passes —
   rollback = `BRONZE_LANDING=spark BRONZE_SOURCE=events` and restart the sink; its checkpoint is
   preserved. NOTE: rollback is only loss-free within the 7-day topic retention window).

## Consequences

- Local steady-state RAM for Bronze landing drops ~7g → ~2g. Prod runs a ~1.2Gi always-on pod
  instead of a 15-min Spark cron (comparable-to-lower cost at current scale; revisit if volume 10×s).
- Two compute runtimes exist again (Spark for Silver/Gold batch + Connect for landing). This is the
  accepted price; CLAUDE.md's "Spark is the SOLE compute" invariant is amended to "sole TRANSFORM
  compute — Bronze landing is Kafka Connect (ADR-0010)".
- The 5-min-default commit interval class of freshness regression is bounded at 30s by config.
- `brain_bronze.events` remains for history/rollback until Phase 8 decommission (which now also
  covers `bronze_landing.py` itself once the bake + D4 sign-off pass).
- Known watchpoint: the Connect coordinator is one more concurrent writer against the SQLite-backed
  REST catalog (CATALOG_CLIENTS=1 serialization — see iceberg-catalog-sqlite-lock memory); watched
  during bake for `database table is locked` errors.
