# ADR-0006 — Bronze written directly from Redpanda via Kafka Connect (Iceberg Sink); raw Bronze; normalization + admission gate move to Spark Silver

> **SUPERSEDED-IN-PART (2026-06-28, task K2b) — the WRITER reverted to Spark Structured Streaming; Kafka Connect is retired.**
> Decision **D1** (Kafka Connect + Apache Iceberg Sink as the Bronze writer) is **withdrawn**. The user reverted to **Spark-SS landing** so there is exactly ONE compute (Spark) and no extra Connect infra to operate. The raw `*.raw.v1` connector lanes are now landed by a generic Spark-SS job, `db/iceberg/spark/bronze_raw_landing.py` (the `spark-bronze-raw-sink` compose service + `db/iceberg/spark/run-bronze-raw-landing.sh`): one streaming query subscribes to all nine lanes and appends each provider record **verbatim** into `brain_bronze.<lane>_raw` with ingestion metadata (brand_id from the server-trusted envelope, topic/partition/offset, kafka ts, received_at, written_at, trace_id), checkpointed, **offset committed only after the durable Iceberg write** (no data loss), idempotent on the Kafka coordinate `(topic,partition,offset)` so replays never double-write.
> **Everything else in this ADR stands**: D2 (Bronze is TRULY RAW — no business logic before Bronze), D3 (normalization moves to Spark Silver; connectors emit raw provider payloads), D4 (raw-PII retention posture), the **Bronze raw table contract**, and the Silver gate+normalize design are all unchanged — only *how Bronze is written* flipped back from Kafka Connect to Spark-SS. Removed in this revert: `infra/kafka-connect/iceberg-bronze-*.json`, the `kafka-connect` + `kafka-connect-init` compose services, and the `brain-connect-plugins` volume. (The collector/pixel lane was always a Spark sink — `bronze_materialize.py` — and is untouched.) The Bronze raw table contract is deliberately writer-agnostic, so this revert is a writer swap, not a Silver rewrite. See `docs/runbooks/adr-0006-cutover-and-prod.md` for the updated operational shape.

Status: **Accepted** (2026-06-27) — supersedes the writer mechanism of [ADR-0002](0002-iceberg-bronze-spark-streaming.md) (Spark Structured Streaming Bronze sink). ADR-0002's "Bronze = Iceberg, one-way Iceberg→serving" principle stands; only **how Bronze is written** and **where normalization + the admission gate live** change.

## Context

Today (V4) the Kafka→Bronze hop is a hand-rolled **Spark Structured Streaming** job (`db/iceberg/spark/bronze_materialize.py`, the `spark-bronze-sink` service). It consumes `{env}.collector.event.v1` (+ the backfill lane), and in ONE job does three things:

1. **Admission gate (R2/R3)** — R2: resolve `install_token → brand_id` (pixel lane) and quarantine tenant-unresolved events; R3: require a `consent_flags` envelope or quarantine. Server-trusted lanes (`order.live.v1`, `spend.live.v1`, shipment/AWB) bypass R2/R3.
2. **Projection / partial canonicalization** — project the envelope into the `collector_events` Bronze columns.
3. **Idempotent `MERGE`** into `brain_bronze.collector_events` keyed on `(brand_id, event_id)`.

Two structural problems with this:

- **The Spark sink is a hand-rolled stateful streaming writer.** Its checkpoint is a durable volume/object path; an unclean kill leaves a half-written checkpoint and the job crash-loops on "Incomplete log file" (fixed defensively in `bronze_materialize.py` 2026-06-27, but the whole *class* of checkpoint/OOM fragility is inherent to running our own streaming sink).
- **Connector events are pre-normalized in TypeScript** before they ever reach Bronze (the connector mappers emit a canonical `order.live.v1`), so Bronze is **not raw** for connector sources — it's already canonical. This violates the medallion ideal ("Bronze = raw, Silver = normalized") and scatters normalization across TS connector code instead of the governed Spark transform layer.

## Decision

Adopt the medallion-canonical shape end to end:

```
Sources → Collector / Connector Runtime (emit RAW provider events)
  → Redpanda (raw topics)
  → Kafka Connect + Apache Iceberg Sink connector   ← REPLACES the Spark Bronze sink
  → Iceberg Bronze  (TRULY RAW, multi-source, append-only, short retention)
  → Spark Silver    (NORMALIZE raw → canonical entities + APPLY the R2/R3 admission gate + dedup)
  → Iceberg Silver  (normalized, gated, deduped — the first durable/compliant layer)
  → Spark Gold → Iceberg Gold → StarRocks mv_* → BFF / APIs
```

### D1 — Writer: Apache Iceberg **Kafka Connect Sink** (open-source), not Spark, not Redpanda-native.
- Redpanda **native Iceberg Topics** require **v25.1+ AND an Enterprise license** (this cluster is v24.1.7, unlicensed). Rejected for now on licensing/version grounds; revisit if/when the cluster moves to licensed v25.1+ (the Bronze-table contract below is chosen to make that swap a config change, not a rewrite).
- The **Apache Iceberg Kafka Connect sink** (`org.apache.iceberg.connect.IcebergSinkConnector`, donated from Tabular, Apache-licensed) is the chosen direct writer: it runs on the **current** Redpanda over the Kafka API, no license. Its commit protocol ties Kafka offset commits to Iceberg snapshot commits via a coordinator (exactly-once append), so there is **no app-managed streaming checkpoint** — the checkpoint-corruption class of bug disappears.
- Local: a `kafka-connect` compose service (Connect worker + the iceberg-connect plugin) against the local Iceberg REST catalog + MinIO. Prod: MSK Connect or self-managed Kafka Connect on EKS against Glue + S3.

