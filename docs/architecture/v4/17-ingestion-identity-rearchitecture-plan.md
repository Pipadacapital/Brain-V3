# Ingestion & Identity Re-architecture — Implementation Plan (40K/sec-ready)

**Companion to ADR-0015.** Scope: correct the architecture and existing functionality (code/data-platform).
Infra sizing, Terraform, and cost tiering are a **later** change and are out of scope here.

Target flow:
```
Pixel + connector/webhook events
        → Collector (produce direct to log)
        → Redpanda (durable buffer + replay)
        → Kafka Connect  → BRONZE (raw, single writer, compaction-deduped)
        → Silver (canonicalize; MERGE dedup)
        → Identity stage (reads Silver, resolves via Neo4j, writes silver_identity_map)
        → Gold (Customer 360 + BI Mart)
        → duckdb-serving + Redis → dashboards
```

Principle: **preserve domain logic, move invocation.** Delete transport/buffering plumbing; keep matchers, resolvers, mappers.

---

## Workstream 1 — Collector produces directly to the log (delete the spool)

**Delete**
- `apps/collector/src/application/drain-events.usecase.ts`
- `apps/collector/src/interfaces/jobs/drainer.ts`
- `apps/collector/src/infrastructure/pg-spool.repository.ts`
- `apps/collector/src/infrastructure/ingest-dedup.repository.ts`
- `apps/collector/src/domain/ingest/repositories/spool.repository.ts`
- `apps/collector/src/domain/ingest/entities/spool-entry.ts`
- DB migration: `DROP TABLE collector_spool`, `DROP` ingest-dedup helpers/table.

**Modify**
- `apps/collector/src/application/accept-event.usecase.ts` — replace `spool.insert()` with `producer.produce()` (idempotent, `acks=all`). Keep `stampEnvelope` (received_at) as the only pre-produce transform.
- `apps/collector/src/infrastructure/kafka-producer.ts` — becomes the hot path; ensure idempotent producer config, batching, key = `brand_id`.
- `apps/collector/src/interfaces/rest/collect.route.ts` — unchanged public contract (`/collect`, `/v1/events`, `/batch`); ACK now fires after produce-ack.
- `apps/collector/src/interfaces/rest/spool-backpressure.ts` → rework into **producer backpressure**: `503 + Retry-After` when the local-disk fallback is saturated AND the log is unreachable.
- `apps/collector/src/main.ts` — remove drainer + reaper wiring; wire producer into the accept path; add bounded local-disk fallback flush-on-reconnect.

**Add**
- Bounded on-pod disk WAL (append file) + flusher for the "log unreachable" window.

**Flag:** `INGEST_DIRECT_TO_LOG` (default off → on at cutover). Keep spool code paths dormant until Phase exit, then delete.
**Tests:** produce-on-accept unit; broker-restart chaos (zero loss); backpressure 503 path; p99 ACK < 50 ms at load.
**Rollback:** flag off → spool path (until deletion commit).

---

## Workstream 2 — Two-layer dedup (no duplicates anywhere)

**Producer / sink (delivery dupes)**
- Enable idempotent + transactional producer in `kafka-producer.ts`.
- Configure Kafka Connect Iceberg sink for exactly-once delivery (`infra/kafka-connect/iceberg-bronze-*.json`).

**Bronze compaction dedup (application dupes)**
- Add `db/iceberg/duckdb/maintenance/bronze_dedup.py` — keep-latest on `(brand_id, event_id)` during the compaction cycle (COW rewrite, no MoR delete storm). Schedule alongside existing compaction.
- Gate with `maintenance_capability_probe.py`.

**Silver backstop (already present)**
- Confirm `db/iceberg/duckdb/silver/silver_collector_event.py` keystone keeps `MERGE` on `(brand_id, event_id)`.

**Tests:** inject duplicate `event_id`s → assert Bronze zero-dupe post-compaction and Silver zero-dupe always; money/counters unaffected.

