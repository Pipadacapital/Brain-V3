# ADR-0015 — Direct-to-log ingest, two-layer dedup, and Silver-layer identity resolution (40K/sec-ready)

- **Status:** Proposed (2026-07-17)
- **Amends:** ADR-0010 (Bronze single-writer), ADR-0012 (adds Bronze compaction dedup)
- **Reinforces:** ADR-0004 (Neo4j is identity SoR), ADR-0006 (Redpanda log)
- **Deciders:** Owner + platform
- **Target scale:** ~40K events/sec by month-8 (60 brands onboarded over 8 months), ~1 KB/event.

## Context

The ingestion + identity path has drifted from the intended medallion, and will not carry 40K/sec cleanly:

1. **Double buffering.** The collector writes every event to a Postgres spool (`collector_spool`) and a background drainer later produces to the log. At 40K/sec (~40 MB/s) Postgres becomes a write-then-delete churn buffer it is not built to be.
2. **Identity resolved off the stream.** `stream-worker`'s `IdentityBridgeConsumer` resolves identity directly from the Kafka/collector event stream and writes Neo4j. This wires Neo4j to the ingestion path, contradicting the intended flow where identity is a **Silver-layer** step.
3. **Two Bronze writers.** `CollectorEventConsumer` (stream-worker) writes Bronze in parallel with the Kafka Connect Iceberg sink (ADR-0010). There must be exactly one Bronze writer.
4. **Dedup only in Silver.** Current doctrine dedups only at Silver; the owner requires **no duplicate rows in any queried store, including Bronze**.

## Decision

**D1 — Collector produces directly to the log.**
The collector's accept path produces straight to Redpanda with an idempotent producer (`acks=all`). The produce-ack is the durability anchor. A **bounded local-disk fallback** on the collector pod preserves the fire-and-forget (pixel) no-retry guarantee during a total log outage. **Delete** the Postgres spool, drainer, reaper, and the PG ingest-dedup gate.

**D2 — Two-layer dedup (amends ADR-0012 and the "dedup only in Silver" doctrine).**
- (a) **Idempotent + transactional producer** and **exactly-once Connect sink** eliminate delivery/retry duplicates.
- (b) **Bronze compaction-time dedup** on `(brand_id, event_id)` (keep-latest) runs in the PyIceberg maintenance tier, so Bronze converges to zero-duplicate within each compaction cycle while writes stay append-fast.
- (c) **Silver `MERGE`** on `(brand_id, event_id)` remains the final backstop.
Net: Silver/Gold are always duplicate-free; Bronze is physically deduplicated within a compaction cycle.

**D3 — Single Bronze writer.**
The Kafka Connect Iceberg sink is the **sole** Bronze writer (ADR-0010 stands). Remove stream-worker's parallel Bronze write (`CollectorEventConsumer` + `infrastructure/pg/BronzeRepository`).

**D4 — All sources land in Bronze.**
Pixel events and connector/webhook events land in Bronze through the same path (collector → log → Connect → Bronze). Server-trusted event bridges become part of the single Bronze-landing path, not a second writer.

**D5 — Identity resolution moves to the Silver layer.**
Identity is a **transform-tier step invoked from Silver**. Neo4j is a Silver dependency, called **only** from the transform tier — never from the collector, the log, or Bronze. Remove `IdentityBridgeConsumer`, `IdentityChangeRecomputeConsumer`, `RestitchDirtyConsumer`, `JourneyReversionDirtyConsumer`, `ConsentSuppressorConsumer`, and `AnalyticsCacheInvalidateConsumer` from the streaming path. The deterministic matching logic (`IdentityResolver`, `Neo4jIdentityRepository`, `ConfidenceEngine`, matchers) is **preserved** and re-invoked as a batch Silver stage over new canonical rows (watermark-driven), fronted by an `identifier_hash → brain_id` cache so only first-seen identifiers hit the graph.

**D6 — Canonical flow.**
```
All sources → Bronze (raw, deduped) → Silver (canonical) → identity (Neo4j) → Gold (Customer 360 + BI Mart)
```

