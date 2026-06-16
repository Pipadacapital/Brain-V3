# Feature Journal — feat-data-plane-ingest-spine

> Thin data-plane ingest spine: synthetic event → collector → Redpanda → stream-worker → Bronze, behind tenant isolation. M1 critical path (doc 05 §14 exit).

## 2026-06-16T20:10:00Z — Stage 2 (Architecture) — ADVANCE
**Architect.** Binding plan authored: `03-architecture-plan.md`. Branch `feat/data-plane-ingest-spine` off `master` (HEAD 8f7e613).

**Key bindings:**
- **D-4 → Postgres `bronze_events` staging-table fallback for M1** (no TS Iceberg writer exists; Nessie is catalog-only; PyIceberg/Spark = Phase 3). The Iceberg target (bronze_table.sql/bronze_spec.json) stays untouched; Phase-3 flip is a mechanical column-map. NO new stack layer / no new ADR (D-4-pre-authorised fallback, 02 §119).
- **Isolation = Postgres RLS** (two-arg current_setting, FORCE RLS, brain_app INSERT+SELECT-only) — re-bound from Iceberg partition predicate because the M1 sink is Postgres. All isolation tests under `SET ROLE brain_app`.
- **Contracts first:** ingest_at→ingested_at; occurred_at/ingested_at number→string ISO-8601; codegen committed before consumers.
- **Migrations:** 0015_collector_spool (no RLS, pre-brand), 0016_bronze_events (RLS, append-only GRANT, PK=(brand_id,event_id)). Additive.
- **Flow:** accept→spool→ACK→drainer→Redpanda (D-1); consume→Zod validate→Redis dedup NX EX 7d→Bronze→THEN commit offset (D-7); DLQ after MAX_RETRY=5.

**Slices:** 1 spike-confirm+contract+migrations | 2 collector edge | 3 stream-worker sink | 4 e2e+durability+dedup+isolation tests | 5 deploy. COMMIT PER SLICE.

**Tracks:** @backend-developer (collector edge/spool/drainer) ∥ @data-engineer (stream-worker/Bronze/dedup). Slice 1 shared, lands first.

**Next:** Stage 3 build — @backend-developer + @data-engineer.

## 2026-06-16T20:25:00Z — Backend Engineer — feat-data-plane-ingest-spine
**Stage:** 3 · **Service:** collector (Track B) · **Verification:** typecheck/test/lint EXIT 0

**Slices delivered:**
- Slice 1 (0b1a342): F-6 ingest_at→ingested_at (Zod+Avro+codegen); F-1 occurred_at/ingested_at string ISO-8601; migration 0015_collector_spool (no RLS, brain_app SELECT+INSERT+UPDATE); migration 0016_bronze_events (RLS FORCE NN-1 two-arg, brain_app INSERT+SELECT only, (brand_id,event_id) PK). Contracts test 8/8 PASS.
- Slice 2 (b25f51c): DDD-structured collector — domain/ingest/, application/, infrastructure/, interfaces/rest/, interfaces/jobs/. AcceptEventUseCase: stamp+INSERT only (no validate/produce). DrainEventsUseCase: poll→produce→mark-drained, catch errors and break (F-3 back-pressure). Drainer: separate setInterval after HTTP listener. Apicurio startup backoff 500ms→5s max 30s, degrade-don't-crash (D-10).
- Slice 3 (2da8f73): 5/5 vitest tests PASS. ACK ordering proven (code structure + test). Redpanda-down durability proven (dead broker localhost:19999 → 0 drained → spool holds; live broker → row drained on recovery). Health endpoints verified.

**Self-review vs gates:** PASS — ordering proven, NN-1 two-arg confirmed, additive migrations, no offset pagination, trace ID on responses.
**Must-fix noted:** Rate-limit plugin (M2); Avro wire encoding (M2 — JSON for M1).
**Next:** READY-FOR-SECURITY