---

## Workstream 3 — Single Bronze writer; all sources land in Bronze

**Remove the second Bronze writer**
- Delete `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts` Bronze-write path and `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts`.
- `apps/stream-worker/src/interfaces/consumers/bronzeBridges.ts` / `EventBronzeBridgeConsumer.ts` — server-trusted event names fold into the single Kafka Connect landing (a lightweight producer that re-emits the trusted event onto the log for Connect to land), **not** a direct Bronze write.

**Confirm all sources — two entry patterns, one landing tail**
Connectors split by how data arrives; both converge on `log → Connect → Bronze`:

| Source | Pattern | Entry point | Lands via |
|---|---|---|---|
| Pixel | browser push | Collector `POST /collect` | log → Connect → Bronze |
| Shopify webhooks, GoKwik, Shopflo, Shiprocket, Razorpay | provider push | Collector (webhook endpoint) | log → Connect → Bronze |
| Meta Ads, Google Ads, GA4, historical backfills | **pull** (scheduled API poll) | **stream-worker fetch jobs** (`jobs/meta-spend-repull`, `google-ads-spend-repull`, `ga4-repull`, `shopify-backfill`…) | log → Connect → Bronze |

- The collector handles **inbound HTTP only** (pixels + push webhooks). API-pull connectors are **not** routed through the collector — nothing is pushed, so scheduled worker jobs fetch them.
- **Route pull jobs through the log.** Today some pull jobs write Bronze via a direct `jobs/ingestion-backfill/sinks.ts` writer. Change these to **produce to the log** (raw connector lanes already exist: `iceberg-bronze-meta-spend.json`, `google-spend`, `ga4-rows`, …) so Kafka Connect remains the single Bronze writer. No pull job writes Bronze directly.
- Verify the 9 raw connector lanes + collector lane all land via Connect (`infra/kafka-connect/`); no bypass writers remain.

**Invariant:** Kafka Connect is the only process that writes Bronze — regardless of whether the source was pushed (collector) or pulled (stream-worker fetch job).

---

## Workstream 4 — Identity resolution moves to the Silver layer

**Remove from the streaming path (stream-worker)**
- `identity-bridge/IdentityBridgeConsumer.ts`
- `interfaces/consumers/IdentityChangeRecomputeConsumer.ts`
- `interfaces/consumers/RestitchDirtyConsumer.ts`
- `interfaces/consumers/JourneyReversionDirtyConsumer.ts`
- `interfaces/consumers/ConsentSuppressorConsumer.ts`
- `interfaces/consumers/AnalyticsCacheInvalidateConsumer.ts`
- `touchpoint-cache/TouchpointCacheConsumer.ts` (relocate cache seed into the identity stage)
- Remove the identity/consent Kafka publishers from `main.ts` consumer wiring.

**Preserve (domain logic — do NOT rewrite)**
- `domain/identity/IdentityResolver.ts`, `matchers/*`, `confidence/*`, `IdentityEventPublisher.ts`
- `infrastructure/neo4j/Neo4jIdentityRepository.ts`
- `application/BatchResolveIdentityUseCase.ts`, `application/ResolveIdentityUseCase.ts`, `application/ProjectConsentUseCase.ts`

**Add the Silver identity stage**
- New batch job (Node, reusing `BatchResolveIdentityUseCase`) that:
  1. reads **new canonical Silver rows** since a watermark (the existing `silver_job_watermark` pattern),
  2. resolves identities against **Neo4j**, fronted by an `identifier_hash → brain_id` cache (Redis + in-process LRU; reuse `RedisDedupAdapter` / `BrainIdResolver`),
  3. writes `silver_identity_map` (job already exists: `db/iceberg/duckdb/silver/silver_identity_map.py`) and the alias graph to Neo4j,
  4. writes merge/suppress dirty-sets to the existing `ops.*_pending` tables; Gold `customer_360` recompute drains them,
  5. directly evicts brand-scoped Redis serving-cache keys (replaces the `cache.invalidate.v1` consumer).
