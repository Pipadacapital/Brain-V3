# Pass 7: Data Platform Audit (data-platform)

**Board:** data-platform  
**Date:** 2026-06-19  
**Auditor:** Principal-level independent audit (Claude Sonnet 4.6)

---

## Board Verdict

The data platform is fundamentally well-designed: FULL_TRANSITIVE Avro schema governance, two-layer Redis-then-PG dedup, at-least-once with manual offset-commit, proper append-only Iceberg Bronze spec, and solid dbt replay-safety tests. However, five concrete, code-evidenced problems exist. The most critical is the Avro envelope shipped in production (`collector.event.v1.avsc`) missing **four required fields** mandated by the doc 07 universal contract (`producer`, `schema_id`, `causation_id`, `sequence`/`source`) — any consumer that trusts the doc 07 contract to deserialize these fields will break on replay. The second critical issue is that `replication_factor: 1` and `min.insync.replicas: 1` are hardcoded in the source-of-truth `topics.yml` for every topic including the live ingest lane, with only a comment noting production should use 3 — this means accidental deployment without override or a Terraform variable gap leaves the 99.95% SLO ingest path on a single Redpanda broker with zero durability headroom. The remaining three findings are Medium: the behavioral-pixel partition key drifts from doc 07's `hash(brand_id, visitor_id)` to `brand_id:event_id` (breaks visitor-local ordering); the consumer-group IDs in `topics.yml` do not match the runtime defaults in `main.ts` (infra tooling would create misaligned ACL/lag monitoring); and the Iceberg Bronze spec sets `write.merge.mode: merge-on-read` while declaring the table as `write.upsert.enabled: false` (append-only) — a semantically inconsistent property combination that exists only in the spec, not the live DDL, so it carries future confusion risk when Iceberg writers land.

**Severity count:** Critical ×2, High ×0, Medium ×3, Low ×0.

---

## Finding DP-1

**Title:** Avro envelope missing four required fields from doc 07 universal contract  
**Severity:** Critical  
**Category:** Schema / Contract  
**Priority:** P0  

**evidenceRef:**
- `infra/redpanda/schemas/collector.event.v1.avsc:1-89` — shipped Avro schema; fields present: `event_id`, `brand_id`, `occurred_at`, `ingested_at`, `schema_name`, `schema_version`, `partition_key`, `correlation_id`, `event_type`, `payload`, `collector_version`, `consent_flags`.
- `docs/requirements/07_Brain_Event_Contracts.md:154-170` (§4, Universal event envelope table) — **required** envelope fields include: `producer` (required ✓), `schema_id` (required ✓), `causation_id` (nullable), `source` (required ✓), `sequence` (nullable).
- `packages/events/src/index.ts:23-35` — `CollectorEventEnvelope` interface mirrors the Avro gap: `producer`, `schema_id`, `source`, `causation_id`, `sequence` are absent.
- `packages/contracts/src/events/sample.collector.event.v1.ts:23-112` — `CollectorEventV1Schema` Zod definition: `schema_id`, `producer`, `source`, `causation_id`, `sequence` fields are not present.

**Impact:** Any downstream consumer that builds against the doc 07 universal envelope (identity, attribution, billing, audit via `packages/audit`) and tries to deserialize `producer`, `schema_id`, `source`, or `causation_id` fields will fail or silently receive null at runtime. Replay from Bronze (24-month horizon) will not carry causal lineage (`causation_id`), breaking the "which event triggered this" chain required for attribution re-credit on `identity.merge.committed`. The `schema_id` gap means Apicurio global schema pinning (exact version per message) is not exercised, so schema-version drift between producer and replay is not caught at decode time.

**Root cause:** The Avro `.avsc` and the Zod source-of-truth (`CollectorEventV1Schema`) were designed for the collector's Phase-1 pixel ingest shape, which is narrower than the full doc-07 universal envelope. The doc-07 universal contract was authored as a forward-looking specification; the collector event schema was not updated to align.

