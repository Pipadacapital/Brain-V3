# Ingestion & Identity Re-architecture — Execution Plan (PR-by-PR)

**Companion to ADR-0015 and doc 17.** This is the build sheet: small, shippable, flag-gated PRs on `feature/* → release → master`. Every PR is independently reversible. Infra sizing/tiering is out of scope (later Terraform pass).

**Legend:** 🟢 additive/dormant (safe to merge anytime) · 🟡 behavior change behind flag · 🔴 deletion (only after soak) · **E** = rough eng-days.

**Global flags**
- `INGEST_DIRECT_TO_LOG` (collector produces to log instead of spool) — default `false` → `true` at P1 cutover.
- `IDENTITY_IN_SILVER` (identity resolved in Silver stage) — default `false` → `true` at P3 cutover.

---

## Phase 0 — Foundation (enables everything; no prod behavior change)

### PR 0.1 🟢 Load + duplicate harness — **E2**
- **Add** `tools/load/ingest-40k/` — k6/producer harness replaying a synthetic pixel+webhook stream at a configurable rate; a duplicate-injection mode (same `event_id` twice).
- **Reuse** `integration.yml` compose (Redpanda, Connect, Iceberg, DuckDB).
- **Accept:** harness sustains a target rate in staging; emits lag + dupe metrics.

### PR 0.2 🟢 ADR-0015 + doctrine stubs — **E1**
- **Add** ADR-0015 (already drafted). **Amend** notes on ADR-0010, ADR-0012.
- **Accept:** ADR ratified by owner.

---

## Phase 1 — Collector produces directly to the log

### PR 1.1 🟡 Idempotent producer hot-path + local-disk fallback — **E4**
- **Modify** `apps/collector/src/infrastructure/kafka-producer.ts` — idempotent producer (`enable.idempotence`, `acks=all`), batching, key = `brand_id`.
- **Modify** `apps/collector/src/application/accept-event.usecase.ts` — branch on `INGEST_DIRECT_TO_LOG`: `true` → `producer.produce()`; `false` → existing `spool.insert()`. Keep `stampEnvelope`.
- **Add** `apps/collector/src/infrastructure/local-disk-fallback.ts` — bounded append-file buffer + flush-on-reconnect (durability window during total log outage).
- **Rework** `apps/collector/src/interfaces/rest/spool-backpressure.ts` → producer backpressure (`503 + Retry-After` when fallback saturated AND log unreachable).
- **Modify** `apps/collector/src/main.ts` — wire producer into accept path; keep drainer alive while flag is off.
- **Modify** `packages/config/src/collector.ts` — add `INGEST_DIRECT_TO_LOG` + fallback size.
- **Tests:** produce-on-accept unit; broker-restart chaos (zero loss); fallback flush; backpressure 503; p99 ACK < 50 ms via PR 0.1 harness.
- **Accept:** flag on in staging → zero loss under broker restart; p99 ACK < 50 ms.
- **Rollback:** flag off (spool path intact).

### PR 1.2 🔴 Delete spool machinery — **E2** *(after PR 1.1 soaks flag-on in staging)*
- **Delete** `application/drain-events.usecase.ts`, `interfaces/jobs/drainer.ts`, `infrastructure/pg-spool.repository.ts`, `infrastructure/ingest-dedup.repository.ts`, `domain/ingest/repositories/spool.repository.ts`, `domain/ingest/entities/spool-entry.ts`.
- **Add migration** — `DROP TABLE collector_spool`; drop ingest-dedup table + `0130` helpers.
- **Modify** `main.ts` — remove drainer/reaper wiring; make `INGEST_DIRECT_TO_LOG` the only path.
- **Accept:** collector boots with no spool refs; e2e green; `knip` clean.

---

## Phase 2 — No duplicates + single Bronze writer

### PR 2.1 🟡 Idempotent/EOS transport — **E2**
- **Modify** `infra/kafka-connect/iceberg-bronze-*.json` — exactly-once delivery on the sink.
- **Verify** transactional producer settings (PR 1.1).
- **Accept:** harness delivery-dupe injection → zero delivery dupes in Bronze.

### PR 2.2 🟢 Bronze compaction dedup — **E3**
- **Add** `db/iceberg/duckdb/maintenance/bronze_dedup.py` — keep-latest on `(brand_id, event_id)`, COW rewrite (no MoR), gated by `maintenance_capability_probe.py`.
- **Schedule** alongside existing compaction in `cronworkflows`.
- **Tests:** inject application-dup `event_id`s → Bronze zero-dupe after one compaction cycle.
- **Accept:** Bronze `(brand_id,event_id)` unique post-compaction; money/counters unchanged.

### PR 2.3 🔴 Remove the second Bronze writer — **E3**
- **Delete** `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts` Bronze path + `infrastructure/pg/BronzeRepository.ts`.
- **Modify** `interfaces/consumers/bronzeBridges.ts` / `EventBronzeBridgeConsumer.ts` — server-trusted event names **re-emit onto the log** (for Connect to land), not a direct Bronze write.
- **Confirm** `db/iceberg/duckdb/silver/silver_collector_event.py` keeps `MERGE` on `(brand_id, event_id)`.
- **Accept:** Kafka Connect is the only Bronze writer; grep shows no other Bronze write; e2e green.

---

## Phase 3 — Identity resolution moves to the Silver layer