- Consent projection folds into Silver canonicalization (`ProjectConsentUseCase` invoked in the Silver stage, not off the log).

**Ordering** — extend `tools/dev/duckdb-refresh.sh`:
```
keystone → silver passes → IDENTITY STAGE (Neo4j) → gold (toposorted)
```

**stream-worker after this workstream** = connector pull-job runner (`jobs/**`: backfills, repulls, token refresh) + request-driven erasure/CAPI batch jobs. It is no longer a consumer group on the collector event stream.

**Tests:** `Bronze → Silver → Neo4j → Gold` e2e parity vs current identity output; cache hit-rate; no `stream-worker` Kafka→Neo4j path remains (new lint guard).

---

## Workstream 5 — Gold: Customer 360 + BI Mart from Silver + identity map

- `db/iceberg/duckdb/gold/gold_customer_360.py` — confirm it reads `silver_identity_map` (identity stage output) + Silver spines; enforce dependency ordering (identity stage before Gold).
- BI Mart = existing Gold marts (`gold_revenue_ledger`, `gold_revenue_analytics`, `gold_marketing_attribution`, `gold_attribution_*`, `gold_campaign_attribution`) — verify all resolve `brain_id` via the identity map, not any removed streaming path.
- Keep money = bigint minor units + `currency_code`; `brand_id`-first.

---

## Workstream 6 — Doctrine, CI, decommission

- **CLAUDE.md:** update dedup + identity doctrine per ADR-0015.
- **`tools/lint/v4-naming-guard.sh`:** add rule — no `stream-worker` Kafka consumer may import the Neo4j identity repo (forbids re-wiring identity to the log).
- **ADRs:** commit ADR-0015; amend notes on ADR-0010 (single writer) and ADR-0012 (compaction-dedup layer).
- **Decommission:** delete dormant spool + removed-consumer code once flags are default-on and e2e is green.

---

## Phasing & exit criteria

| Phase | Workstream(s) | Exit criteria |
|---|---|---|
| P1 | WS1 | Direct-to-log live behind flag; zero loss under broker-restart chaos; p99 ACK < 50 ms |
| P2 | WS2 + WS3 | Bronze single-writer; Bronze zero-dupe post-compaction; Silver zero-dupe always |
| P3 | WS4 | Identity fully in Silver; no log→Neo4j path; identity output parity vs baseline |
| P4 | WS5 | Customer 360 + BI Mart built from Silver + identity map; money byte-exact |
| P5 | WS6 | Doctrine/CI updated; dormant code deleted; owner promotes release → master |

Each phase ships via `feature/* → release → master`, flag-gated and reversible. Infra sizing/tiering (retention, Redpanda nodes, spot/elastic scaling) is a **separate later** Terraform/config workstream, per owner direction.

---

## Open items to confirm during P1

1. Local-disk fallback size/format on the collector pod (durability window during total log outage).
2. Whether the Silver identity stage runs as a Node batch step or is ported to Python in the DuckDB tier (recommendation: Node batch, to reuse tested `IdentityResolver`).
3. Consent/CAPI/erasure exact placement (Silver stage vs request-driven batch) — confirm per compliance owner.
4. **Deferred `collector_spool` drop (H1 rollout safety):** ✅ DONE (2026-07-18). Migration 0137 dropped only the drainer-only functions; the table was held one release boundary (old collector pods INSERT into it pre-ACK during the roll; a PreSync `DROP TABLE` = live pixel loss). After the direct-to-log collector image (sha256:e45a7cde…) was verified fully rolled in prod with zero spool INSERT traffic, the deferred SQL was promoted to `db/migrations/0141_drop_collector_spool.sql` and applied (prod dropped out-of-band ahead of the file; `DROP TABLE IF EXISTS` keeps the migration idempotent).
