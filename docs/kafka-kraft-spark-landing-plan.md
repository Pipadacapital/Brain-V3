# Redpanda → Apache Kafka (KRaft) + Spark-SS Bronze landing — plan

Branch `feat/kafka-kraft-spark-landing` (off master, parallel to the StarRocks→Trino PR). Two coupled changes to the ingestion path; Bronze/Silver business logic unchanged.

## Current state (recon)
- **Broker**: `redpanda` compose service (profiles:[ingest]), dual listeners PLAINTEXT localhost:9092 + EXTERNAL 19092 (`brain-redpanda-ext`, for kind/k8s); `redpanda-topic-init` creates topics via `rpk`; Apicurio schema registry; all kafkajs clients use `KAFKA_BROKERS` (localhost:9092).
- **Bronze landing TODAY**: ADR-0006 Kafka Connect Iceberg sinks (`infra/kafka-connect/iceberg-bronze-*.json` + `kafka-connect`/`kafka-connect-init` compose) land raw topics → `brain_bronze.*_raw`. The Spark-SS sink (`db/iceberg/spark/bronze_materialize.py` + `spark-bronze-sink` compose) still exists (collector lane; readStream→foreachBatch→idempotent Iceberg MERGE, checkpoint, two-phase startup, offset-after-commit).

## Target (user directive)
1. **Replace Redpanda with Apache Kafka (KRaft)** — single-node KRaft broker (apache/kafka), same dual-listener scheme (host 9092 + external 19092), topic-init via kafka CLI, Apicurio preserved. Clients unchanged (KAFKA_BROKERS).
2. **Bronze landing → Spark Structured Streaming (sole), retire Kafka Connect** — Spark SS reads every lane (collector.event.v1 + the connector *.raw.v1 lanes) → append-only Iceberg Bronze with ingestion metadata (topic/partition/offset/received_at/written_at/trace_id), checkpoint, **commit Kafka offset only after the Iceberg commit**. NO business logic before Bronze. Retire the Kafka Connect sinks + configs + compose services.

## Waves
- **K1 — Kafka KRaft**: swap the redpanda compose service for an apache/kafka KRaft broker (combined controller+broker, single node) preserving both listeners + advertised addrs; port topic-init to kafka CLI; keep Apicurio; config/env unchanged where possible. Verify compose parses + a client can connect/produce/consume.
- **K2 — Spark-SS landing (sole)**: a generic raw-landing Spark-SS job for the *.raw.v1 connector lanes → *_raw (verbatim payload + ingestion metadata, append-only, checkpoint, offset-after-Iceberg-commit), alongside the hardened collector-lane bronze_materialize.py. Retire the Kafka Connect iceberg-bronze-*.json + kafka-connect/kafka-connect-init compose. Wire the Spark landing into compose + run scripts.
  - **K2b DONE (2026-06-28):** `db/iceberg/spark/bronze_raw_landing.py` (generic, `LANES` config table → 9 lanes, single stream routes by topic, idempotent MERGE on `(topic,partition,offset)`, two-phase startup) + `run-bronze-raw-landing.sh` + the `spark-bronze-raw-sink` compose service (replaces `kafka-connect`). Removed: `infra/kafka-connect/iceberg-bronze-*.json` (10 files), `kafka-connect` + `kafka-connect-init` services, `brain-connect-plugins` volume. ADR-0006 D1 marked superseded; runbook + P4 design pack annotated. `py_compile` + 7 pure-python lane-config tests green; `docker compose config` valid.