**Fix:**
1. Add `producer` (string, required, default `"collector"`) to `CollectorEventV1Schema` and regenerate `.avsc`. FULL_TRANSITIVE safe: new required field with a default.
2. Add `schema_id` (long, nullable, default `null`) — M2 when Apicurio fetch is wired.
3. Add `source` (string, nullable, default `null`), `causation_id` (string/uuid, nullable, default `null`), `sequence` (long, nullable, default `null`) as optional fields with defaults.
4. Register the updated `.avsc` in Apicurio; CI compat-check will confirm FULL_TRANSITIVE compliance.
5. Update `CollectorEventEnvelope` in `packages/events/src/index.ts` to match.

**Tenant impact:** All tenants. Every event produced to `{env}.collector.event.v1` is missing these fields; the impact is universal.

**Detection:** Not currently alerted. Will surface when a downstream consumer tries to project `producer` or `schema_id` from a Bronze row and gets null/undefined instead of an expected value. Unit-level: add a Zod intersection test asserting the collector schema satisfies the doc-07 universal envelope shape.

---

## Finding DP-2

**Title:** `topics.yml` hardcodes `replication_factor: 1` and `min.insync.replicas: 1` for all topics including the live ingest lane, with no Terraform parametrization guard

**Severity:** Critical  
**Category:** Durability / Availability  
**Priority:** P0  

**evidenceRef:**
- `infra/redpanda/topics.yml:12-17` — live ingest topic `{env}.collector.event.v1`: `replication_factor: 1`, `min.insync.replicas: "1"` with only a comment `# 1 for local/dev; 3 for prod` and `# 2 for prod`.
- `infra/redpanda/topics.yml:23-28`, `34-39`, `45-48`, `55-58`, `65-68` — all remaining topics (backfill, order-backfill, DLQ, quarantine) share the same `replication_factor: 1`, `min.insync.replicas: "1"`.
- `docs/requirements/07_Brain_Event_Contracts.md:211-238` (§6 topic catalogue) — no explicit RF overrides; doc 04 NFR is 99.95% ingest availability.
- `infra/redpanda/README.md:91-93` — `Production topics are provisioned by Track C (infra/terraform/modules/redpanda)`. No Terraform module in-repo to verify RF override.

**Impact:** If `topics.yml` is applied to a production or staging Redpanda cluster (via the redpanda-init container or Terraform that reads this file without an explicit override) with `replication_factor: 1`, a single broker loss destroys all in-flight data and renders the topic unavailable — directly violating the 99.95% collector availability SLO. The DLQ topics also become unrecoverable on broker loss, defeating the at-least-once guarantee.

**Root cause:** The file intentionally uses RF=1 for local/dev but relies on an out-of-band comment and an undocumented Terraform override step. There is no checked-in guard (variable, assertion, or separate prod overlay) that prevents the dev values from reaching production.

**Fix:**
1. Split `topics.yml` into `topics.dev.yml` (RF=1, MIR=1) and `topics.prod.yml` (RF=3, MIR=2).
2. Or add a Terraform variable `redpanda_replication_factor` (default `3`) and `min_insync_replicas` (default `2`) that override the `topics.yml` values at provisioning time, with a CI lint asserting these variables are set in the prod workspace.
3. At minimum, add a `make check-prod-topics` gate that asserts no `replication_factor: 1` appears in a prod deployment manifest.

**Tenant impact:** All tenants. A broker failure with RF=1 silently loses live ingest events for every brand during the window.

**Detection:** Not currently alerted. Would surface as Redpanda partition unavailability → collector accept failures (HTTP 503/5xx) → SLO burn alert firing. By that point data is already lost.

---

## Finding DP-3

**Title:** Behavioral/pixel partition key is `brand_id:event_id` (dedup-keyed) rather than doc 07's `hash(brand_id, visitor_id)` (visitor-ordered)

**Severity:** Medium  
**Category:** Topic Design / Partition Strategy  
**Priority:** P2  