**D7 — Retention tiering (infra deferred).**
Bronze raw 15 days; Silver detail 30 days; Gold aggregates 12 months. Long retention lives on the small aggregated layer, not raw. Concrete S3/Glacier tiering and sizing are a later Terraform/config change.

## Consequences

**Positive**
- Ingest edge is simpler and cheaper; one durable buffer (the log), not two.
- Medallion is pure: identity is a Silver step; Neo4j is never on the ingestion path.
- No duplicates in any queried store; Bronze converges to zero-dupe.
- One Bronze writer removes a whole class of double-write drift.
- Retention tiering makes the 40K/sec data volume affordable.

**Negative / risks**
- Identity latency moves from near-real-time to batch (≤5 min, matching the serving cadence). Acceptable — serving is already 5-min batch.
- **Consent projection / CAPI recording latency (M3).** The consent-suppressor and CAPI-deletion lanes moved off the stream into the Silver identity stage, so a consent grant/withdrawal or CAPI retroactive-deletion trigger is now projected at refresh cadence plus watermark lag (≤ ~5 min end-to-end) instead of seconds. Accepted — it mirrors the serving posture above, and the erasure lane (the compliance-critical path) is unaffected: RTBF triggers ride the PG request queue directly, not the refresh cycle.
- **Consent events that fail Silver admission are quarantined, not projected.** A consent-revocation event rejected at the Bronze→Silver gate lands in `brain_silver.silver_quarantine` and never reaches the identity/consent stage on its own. The replay path is the established one (fix the rule → re-run the Silver job with `FULL_REFRESH=1`, per `docs/runbooks/rerun-medallion.md`), BUT replayed rows keep their ORIGINAL `ingested_at` — below the silver-identity watermark — so the catch-up window will not see them: **quarantine replay of consent-bearing rows MUST be followed by a widened-lookback silver-identity run** (operational rule recorded in the runbook, §"Quarantine replay and the Silver identity stage"). Bronze retains every original, so a Bronze-vs-projected consent reconciliation remains possible at any time.
- Large removal surface in `stream-worker` (several consumers). Mitigated by preserving the domain logic and moving invocation, not rewriting it.
- Neo4j effective write rate must stay bounded — mitigated by the identifier cache (§ identity), escalating to per-brand Neo4j shards only if a single brand saturates.
- Amends ADR-0012: transport is at-least-once; exactly-once is achieved by dedup layers, not by the transport alone.

**WAL durability posture (edge case #1, decided: drain + alert — not PVC/StatefulSet).**
The local-disk fallback WAL is pod-local by design. Voluntary terminations (deploys, Spot reclaim, node consolidation) are covered by the SIGTERM drain: the collector fails readiness, closes HTTP, then runs one final WAL flush bounded by `INGEST_SHUTDOWN_FLUSH_TIMEOUT_MS` (default 10s) **before** the producer disconnects; anything unflushed survives on disk and is adopted on the next boot. The residual risk is a **hard node crash while Kafka is down AND the WAL is non-empty** — accepted, and made observable rather than silent: the `brain_collector_wal_oldest_entry_age_seconds` gauge drives alerts at >5 min (warning) and >30 min (critical), so the exposure window is always visible while it is open. A PVC/StatefulSet conversion was rejected: it would trade a rare, alerted, bounded-loss window for permanent scheduling stiffness (pod-to-volume pinning, slower failover, AZ-bound rescheduling) on the horizontally-scaled ingest edge — disproportionate weight for the residual window it would close.

## CI / doctrine updates
- Update `CLAUDE.md`: "dedup lives in Silver" → "dedup at Bronze compaction **and** Silver"; add "identity is resolved in the Silver transform stage; Neo4j is never wired to the collector, log, or Bronze."
- Add a `tools/lint/v4-naming-guard.sh` rule forbidding any `stream-worker` Kafka consumer that imports the Neo4j identity repository (prevents regression of D5).
- Amend ADR-0010 note to record the single-writer consolidation; amend ADR-0012 to record the compaction-dedup layer.
