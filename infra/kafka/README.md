# Kafka — Topic Strategy, Retention, Replay, and Isolation

## Topic naming convention

```
{env}.{domain}.{event}.v{n}
```

| Component | Values | Notes |
|-----------|--------|-------|
| `env` | `dev`, `staging`, `prod` | Kept in the topic name for multi-env clusters and debugging |
| `domain` | `collector` | Phase 1 — all ingest events come through the collector domain |
| `event` | `event` | Generic Phase-1 event; per-event-type topics added in M1+ |
| `v{n}` | `v1`, `v2`, ... | Schema version embedded in the topic name |

## Topics (Phase 1)

| Topic | Lane | Partitions | Retention | Purpose |
|-------|------|-----------|-----------|---------|
| `{env}.collector.event.v1` | live | 12 | 7 days (604800000 ms) | Real-time ingest from Pixel/collectors |
| `{env}.collector.event.v1.backfill` | backfill | 12 | 30 days (2592000000 ms) | Historical replay; separate consumer group from live |

## Partition key strategy

The partition key is a **brand-prefixed composite**:

```
partition_key = brand_id + ":" + event_id
```

This guarantees:
1. All events for a single brand land in a consistent partition set (ordering within brand).
2. The partition key carries `brand_id` — no cross-brand data in a single partition key.
3. Dedup on `(brand_id, event_id)` is efficient (same partition = same consumer thread).

## Consumer group isolation

| Consumer group | Topic | Purpose |
|----------------|-------|---------|
| `brain.stream-worker.live` | `{env}.collector.event.v1` | Live enrichment → Bronze write |
| `brain.stream-worker.backfill` | `{env}.collector.event.v1.backfill` | Historical Bronze rebuild |

Live and backfill lanes are **separate consumer groups** — replay never disturbs live lag metrics.

## Replay strategy

Bronze (Iceberg on S3 + Glue) is the **replay system of record** (I-E02). Kafka topics are a
transport layer, not the SoR. Replay from Kafka is a convenience for the 7-day live window.
For replays beyond 7 days or for partial-partition re-runs, re-read from Iceberg Bronze directly
and produce to the backfill lane. The stream-worker processes both lanes identically — same code
path, no separate backfill codebase.

```
Replay from Bronze:
  1. Scan Iceberg Bronze partition(s) for the brand_id + date range.
  2. Produce events to dev.collector.event.v1.backfill (backfill consumer group).
  3. Stream-worker processes via the same validate→dedup→write pipeline.
  4. Duplicate rows are idempotent: Bronze uses MERGE ON (brand_id, event_id).
```

## Apicurio schema registry — FULL_TRANSITIVE

All Avro schemas are registered in Apicurio with `FULL_TRANSITIVE` compatibility. This means:
- Every new schema version must be both **forward** and **backward** compatible with ALL prior
  versions, not just the immediately preceding version.
- Only additive optional fields are permitted (never remove a field, never change a type).
- The collector validates the incoming payload against the registered schema before spooling.
- The stream-worker validates the deserialized Avro envelope against the registry on consume.

## Local dev

```bash
# Start ingest profile
docker compose --profile ingest up -d

# List topics (already created by kafka-init). Apache Kafka KRaft broker; the
# compose service/DNS name stays `kafka` but the image is apache/kafka.
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list

# Register a schema in Apicurio
curl -X POST http://localhost:8080/apis/registry/v2/groups/brain/artifacts \
  -H "Content-Type: application/json; artifactType=AVRO" \
  -H "X-Registry-ArtifactId: collector.event.v1" \
  -d @infra/kafka/schemas/collector.event.v1.avsc
```

## Production (self-hosted Strimzi Kafka on EKS)

Production topics are provisioned by Track C (`infra/helm/strimzi-kafka`).
Topic names follow the same `{env}.{domain}.{event}.v{n}` convention.
Credentials are injected at runtime via AWS Secrets Manager + IRSA (ADR-007).
The stream-worker reads the bootstrap URL and SASL credentials from the secret reference —
never from environment variables or the codebase.