**evidenceRef:**
- `docs/requirements/07_Brain_Event_Contracts.md:248-253` (§7 Partitioning strategy table) — "Behavioral / pixel" → `hash(brand_id, visitor_id)` (or `session_id`). Ordering unit: per-visitor/session.
- `infra/redpanda/topics.yml:6` — declares partition key as `brand_id + ":" + event_id` (brand-prefixed composite).
- `packages/events/src/index.ts:140-142` — `buildPartitionKey(brandId, eventId)` returns `${brandId}:${eventId}`.
- `apps/collector/src/infrastructure/kafka-producer.ts:74-77` — `partitionKey = buildPartitionKey(brandId, eventId)` is what is actually keyed to Kafka.
- `infra/redpanda/schemas/collector.event.v1.avsc:47` — `partition_key` field doc: `"brand_id + ':' + event_id"`.

**Impact:** Because `event_id` is a random UUID, a single visitor's page_view → add_to_cart → checkout events are distributed randomly across all 12 partitions. The doc-07 ordering invariant for visitor sessions is violated: a stream-worker consumer reading one partition will not see all events from a visitor in order, making deterministic server-side sessionization in the stream-worker impossible (though this is currently done in dbt, post-Bronze). If a future stream-worker tries to do real-time sessionization in-flight (as doc 09 implies for real-time attribution), it will find visitor events spread across partitions.

**Root cause:** The implementation opted for `brand_id:event_id` to maximize partition spread and align the partition key with the dedup key, which is pragmatically correct for Bronze throughput. The doc-07 `visitor_id`-based key was not carried through to the implementation.

**Fix:**
1. Update `buildPartitionKey` to accept a `visitorId` parameter and use `brand_id:visitor_id` when present (falling back to `brand_id:event_id` for events without a visitor context — connector events, etc.).
2. Update `infra/redpanda/topics.yml` comment and the `.avsc` `partition_key` doc to reflect the actual or intended key.
3. Or formally document the deliberate decision to use `event_id` and amend doc 07 §7 accordingly with the rationale (correctness does not depend on partition order per §6.6 H1).

**Tenant impact:** All tenants equally. No cross-tenant data leakage — this is a within-topic ordering concern.

**Detection:** Not alertable today. Would surface if real-time sessionization is added to stream-worker and produces incorrect session boundaries because related events land in different partitions.

---

## Finding DP-4

**Title:** Consumer group IDs in `topics.yml` do not match runtime defaults in `apps/stream-worker/src/main.ts`

**Severity:** Medium  
**Category:** Topic Design / Operations  
**Priority:** P2  

**evidenceRef:**
- `infra/redpanda/topics.yml:73` — live consumer group declared as `"brain.stream-worker.live"`.
- `infra/redpanda/topics.yml:77` — backfill consumer group declared as `"brain.stream-worker.backfill"`.
- `infra/redpanda/topics.yml:81-83` — order-backfill consumer group declared as `"stream-worker-backfill"`.
- `apps/stream-worker/src/main.ts:54` — runtime default: `CONSUMER_GROUP_ID ?? 'stream-worker-live'` (missing `brain.` prefix).
- `apps/stream-worker/src/main.ts:92` — backfill: `BACKFILL_CONSUMER_GROUP_ID ?? 'stream-worker-backfill'` (matches yml but not the `brain.` convention).
- `apps/stream-worker/src/main.ts:55-92` — seven additional consumer groups wired (identity, consent, CAPI-deletion, live-ledger, settlement, spend, gokwik) with no entries in `topics.yml` at all.

**Impact:** When Redpanda ACLs, Prometheus consumer-lag metrics, or observability dashboards are provisioned using `topics.yml` as the source of truth for consumer group IDs, they will monitor `brain.stream-worker.live` while the actual runtime group is `stream-worker-live` (default). Lag alerts will fire on a phantom group (always 0 lag) and miss the real group. Additionally, the seven undeclared consumer groups (identity-bridge-live, stream-worker-consent-suppressor, stream-worker-capi-deletion, live-ledger-bridge, settlement-ledger-bridge, spend-ledger-bridge, gokwik-awb-ledger-bridge) have no ACL grants in `topics.yml`, which will cause access-denied errors if Redpanda ACLs are enforced in production.

