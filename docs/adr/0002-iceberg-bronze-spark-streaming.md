# ADR-0002 — Bronze system-of-record on Apache Iceberg, written by Spark Structured Streaming

> **SUPERSEDED-IN-PART (2026-06-28, Brain V4) — the serving pipeline below is obsolete; the Iceberg-Bronze core principle stands.**
> This ADR's load-bearing decision ("Bronze = Apache Iceberg, system of record") is **still in force**. What is obsolete is the downstream shape its Context names as the target: **`Iceberg → dbt → StarRocks → Analytics API`**. Under Brain V4 **dbt and StarRocks are REMOVED**: Spark-on-Iceberg is the **sole** compute (Silver/Gold are Spark marts in `brain_{silver,gold}_local`), and serving is **Trino-over-Iceberg fronted by Redis** (`brain_serving.mv_*` are Trino views — see [ADR-0007](0007-analytics-gateway.md)). The Bronze **writer** mechanism evolved per [ADR-0006](0006-redpanda-native-bronze-kafka-connect-iceberg.md) (currently Spark-SS again after the K2b revert). Read the Context's `dbt`/`StarRocks` references as historical target-state, not live architecture.

Status: **Accepted** (2026-06-21) — serving pipeline (dbt/StarRocks) superseded by Brain V4 (Spark sole compute + Trino serving); see banner.
Supersedes the M1 D-4 fallback recorded in `db/migrations/0016_bronze_events.sql` and resolves audit finding C1 in `docs/audit/05-data-platform.md`.

## Context

Brain's core rule is **"Bronze is source of truth"** (CLAUDE.md). The target architecture (STACK.md ADR-002/003, docs 03/07) is **Bronze = Apache Iceberg on S3 + a catalog (prod: AWS Glue; dev: a local Iceberg REST catalog), one-way `Iceberg → dbt → StarRocks → Analytics API`**.

In M1 this was deliberately deferred (a pre-authorised "D-4 fallback"): Bronze is a **Postgres table `bronze_events`**, written by a hand-rolled TypeScript `INSERT … ON CONFLICT (brand_id, event_id) DO NOTHING` in the stream-worker's `BronzeRepository`. The deferral was never disclosed in docs 03/07, which still read as if Iceberg shipped — audit finding C1.

What already exists (no cold start):
- Iceberg Bronze DDL + machine spec + schema-evolution policy — `db/iceberg/`.
- StarRocks external-Iceberg catalog SQL (local + prod) — `db/starrocks/external_iceberg_catalog.sql`.
- dbt `db/dbt/models/staging/_sources.yml` is a single documented swap boundary; staging + marts are source-agnostic.
- AWS IaC applied in dev + staging — `infra/terraform/modules/s3-iceberg`: S3 Bronze bucket (Object-Lock COMPLIANCE 7-yr, SSE-KMS, 24-month TTL), Glue DB, and NN-5 per-brand-prefix IRSA roles.

What is missing: **any Iceberg writer at all**, a working local Iceberg catalog (the `nessie:0.90.2` image is unpullable), and Iceberg maintenance (compaction / snapshot-expiry) jobs.

## Decision

1. **Writer mechanism: Apache Spark Structured Streaming.** A Spark streaming job consumes the **existing** `{env}.collector.event.v1` Redpanda topic and writes the Iceberg Bronze table `brain_bronze.collector_events` with an idempotent `MERGE INTO … WHEN NOT MATCHED THEN INSERT` keyed on `(brand_id, event_id)`, checkpointing to S3. This matches the replay procedure already written in `db/iceberg/schema-evolution-policy.md`.
   - Spark is the STACK Phase-3-sanctioned batch/maintenance compute tier (STACK.md "Phase 3 … add Apache Spark (batch/heavy transforms/Iceberg maintenance)"). It does **not** add one of the four fixed application deployables (I-E05) — it runs as Argo/Spark-on-K8s jobs.
   - The same Spark toolchain also runs the Iceberg-maintenance jobs (compaction, snapshot expiry, and later erasure-aware compaction).

2. **Additive dual-sink, not an in-place rewrite.** The Spark job is a **new, independent consumer** of the topic the stream-worker already consumes. The live `stream-worker → Postgres bronze_events` write is **not modified** by this epic until the final retirement slice. Both sinks are fed from the same topic, independently.

3. **Parity-gated, reversible cut-over.** Postgres Bronze and Iceberg Bronze run side by side; the existing DQ `reconciliation-check` and `bronze-ledger-provenance-check` are extended into a **parity oracle** (PG ≡ Iceberg, row-for-row, replay-equivalent). Readers move only after parity holds, one family at a time, each behind a flag:
   - **analytics-tier readers** first (swap `_sources.yml` to the Iceberg external catalog — the pre-built path),
   - then **operational/direct-PG readers** (route core analytics reads through the Analytics API, restoring the "one read path" invariant),
   - and the Postgres write is retired **last**, only after both reader families bake green.

## Phased rollout (each step = one EOS `feat-*`, independently shippable and reversible)

| # | Slice | Reversal |
|---|---|---|
| 0 | This ADR + reconcile docs 03/07 + runbook (no production code) | delete docs |
| 1 | Fix the local lakehouse — working Iceberg REST catalog + MinIO + a local Spark container; `pnpm dev:lakehouse` boots | drop profile |
| 2 | Spark write-path spike — materialize the topic → Iceberg in dev; validate DDL/partitioning/MERGE | delete job |
| 3 | Dual-sink in dev/staging + extend the DQ parity oracle (flag off by default) | flag off |
| 4 | Flip analytics readers — `_sources.yml` → Iceberg external catalog; marts rebuild from Iceberg | revert one file |
| 5 | Flip operational readers — core analytics direct-PG reads → Analytics API | flag |
| 6 | Retire the Postgres Bronze write (only after 4+5 bake green) | re-enable write |
| 7 | Iceberg TTL + compaction + erasure-aware compaction (unblocks D13 right-to-erasure conformance) | n/a |

## Consequences

- **Positive:** the live ingest write path is untouched for slices 0–5 (lowest possible blast radius); parity is proven on real data before any reader moves; the read side is ~95% pre-built so reader cut-over is small; Spark gives us Iceberg maintenance + large backfill/replay in one toolchain; closes audit C1 and lets us truthfully claim Iceberg-SoR.
- **Negative / cost:** Spark is net-new compute to operate (Spark-on-K8s/EMR + S3 checkpoints) and to stand up in dev; a transitional period writes Bronze twice (Postgres + Iceberg) until slice 6.
- **Erasure dependency:** full I-S05 right-to-erasure conformance remains gated on slice 7 (erasure-aware Iceberg compaction); until then crypto-shred of plaintext PII is the DPDP-sufficient interim (see `docs/data-collection-platform/13-security-privacy-and-roadmap.md`).

## Alternatives considered

- **Redpanda native Iceberg Topics** (the STACK "no hand-rolled writers" preference): least code, no new compute. Not chosen as primary because it couples the write format to Redpanda-Cloud feature/version availability and is harder to reach dev/prod parity for; Spark gives more control over partitioning/commit semantics and doubles as the maintenance engine. Revisit if Spark operating cost proves unjustified.
- **Kafka Connect / Flink Iceberg sink:** viable managed sink, but adds a connector/job to operate without giving us the batch/backfill/compaction engine Spark also provides.
- **In-worker writer (PyIceberg / Node Iceberg lib):** fastest to a parity test, stays in the four deployables, but is exactly the "hand-rolled writer" STACK.md warns against and couples Bronze durability to the live consumer. Fallback only.