### D2 — Bronze is **TRULY RAW**. The R2/R3 admission gate **moves to Spark Silver.**
- The Iceberg sink does **no** gating and **no** canonicalization. Every topic record lands in Bronze as-is (value fields + Kafka metadata `topic/partition/offset/timestamp/key`).
- The **R2 (tenant) + R3 (consent) gate moves into the Bronze→Silver Spark step.** Silver resolves `install_token → brand_id`, drops/routes consent-absent records to a `*_quarantine` Silver table, and only emits gated rows downstream. Server-trusted lanes keep their `brand_id` as-is (no install_token), exactly as today.
- **Dedup moves to Silver too** — the Bronze sink appends (no MERGE), so Silver dedups on the natural key (`event_id` / `order_id`) using the Kafka `offset`/`timestamp` for last-writer determinism.

### D3 — **Normalization moves to Spark Silver.** Connectors emit **raw provider payloads.**
- Each connector stops mapping to a canonical event in TS. It emits the **raw provider object** (raw Shopify/Woo order JSON, raw GA4 row, etc.) to a per-source raw topic, carrying only a thin **server-trusted envelope** (`brand_id`, `source`, `resource`, `connector_instance_id`, `fetched_at`) — the brand authority stays server-side (MT-1), never from the provider body.
- The normalization currently in the TS mapper packages (`@brain/shopify-mapper`, `@brain/woocommerce-mapper`, `@brain/gokwik-mapper`, …) is **ported to PySpark** in the Silver layer. One canonical Silver schema per entity, fed by per-source normalizers — multi-source unification happens in Spark, from raw, exactly per the diagram.
- The pixel lane is already raw in Bronze (collector events) → Silver already normalizes it; this just generalizes the pattern to every source.

### D4 — Compliance posture for raw PII in Bronze (the cost of D2).
Because the consent gate now runs in Silver, **non-consented PII can transiently land in raw Bronze.** Mitigations (mandatory, tracked in COMPLIANCE.md):
- **Short retention** on raw Bronze tables — Iceberg snapshot-expiry + a hard table TTL (target **7 days**, configurable per region/regime). Raw Bronze is a transient landing buffer; **Silver (gated) is the durable layer.**
- **RTBF / erasure** tooling must cover raw Bronze tables (the existing erase jobs extend to the raw namespace).
- This is a deliberate posture change from "consent-gated before Bronze" to "consent-gated before the durable layer (Silver), raw buffer expns fast." Recorded here for Security-Reviewer sign-off; gate the prod flip on that sign-off.

### D5 — Retire the Spark Bronze sink. Keep Spark for Silver/Gold + Iceberg maintenance.
- `bronze_materialize.py`, the `spark-bronze-sink` service, and its Argo cron are removed **after** the Kafka Connect path is parity-verified.
- Spark remains the SOLE compute for Silver/Gold and Iceberg maintenance (ADR-0002/CLAUDE.md) — unchanged.

## Bronze raw table contract (the portability seam)
- One Bronze table **per logical source/topic** (e.g. `brain_bronze.collector_events_raw`, `brain_bronze.shopify_orders_raw`, …), schema derived from the topic's Avro (Apicurio) value schema + Kafka metadata columns.
- Partition spec: `bucket(N, brand_id)` where `brand_id` is in the envelope, + `days(_kafka_timestamp)`. Brand-first isolation preserved.
- This contract is identical to what Redpanda native Iceberg Topics would materialize → if the cluster later moves to licensed v25.1+, swapping Kafka Connect for native topics is a config change, not a Silver rewrite.

## Phased migration plan (each phase independently shippable + reversible)
- **P0 (this ADR)** — design + decisions.
- **P1 — Infra**: add the `kafka-connect` service + Iceberg sink plugin to compose; register one connector on the **pixel `collector.event.v1`** lane → `brain_bronze.collector_events_raw`. Prove raw events land in Iceberg **without Spark**. (Spark sink still runs in parallel — no cutover yet.)
- **P2 — Silver gate+normalize for the pixel lane**: move R2/R3 + dedup into the pixel Silver job, reading `collector_events_raw`. Parity-check vs the current `collector_events` → Silver path.
- **P3 — Cut the pixel lane over**: point Silver at `*_raw`; retire the pixel leg of the Spark sink.
- **P4 — Connectors emit raw**: one source at a time (Shopify first), emit raw provider payload → raw topic → Connect → Bronze; port that source's TS normalizer to PySpark Silver; parity-check; cut over; retire the TS mapper.
- **P5 — Retire the Spark Bronze sink** entirely (D5) once all lanes are on Connect.
- **P6 — Prod**: MSK Connect / Connect-on-EKS + Glue/S3 config; retention/TTL on raw Bronze (D4); cut-over runbook with dual-run parity gates; Security-Reviewer sign-off on D4.

## Consequences
- **+** No app-managed Bronze streaming checkpoint → the checkpoint/OOM fragility class is gone. Bronze is genuinely raw + multi-source. Normalization is governed in one place (Spark Silver) instead of scattered TS mappers.
- **−** A new infra component (Kafka Connect). Normalization logic must be re-implemented in PySpark (large, per-source). Transient raw PII in Bronze needs the D4 retention + sign-off. Silver gets heavier (gate + normalize + dedup).
- **Rollback**: each phase keeps the old path until parity passes; reverting is repointing Silver at the canonical topic/`collector_events` and re-enabling the Spark sink leg.

## Open items
- D4 retention value + Security-Reviewer sign-off (blocks the prod flip).
- Per-source normalizer parity oracles (Silver-from-raw must equal today's canonical Silver byte-for-byte on money + identity fields).