**Root cause:** The `topics.yml` consumer group registry was written for the initial Phase-1 pipeline and was not updated as new consumer groups were added to `main.ts`. The naming convention (`brain.` prefix) was also not applied consistently.

**Fix:**
1. Align `topics.yml` consumer group IDs with `main.ts` runtime defaults (or vice versa).
2. Add entries for all seven additional consumer groups to `topics.yml`.
3. Add a CI check (`make check-consumer-groups`) that diffs the `consumer_groups[*].id` values in `topics.yml` against the hardcoded defaults in `main.ts`.

**Tenant impact:** All tenants. Consumer lag is invisible to ops; ACL gaps would block new consumers at deploy time in a locked-down cluster.

**Detection:** In a dev cluster with no ACLs, silent. In a production Redpanda cluster with ACLs enabled, the new consumer groups will fail on `TOPIC_AUTHORIZATION_FAILED` immediately on start. Consumer-lag dashboards will show the registered groups at zero lag (healthy-looking) while the real groups accumulate.

---

## Finding DP-5

**Title:** Iceberg Bronze spec sets `write.merge.mode: merge-on-read` on an explicitly append-only, upsert-disabled table — semantically inconsistent property combination

**Severity:** Medium  
**Category:** Iceberg Table Config  
**Priority:** P3  

**evidenceRef:**
- `db/iceberg/bronze_spec.json:61-62` — `"write.upsert.enabled": "false"` alongside `"write.merge.mode": "merge-on-read"`.
- `db/iceberg/bronze_table.sql:55-56` — `TBLPROPERTIES` repeats `write.upsert.enabled = 'false'` but omits `write.merge.mode` entirely (so the DDL and the JSON spec diverge on this property).
- `db/iceberg/schema-evolution-policy.md:7` — "The Bronze layer is the system of record for all raw events (24-month retention, append-only)."
- `db/iceberg/schema-evolution-policy.md:48-51` — replay uses `MERGE INTO ... WHEN NOT MATCHED THEN INSERT` (insert-if-absent, not a full upsert).

**Impact:** The `write.merge.mode: merge-on-read` property is meaningful only when upserts/deletes are performed (it controls whether merge operations write delete files or rewrite data files). With `write.upsert.enabled: false` and a stream-writer doing pure appends, this property is effectively a no-op — but it signals to future Iceberg writers that MOR merges are expected, which may cause a future engineer to enable upserts assuming MOR is already configured correctly, inadvertently mutating the "immutable" Bronze layer. Additionally, the `bronze_table.sql` DDL does not include `write.merge.mode` at all, so the actual table on a live cluster (created from the SQL) will differ from the `bronze_spec.json` specification, making the spec a non-authoritative description.

**Root cause:** The `write.merge.mode` property was likely included as a defensive default for potential future dedup-MERGE operations (the schema-evolution doc mentions `MERGE INTO ... WHEN NOT MATCHED THEN INSERT`), but was not removed when the decision was made to use append-only writes and Redis+PG dedup instead.

**Fix:**
1. Remove `write.merge.mode: merge-on-read` from `db/iceberg/bronze_spec.json` since it is inapplicable to an append-only, `upsert.enabled=false` table.
2. Add a comment in `bronze_spec.json` explaining that the dedup is at the application layer (Redis NX + PG PK), not via Iceberg MERGE.
3. Align `db/iceberg/bronze_table.sql` with `bronze_spec.json` on all `TBLPROPERTIES` — the DDL is the live table definition and should be the canonical source; the spec should add only documentation, not extra properties not in the DDL.

**Tenant impact:** No immediate production impact (property is no-op with upserts disabled). Risk is future-operator confusion leading to inadvertent mutation of Bronze.

**Detection:** Not alertable. Would surface only if a future engineer enables upserts on Bronze and is surprised by MOR behavior. A DDL-vs-spec drift test (diff `SHOW TBLPROPERTIES` against `bronze_spec.json` in CI) would catch it.
