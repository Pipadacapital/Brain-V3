# CTO Advisor Review — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 1 — intake (compressed, personas folded) |
| **Decision** | ADVANCE |
| **Reviewed at** | 2026-06-16T16:10:00Z |
| **Reviewer** | cto-advisor (Engineering Advisor, intake) |

---

## Lane confirmation

**Lane:** `high_stakes`
**Trigger surfaces (deterministic scan):** `multi_tenancy`, `connectors`, `schema_proto`
**Intake add:** `durability_spool` — accept-before-validate ordering is a named invariant (ADR-003 locked choice #3); the spool ordering contract is a distinct surface that the adversarial pass surfaced as the highest implementation risk. Added to surfaces; no scan flag removed.

---

## Repo ground-truth (what is actually present)

| Artifact | Status | Cite |
|---|---|---|
| `apps/collector` scaffold dirs (intake/spool/drainer/envelope/health) | Present — directories only; `src/main.ts` is a 9-line stub | `apps/collector/src/main.ts:7-9` |
| `apps/stream-worker` scaffold dirs (consumers/pipeline/sinks/identity-bridge) | Present — directories only; `src/main.ts` is a 9-line stub | `apps/stream-worker/src/main.ts:7-9` |
| Collector package deps | fastify, @brain/contracts, @brain/events, @brain/observability, @brain/tenant-context, @brain/config | `apps/collector/package.json` |
| Stream-worker package deps | kafkajs, @brain/contracts, @brain/events, @brain/identity-core, @brain/observability, @brain/tenant-context | `apps/stream-worker/package.json` |
| `CollectorEventV1Schema` (Zod) | Present, brand_id + event_id idempotency documented | `packages/contracts/src/events/sample.collector.event.v1.ts:22-80` |
| Avro artifact | Generated at `packages/contracts/generated/avro/brain.collector.event.v1.avsc` | Confirmed |
| `@brain/events` package | `registerSchema` + `validateSchemaCompatibility` + `buildPartitionKey` stubs present | `packages/events/src/index.ts` |
| `CollectorEventEnvelope` (internal type) | Uses `occurred_at: number` (millis) vs contract `occurred_at: string` (ISO-8601) — TYPE MISMATCH, see Finding F-1 | `packages/events/src/index.ts:26` |
| Bronze DDL (`db/iceberg/bronze_table.sql`) | Iceberg DDL present; requires Nessie/Glue registration, NOT a Postgres table | `db/iceberg/bronze_table.sql` |
| Redpanda in docker-compose | Present under `ingest` profile, `redpandadata/redpanda:v24.1.7` on port 9092 | `docker-compose.yml:124-158` |
| Nessie (Iceberg REST catalog) | Present under `ingest` profile on port 19120; `NESSIE_VERSION_STORE_TYPE: IN_MEMORY` | `docker-compose.yml:199-216` |
| MinIO (local S3) | Present under `core` profile; `brain-bronze` bucket bootstrapped via minio-init | `docker-compose.yml:57-70` |
| Postgres RLS pattern | Two-arg `current_setting('app.current_brand_id', TRUE)` documented and enforced | `db/migrations/0001_init.sql:56-70` |
| `brain_app` role | Created NOLOGIN, BYPASSRLS assertion in migration 0001 | `db/migrations/0001_init.sql:34-53` |

**Dev Bronze sink decision — CONFIRMED:** Bronze is Iceberg via the Nessie REST catalog + MinIO. There is no Postgres bronze table. The `ingest` profile spins up Nessie (`IN_MEMORY` store) + MinIO bucket `brain-bronze`. The stream-worker sink writes Iceberg via the Nessie REST catalog at `http://localhost:19120`. The Iceberg writer in dev is the PyIceberg or Iceberg REST API client — the architect must decide the TypeScript write path: either (a) Iceberg REST API directly from the KafkaJS stream-worker, or (b) a thin Spark/Flink micro-job. **This is D-4 binding below; it is the main open technical question for the architect.**

---

## Adversarial stress findings (severity-ranked)

### CRITICAL

**F-1 — `occurred_at` type mismatch between contract and internal envelope (file:line)**
- `packages/contracts/src/events/sample.collector.event.v1.ts:55` — Zod contract declares `occurred_at` as `z.string().datetime()` (ISO-8601 string).
- `packages/events/src/index.ts:26` — `CollectorEventEnvelope` declares `occurred_at: number` (millis since epoch).
- `db/iceberg/bronze_spec.json:13` — Bronze schema declares `occurred_at` as `timestamptz`.
- The stream-worker comment in `main.ts:8` says "the stream-worker converts to epoch-ms for Bronze partition" — but the Bronze DDL uses `TIMESTAMP NOT NULL`, not a long/int.
- **Risk:** if the spool serialises the ISO-8601 string and `@brain/events` deserialises to millis without an explicit conversion layer, the Avro encode/decode will produce a type fault at runtime. The Avro schema (`brain.collector.event.v1.avsc:38`) also uses `"type": "string"` for `occurred_at`, confirming the contract is string-based.
- **Required fix before implement:** the `CollectorEventEnvelope` in `packages/events/src/index.ts:26` must align to `occurred_at: string` (ISO-8601), with a documented conversion to `timestamptz` at the Bronze write boundary. The architect must specify this conversion step explicitly in the architecture plan.

**F-2 — accept-before-validate ordering: spool must ACK before any downstream call (no code yet, must be contract-correct by design)**
- `apps/collector/src/main.ts` is a stub. The ordering invariant is: HTTP receipt → envelope stamp (`ingest_at`) → fsync spool entry → return HTTP 200 → (async) drainer reads spool → Redpanda produce.
- If the builder implements validate-then-spool, or produce-then-ACK, or spool-then-produce-synchronously-before-ACK — any downstream outage at the ACK moment drops the event permanently.
- The drainer must be a separate async loop (not inline in the request handler). The spool must be crash-safe (fsync or a Postgres append-only spool table — the architect must choose the spool medium, see D-2).
- **Specific risk:** the collector has no KafkaJS dependency declared (`apps/collector/package.json`). The produce step belongs in the drainer, not in intake. This is correct by design — confirm the architect enforces this boundary.

**F-3 — Redpanda-down / Bronze-down at ingest: spool hold + drain-on-recovery**
- If Redpanda is down, the drainer must back-pressure and hold spool entries — NOT drop or error the HTTP response.
- If Bronze is down, the stream-worker must hold the Kafka consumer offset (not commit) and retry — or route to DLQ (`dev.collector.event.v1.dlq`, present in `docker-compose.yml:175-178`).
- Neither the drainer back-pressure policy nor the stream-worker retry/DLQ routing is specified in the requirement. The architect plan must define: max spool depth, drainer retry interval, DLQ routing condition, and stream-worker offset-commit ordering (commit offset AFTER successful Bronze write, not before).
- **Offset-commit ordering is the RLS peer risk:** if the stream-worker commits the Kafka offset before the Iceberg write succeeds, a Bronze-down event is permanently lost even though Kafka thinks it was processed.

### HIGH

**F-4 — RLS verification must be under `brain_app`, not `brain` superuser**
- `docker-compose.yml:19` — Postgres runs as superuser `brain`. The memory note (`dev-db-superuser-masks-rls.md`) and migration `0001_init.sql:34-53` both confirm this: `brain` is BYPASSRLS implicitly as superuser; RLS only enforces under `brain_app`.
- The e2e durability test and the Bronze cross-brand read test MUST `SET ROLE brain_app` before the assertion. Any test running as `brain` will see all rows regardless of RLS policy and produce a false pass.
- This applies to the Postgres control-plane tables. For Bronze/Iceberg, tenant isolation is enforced by partition (`bucket(16, brand_id)`) + S3 prefix (`write.object-storage.path`), not PostgreSQL RLS. The test must verify that a stream-worker consumer scoped to brand A cannot read brand B rows from Bronze — this is enforced by the query predicate `brand_id = ?` in the Iceberg reader, not by a DB-level policy. The architect must make this clear in the plan so the builder does not conflate Postgres RLS (control plane) with Iceberg brand isolation (data plane).

**F-5 — Idempotency key scope: `(brand_id, event_id)` dedup on Redpanda redelivery**
- `packages/contracts/src/events/sample.collector.event.v1.ts:9` — idempotency key `(brand_id, event_id)` documented.
- Bronze is append-only (`write.upsert.enabled = false`, `bronze_spec.json:62`). There is no MERGE / upsert at write time.
- On Redpanda redelivery (stream-worker consumer crash before offset commit), the same event will be written to Bronze a second time unless the stream-worker performs an explicit dedup check before writing.
- **Dedup mechanism must be specified:** either (a) a Redis dedup cache keyed on `brand_id:event_id` with TTL matching the Kafka retention (7 days, `docker-compose.yml:169`), or (b) a pre-write existence check in Iceberg (expensive for Bronze-scale). The architect must bind option (a) — Redis is already in the stack (`CacheAdapter`, ADR-004).

**F-6 — `ingest_at` field name mismatch between contract and Bronze DDL**
- `packages/contracts/src/events/sample.collector.event.v1.ts:61` — field name `ingest_at` (optional).
- `db/iceberg/bronze_table.sql:27` — column name `ingested_at` (NOT NULL).
- `packages/events/src/index.ts:32` — envelope field name `ingested_at`.
- The Zod contract uses `ingest_at`; the Bronze DDL and internal envelope both use `ingested_at`. The architect must canonicalise the field name before implementation — changing the Bronze DDL column name post-creation requires a schema evolution step; changing the Zod contract requires an Apicurio FULL_TRANSITIVE check.
- **Recommendation:** align Zod contract to `ingested_at` (rename `ingest_at` → `ingested_at` in the contract; it is currently optional so the first registered version has not been written to prod yet — safe to rename before first Apicurio registration).

### MEDIUM

**F-7 — Bronze sink write path in TypeScript stream-worker is unspecified**
- The stream-worker package has KafkaJS as a dep but no Iceberg client (`apps/stream-worker/package.json`). Iceberg writes from TypeScript have no official SDK. Options: (a) Iceberg REST API (`http://nessie:19120` in dev) — HTTP calls from the KafkaJS consumer, possible but adds latency; (b) write Parquet to MinIO/S3 and register with the catalog manually (complex, error-prone); (c) use the `@apache-arrow/esnext` + `parquet-wasm` path (experimental).
- **This is the primary open unknow for M1.** The architect must bind a concrete TypeScript → Iceberg write path. Given the TypeScript-everywhere constraint (ADR locked choice #7) and the Phase-3 deferral of Spark, the most pragmatic dev-mode option is the Iceberg REST API (POST data files via the catalog's data-file API or the S3 FileIO path). The architect must validate this is functional in the Nessie v0.90.2 image.

**F-8 — Schema registration ordering: Apicurio must be healthy before collector starts**
- `packages/events/src/index.ts:62-93` — `registerSchema` called on startup. If Apicurio is not ready, the collector crashes on boot.
- The `docker-compose.yml` Apicurio healthcheck exists (`apicurio:8080`), but the collector has no `depends_on: apicurio` in the compose file (no collector service is defined in compose — it runs as a process, not a container in local dev).
- The architect must specify a startup probe in the collector that retries schema registration with exponential backoff before serving requests.

**F-9 — No spool medium specified (filesystem fsync vs Postgres append table)**
- The `apps/collector/src/spool` directory is empty. The spool medium is the durability anchor. Filesystem spool requires a persistent volume (fine in prod EKS with PVC; risky in test if tmpfs). A Postgres append-only table spool avoids the volume dependency and fits the existing `PersistenceAdapter`.
- **Architect must bind:** for dev/test, a Postgres spool table (in the existing `brain` DB under `brain_app` role, no RLS needed since it is not brand-scoped at the collector boundary — events are enqueued before brand validation). For prod, evaluate if the same approach holds at throughput, or a persistent volume spool is needed.

### LOW

**F-10 — `schema_name` / `schema_version` in Bronze DDL vs Avro envelope mismatch**
- `db/iceberg/bronze_table.sql:30-31` — columns `schema_name` (STRING) and `schema_version` (INT).
- `packages/contracts/generated/avro/brain.collector.event.v1.avsc` — no `schema_name` or `schema_version` Avro fields.
- These two Bronze columns must be populated by the stream-worker from the Apicurio registration result. The builder needs to know: the stream-worker reads the Avro schema header (magic byte + schema ID) from Kafka, resolves the schema version from Apicurio, and writes `schema_name = 'brain.collector.event.v1'` and `schema_version = <n>` to Bronze. This is not a blocking risk but must be documented in the architecture plan.

---

## Architect decision bindings

| ID | Binding |
|---|---|
| **D-1** | **Accept-before-validate ordering is inviolable:** the request handler writes to spool and returns HTTP 200 before any validation, Apicurio call, or Redpanda produce. Validation and produce happen asynchronously in the drainer. The drainer is a separate async process loop, not inline in the HTTP handler. |
| **D-2** | **Spool medium = Postgres append-only table** (`brain` DB, `collector_spool` table, `brain_app` INSERT + SELECT grants, no RLS — spool is pre-brand-validation). Columns: `id BIGSERIAL PK`, `received_at TIMESTAMPTZ NOT NULL`, `raw_body JSONB NOT NULL`, `status TEXT NOT NULL DEFAULT 'pending'`, `drained_at TIMESTAMPTZ`. The drainer polls `WHERE status = 'pending' ORDER BY id` with a configurable batch size and marks `status = 'drained'` after confirmed Redpanda produce. No filesystem volume dependency for dev/test. |
| **D-3** | **Idempotency dedup = Redis cache keyed `dedup:{brand_id}:{event_id}` with TTL = 7 days** (matches Redpanda topic retention). The stream-worker checks this key before the Bronze write; on hit, it commits the Kafka offset and skips the write. On miss, it writes to Bronze then sets the key. Uses the existing `CacheAdapter` (ADR-004, Redis on port 6379 in docker-compose). |
| **D-4** | **Dev Bronze sink = Iceberg REST API via Nessie** (`http://nessie:19120`). The stream-worker writes Parquet data files to MinIO (`s3://brain-bronze/`) and registers the data file with Nessie via the Iceberg REST Catalog API. No Spark job in M1. The architect must validate this write path against the Nessie v0.90.2 image in a spike (max 1 slice, ~1h). If the Iceberg REST write path is not functional in TypeScript within that spike, the fallback binding is a Postgres `bronze_events` staging table for M1 only (clearly marked dev-only, deferred Iceberg registration to a nightly Argo job). This is the highest-risk open question in the feature. |
| **D-5** | **`occurred_at` / `ingested_at` field name canonicalisation:** rename Zod contract field `ingest_at` → `ingested_at` before first Apicurio registration. Update `packages/contracts/src/events/sample.collector.event.v1.ts:61` and the generated Avro artifact. The `CollectorEventEnvelope` in `packages/events/src/index.ts` is already `ingested_at` — this aligns all three layers. |
| **D-6** | **`occurred_at` type boundary:** the contract and Avro wire format use ISO-8601 string. The Bronze column is `TIMESTAMP`. The stream-worker performs the conversion: `new Date(occurred_at).toISOString()` → Iceberg `timestamptz` value. No millis-as-number representation anywhere in the event envelope. Update `packages/events/src/index.ts:26` to `occurred_at: string`. |
| **D-7** | **Kafka offset commit ordering:** the stream-worker commits the Kafka offset ONLY after (a) dedup check passes AND (b) Bronze write is confirmed (or the event is a confirmed duplicate). If the Bronze write fails, the offset is not committed; the event is retried on the next consumer poll. After `MAX_RETRY_COUNT` (suggest 5) retries, the event is routed to the DLQ topic (`dev.collector.event.v1.dlq`) and the offset is committed. |
| **D-8** | **Bronze tenant isolation for data plane = partition + S3 prefix predicate, NOT Postgres RLS.** The e2e test must assert cross-brand Bronze reads return 0 rows by querying with `WHERE brand_id = brand_A_id` and asserting brand B's `event_id` is not present. The test must NOT rely on Postgres RLS for this assertion — Bronze is Iceberg, not Postgres. |
| **D-9** | **No new deployable.** Wire the existing `apps/collector` (Fastify + spool) and `apps/stream-worker` (KafkaJS consumer) stubs. The spool table migration ships as a new node-pg-migrate file in `db/migrations/`. No new service, no new package, no new Postgres database. |
| **D-10** | **Collector schema registration:** on startup, the collector registers `brain.collector.event.v1` with Apicurio using `registerSchema()` from `@brain/events`. Must retry with exponential backoff (max 30s) before opening the HTTP listener. Apicurio healthcheck at `http://apicurio:8080` must be green before the collector starts serving. |

---

## "Make it less dumb first" check

- Scope is already thin: one synthetic event, no real connector, no identity graph, no ledger.
- The spool-then-drain pattern is the correct complexity for the durability invariant — do not simplify to synchronous produce (that violates D-1).
- The only potentially over-engineered piece is Apicurio validation in stream-worker for a synthetic event in M1. The architect may choose to stub the Apicurio validate call with a local Zod parse for the M1 slice and enable the full registry validation in M2 — this is a valid simplification that reduces the ingest dependency chain for the first slice.

---

## Dependency pre-flight

No blocker in `proposed_children[].blocks` is flagged unshipped. The linked prior run `chore-platform-foundations-sprint0` that delivered Redpanda, Bronze scaffold, contracts, and RLS migration #1 is confirmed shipped (artifacts present in repo). No dependency block.

---

## Lane summary

Lane `high_stakes` is confirmed. Surface `multi_tenancy` confirmed (Bronze brand_id partitioning + RLS cross-brand assertion). Surface `connectors` confirmed (this feature is the ingest head that downstream connectors feed). Surface `schema_proto` confirmed (Avro contract + Apicurio registration is first thing shipped). Surface `durability_spool` ADDED (accept-before-validate is a named locked invariant, ADR-003 locked choice #3; the spool ordering contract is an implementation surface requiring explicit architect binding).

---

## Decision

**ADVANCE to architecture (Stage 2).**

Requirement is sound. Problem statement, success metric, and constraints are unambiguous. Scaffolds are real. Redpanda + Nessie + MinIO are present in the `ingest` profile of docker-compose. No new deployable is required. The 10 adversarial findings above are all addressable within the existing stack — none require a new ADR or stack change. The architect must resolve D-4 (TypeScript → Iceberg write path) as the first spike; all other bindings are clear.

Builder scope: data-engineer (Bronze sink, Iceberg write path, stream-worker pipeline) with backend-developer in parallel on the collector HTTP edge (Fastify intake + spool + drainer).