### PR 3.1 🟡 Silver identity stage (additive, flagged) — **E5**
- **Add** `apps/stream-worker/src/jobs/silver-identity/run.ts` — batch job (reuses `application/BatchResolveIdentityUseCase`) that:
  1. reads new canonical Silver rows since `silver_job_watermark`,
  2. resolves via **Neo4j** (`infrastructure/neo4j/Neo4jIdentityRepository`), fronted by an `identifier_hash → brain_id` cache (reuse `infrastructure/redis/RedisDedupAdapter` + `touchpoint-cache/BrainIdResolver`),
  3. writes `silver_identity_map` (`db/iceberg/duckdb/silver/silver_identity_map.py`) + alias graph,
  4. writes merge/suppress dirty-sets to `ops.*_pending`,
  5. directly evicts brand-scoped Redis serving-cache keys.
- **Preserve** all `domain/identity/**` logic (matchers, confidence, resolver) — invocation moves, logic unchanged.
- **Flag** `IDENTITY_IN_SILVER` (default off; job is inert until on).
- **Tests:** batch resolve unit (reuse existing suites); cache hit-rate; dirty-set writes.
- **Accept:** with flag on in staging, identity output parity vs current stream path.

### PR 3.2 🟢 Wire ordering — **E1**
- **Modify** `tools/dev/duckdb-refresh.sh` — insert `IDENTITY STAGE` between silver passes and gold: `keystone → silver → identity → gold`.
- **Accept:** refresh runs identity before Gold; `gold_customer_360` sees fresh `silver_identity_map`.

### PR 3.3 🔴 Remove identity/consent/cache consumers from the stream — **E3** *(after PR 3.1 soaks flag-on)*
- **Delete/unwire** from `apps/stream-worker/src/main.ts`: `IdentityBridgeConsumer`, `IdentityChangeRecomputeConsumer`, `RestitchDirtyConsumer`, `JourneyReversionDirtyConsumer`, `ConsentSuppressorConsumer`, `AnalyticsCacheInvalidateConsumer`, `TouchpointCacheConsumer`.
- **Fold** consent projection into the Silver stage (`application/ProjectConsentUseCase`).
- **Accept:** no `stream-worker` consumer reads the collector event stream for identity/consent; `knip` clean.

### PR 3.4 🟢 Route pull-connector jobs through the log — **E2**
- **Modify** `apps/stream-worker/src/jobs/ingestion-backfill/sinks.ts` + repull jobs (`meta-spend-repull`, `google-ads-spend-repull`, `ga4-repull`, `shopify-backfill`…) — **produce to the log's raw connector lanes** instead of writing Bronze directly.
- **Accept:** no pull job writes Bronze directly; all land via Connect.

---

## Phase 4 — Gold from Silver + identity map

### PR 4.1 🟢 Customer 360 + BI Mart wiring — **E2**
- **Confirm/modify** `db/iceberg/duckdb/gold/gold_customer_360.py` reads `silver_identity_map`; enforce identity-before-Gold ordering.
- **Confirm** BI marts (`gold_revenue_ledger`, `gold_revenue_analytics`, `gold_marketing_attribution`, `gold_attribution_*`, `gold_campaign_attribution`) resolve `brain_id` via the identity map, not any removed path.
- **Tests:** money byte-exact reconcile vs pre-migration baseline.
- **Accept:** `Bronze → Silver → identity → Gold` e2e; money identical.

---

## Phase 5 — Doctrine, CI, decommission

### PR 5.1 🟢 Guardrails — **E2**
- **Modify** `CLAUDE.md` — dedup ("Bronze compaction + Silver") + identity ("resolved in Silver; Neo4j never on collector/log/Bronze") doctrine.
- **Modify** `tools/lint/v4-naming-guard.sh` — new rule: no `stream-worker` Kafka consumer may import the Neo4j identity repo (forbids regressing D5) + self-test.
- **Accept:** guard fails a planted violation; CI green otherwise.

### PR 5.2 🔴 Final decommission + promote — **E1**
- **Delete** any dormant removed-consumer/spool code; flip flags to default-on.
- **Accept:** owner promotes `release → master`; full CI green.

---

## Dependency graph

```
0.1 ─┐
0.2 ─┴─▶ 1.1 ─▶ 1.2
              └▶ 2.1 ─▶ 2.2 ─▶ 2.3 ─┐
1.1 ───────────────────────────────┴▶ 3.1 ─▶ 3.2 ─▶ 3.3
                                     3.1 ────────────┴▶ 3.4
                                     3.2 ─▶ 4.1 ─▶ 5.1 ─▶ 5.2
```
- Phase 2 needs the log path live (1.1).
- Identity stage (3.1) needs Silver landing intact (2.3) and ordering (3.2) before Gold (4.1).
- Consumer deletions (1.2, 2.3, 3.3, 5.2) always trail their additive/flag PR after a staging soak.

## Effort roll-up
~**42 eng-days** across 13 PRs (excludes infra). Critical path ≈ 1.1 → 2.3 → 3.1 → 3.3 → 4.1 → 5.2.

## Verification gates (must pass before each phase promotes)
1. **P1:** broker-restart chaos = zero acknowledged-event loss; p99 ACK < 50 ms.
2. **P2:** duplicate-injection (delivery + application) → Bronze zero-dupe post-compaction; Silver zero-dupe always; single Bronze writer proven by grep + metrics.
3. **P3:** identity output parity vs baseline; **no** log→Neo4j path (lint guard); cache hit-rate > 85%.
4. **P4:** money byte-exact reconcile; `gold_customer_360` populated from `silver_identity_map`.
5. **P5:** doctrine/CI updated; dormant code deleted; `knip` + `v4-naming-guard` green.

## Rollback posture
- Every behavior change is a flag flip (`INGEST_DIRECT_TO_LOG`, `IDENTITY_IN_SILVER`).
- Deletions are separate PRs that only land after the flagged path soaks green in staging — reverting a deletion is a `git revert`.
- Bronze is the replayable system of record throughout; Silver/Gold rebuild from it.
