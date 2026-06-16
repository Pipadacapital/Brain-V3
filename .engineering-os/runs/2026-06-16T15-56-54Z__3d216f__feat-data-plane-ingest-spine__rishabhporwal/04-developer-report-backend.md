# Developer Report — Backend Engineer (Track B)
## `feat-data-plane-ingest-spine` — Stage 3

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 3 — implementation (Backend Engineer, Track B) |
| **Track** | B — collector accept-before-validate HTTP edge + durable spool + drainer + contract fixes |
| **Engineer** | backend-developer |
| **Date** | 2026-06-16 |
| **Branch** | `feat/data-plane-ingest-spine` |

---

## Files Delivered

### Slice 1 — Contract fixes + migrations (commit `0b1a342`)

| File | Change |
|---|---|
| `packages/contracts/src/events/sample.collector.event.v1.ts` | F-6: renamed `ingest_at` → `ingested_at` (Zod field). Fixed stale comment: "stream-worker converts to epoch-ms" → "stream-worker writes occurred_at as timestamptz at Bronze boundary; no epoch-ms representation." |
| `packages/contracts/src/events/sample.collector.event.v1.test.ts` | Updated optional-field test to use `ingested_at` (was `ingest_at`). 8/8 pass. |
| `packages/contracts/scripts/codegen.ts` | Updated Avro codegen: `ingest_at` → `ingested_at` field in generated Avro schema. |
| `packages/contracts/generated/avro/brain.collector.event.v1.avsc` | Regenerated: `ingested_at` field (was `ingest_at`). Committed in same commit as Zod change (I-E01). |
| `packages/contracts/generated/openapi/openapi.json` | Regenerated (codegen re-run). |
| `packages/contracts/generated/types/index.d.ts` | Regenerated (codegen re-run). |
| `packages/contracts/generated/mcp/tools.json` | Regenerated (codegen re-run). |
| `packages/events/src/index.ts` | F-1: `CollectorEventEnvelope.occurred_at: number` → `string` (ISO-8601). `ingested_at: number` → `string`. Dropped "millis since epoch" comments. |
| `db/migrations/0015_collector_spool.sql` | New: `collector_spool` table — `BIGSERIAL PK`, `raw_body JSONB`, `status text DEFAULT 'pending'`, `received_at/drained_at TIMESTAMPTZ`. Partial index on `(id) WHERE status='pending'`. NO RLS. `brain_app` SELECT+INSERT+UPDATE. |
| `db/migrations/0016_bronze_events.sql` | New: `bronze_events` table — mirrors `bronze_spec.json` field-for-field. RLS FORCE, two-arg `current_setting` (NN-1). `brain_app` SELECT+INSERT only (append-only at GRANT). `(brand_id, event_id)` PK = DB idempotency backstop. |

### Slice 2 — Collector accept-before-validate edge (commit `b25f51c`)

DDD structure — `apps/collector/src/`:

| File | Role |
|---|---|
| `domain/ingest/value-objects/envelope.ts` | `IngestEnvelope` VO + `stampEnvelope()` — the only pre-ACK transformation |
| `domain/ingest/entities/spool-entry.ts` | `SpoolEntry` + `PendingSpoolEntry` entities |
| `domain/ingest/repositories/spool.repository.ts` | `SpoolRepository` interface (domain boundary) |
| `infrastructure/pg-spool.repository.ts` | Postgres implementation — `insert()`, `pollPending()`, `markDrained()`, `ping()` |
| `infrastructure/kafka-producer.ts` | KafkaJS producer wrapper — used ONLY by drainer, never by HTTP handler |
| `application/accept-event.usecase.ts` | `AcceptEventUseCase` — stamp + INSERT + return. No validate/produce (D-1). |
| `application/drain-events.usecase.ts` | `DrainEventsUseCase` — poll pending → produce → mark drained. On error: break + log (F-3). |
| `interfaces/rest/collect.route.ts` | `POST /collect` → acceptUseCase.execute() → HTTP 200. `POST /v1/events` → 202. |
| `interfaces/rest/health.route.ts` | `GET /healthz` (liveness), `GET /readyz` (spool DB reachable), `GET /health` (alias) |
| `interfaces/jobs/drainer.ts` | `Drainer` class — `setInterval` loop, connects Kafka producer (fails-soft), starts after HTTP listener |
| `src/main.ts` | Bootstrap: config → spool → Apicurio backoff → HTTP listener → drainer start → graceful shutdown |

### Slice 3 — Durability tests (commit `2da8f73`)

| File | Role |
|---|---|
| `apps/collector/tests/durability.test.ts` | 5 tests (all PASS) — see verification section below |
| `apps/collector/vitest.config.ts` | Vitest config, 30s timeout for Kafka connect |
| `apps/collector/tsconfig.test.json` | TypeScript config for test files (rootDir=`.`) |

---

## Slice Dispositions

### Slice 1 — COMPLETE

- F-6 (`ingest_at → ingested_at`): DONE in Zod contract, Avro codegen, envelope type.
- F-1 (`occurred_at`/`ingested_at` as ISO-8601 string): DONE in `CollectorEventEnvelope` (was `number`).
- Stale comment: FIXED — no "epoch-ms" mention anywhere in the envelope.
- `gen:contracts` run: regenerated `.avsc` shows `ingested_at` field. Committed same commit as Zod change (I-E01).
- `0015_collector_spool.sql`: applied. Table + partial index + brain_app grants verified in DB.
- `0016_bronze_events.sql`: applied. RLS FORCE + two-arg policy + INSERT/SELECT-only grants verified.
- Contract tests: 8/8 PASS.
- `@brain/contracts` typecheck: EXIT 0.
- `@brain/events` typecheck: EXIT 0.

### Slice 2 — COMPLETE

- Fastify server: `POST /collect`, `POST /v1/events`, `/healthz`, `/readyz`, `/health`.
- Accept-before-validate ordering: `AcceptEventUseCase` does stamp + INSERT + return. Route calls only this use-case before replying. Zero validation, zero Apicurio, zero Kafka in handler (D-1).
- Drainer: separate `setInterval` loop (not inline in request handler). On produce error: breaks batch, logs, returns 0. Row stays `pending` (F-3 back-pressure).
- Apicurio registration: exponential backoff (500ms → 5s, max 30s total). On budget exhaustion: logs warning, continues (degrade-don't-crash, D-10). HTTP listener opens regardless.
- `@brain/collector` typecheck: EXIT 0.

### Slice 3 — COMPLETE

5/5 tests PASS against live PG + live Redpanda:

```
✓ ACK ordering: POST /collect → HTTP 200 → spool row present (status=pending)
✓ /v1/events alias → HTTP 202 → spool row present
✓ Redpanda-down durability: POST → 200 → pending; dead-broker drain → 0 drained → row stays pending; live-broker drain → row drained
✓ GET /healthz → 200 alive
✓ GET /readyz → 200 ready
```

---

## ACK-Before-Validate Ordering Proof

The ordering is proved by code structure, not just by test assertion:

1. `collect.route.ts` calls only `acceptUseCase.execute(rawBody)` before calling `reply.send()`.
2. `AcceptEventUseCase.execute()` calls only `stampEnvelope()` and `spool.insert()` — no imports of `kafkajs`, no Apicurio calls, no Zod parse of the body.
3. The Kafka producer (`CollectorKafkaProducer`) is imported only by `DrainEventsUseCase` and `Drainer` — not by any file in `interfaces/rest/` or `application/accept-event.usecase.ts`.
4. The drainer is started in `main.ts` AFTER `app.listen()` completes, as a separate `setInterval` loop.

Key files showing the separation:
- `/Users/rishabhporwal/Desktop/Brain V3/apps/collector/src/interfaces/rest/collect.route.ts` — imports only `AcceptEventUseCase` and `extractCorrelationId`.
- `/Users/rishabhporwal/Desktop/Brain V3/apps/collector/src/application/accept-event.usecase.ts` — imports only `stampEnvelope` and `SpoolRepository` interface. No kafka imports.

---

## Redpanda-Down Durability Proof

Test in `apps/collector/tests/durability.test.ts`, case "event is ACKd (200) and spool row stays pending when Redpanda is unreachable":

1. POST /collect while Redpanda may be up/down → asserts HTTP 200 (spool INSERT is what ACKs).
2. Constructs `CollectorKafkaProducer` with `brokers: ['localhost:19999']` (dead port).
3. `DrainEventsUseCase.execute()` catches the produce error, returns `drained=0`.
4. Asserts row is still `status='pending'` — **the spool held, nothing dropped**.
5. Connects a live producer (`localhost:9092`), calls `DrainEventsUseCase.execute()`.
6. Asserts `drainedOnRecovery >= 1` and the specific row is now `status='drained'`.

This is NOT a mock — `kafkajs` actually attempts TCP connect to `localhost:19999`, the connection is refused, and the produce throws. `DrainEventsUseCase` catches this and returns 0 (back-pressure hold path). Real Redpanda on `localhost:9092` handles the recovery drain.

---

## Verification Output

### `pnpm --filter @brain/contracts typecheck` → EXIT 0
```
> @brain/contracts@0.0.0 typecheck
> tsc --noEmit
(no output — clean)
```

### `pnpm --filter @brain/events typecheck` → EXIT 0
```
> @brain/events@0.0.0 typecheck
> tsc --noEmit
(no output — clean)
```

### `pnpm --filter @brain/collector typecheck` → EXIT 0
```
> @brain/collector@0.0.0 typecheck
> tsc --noEmit
(no output — clean)
```

### `pnpm --filter @brain/contracts run test:contract` → 8/8 PASS
```
✓ parses a valid event
✓ rejects an event without brand_id (I-S01 negative control)
✓ rejects an event without correlation_id (ADR-009 negative control)
✓ rejects an event without event_id
✓ rejects a non-UUID brand_id
✓ rejects a non-UUID event_id
✓ accepts optional fields when provided (ingested_at field confirmed)
✓ defaults schema_version to "1"
Test Files  1 passed (1) | Tests  8 passed (8)
```

### Migration 0015 applied — verified
```sql
\d collector_spool
 id          | bigint    PK (BIGSERIAL)
 received_at | timestamptz NOT NULL DEFAULT now()
 raw_body    | jsonb NOT NULL
 status      | text NOT NULL DEFAULT 'pending'  CHECK IN ('pending','drained')
 drained_at  | timestamptz
Indexes: idx_collector_spool_pending (id) WHERE status='pending'
Grants: brain_app SELECT, INSERT, UPDATE
```

### Migration 0016 applied — verified
```sql
\d bronze_events
 event_id / brand_id / occurred_at / ingested_at / schema_name / schema_version /
 event_type / correlation_id / partition_key / payload / processing_flags / collector_version
PK: (brand_id, event_id)
Policies (FORCE): tenant_isolation → current_setting('app.current_brand_id', TRUE)::uuid
Grants: brain_app INSERT, SELECT
```

### Durability tests → 5/5 PASS
```
DATABASE_URL=postgresql://brain:brain@localhost:5432/brain
REDPANDA_BROKERS=localhost:9092
vitest run

✓ tests/durability.test.ts (5 tests) 59ms
Test Files  1 passed (1) | Tests  5 passed (5)
```

---

## §contract — For the Data-Engineer (Track A)

**Redpanda topic:** `dev.collector.event.v1`

(DLQ: `dev.collector.event.v1.dlq`; backfill: `dev.collector.event.v1.backfill`)

**Event shape on the topic (JSON, not Avro for M1 drainer produce):**

The drainer produces raw `collector_spool.raw_body` as JSON with `correlation_id` and `source: 'collector-drainer'` as Kafka message headers. The key is `brand_id:event_id` (from `buildPartitionKey`).

The expected shape (stream-worker validates with `CollectorEventV1Schema.parse()`):

```typescript
{
  schema_version: '1',           // string literal
  event_id: string,              // UUIDv4
  brand_id: string,              // UUIDv4 — tenant key (I-S01)
  correlation_id: string,        // 1–128 chars
  event_name: string,            // e.g. "page.viewed"
  occurred_at: string,           // ISO-8601 UTC — convert to timestamptz at Bronze write
  ingested_at?: string,          // ISO-8601 UTC (optional) — rename from ingest_at (F-6 fix)
  hashed_user_id?: string,       // optional, sha256 hash
  hashed_session_id?: string,    // optional, sha256 hash
  properties?: Record<string, unknown>,  // defaults to {}
  _received_at: string,          // injected by spool INSERT: collector receipt time (ISO-8601)
}
```

**Avro schema:** `packages/contracts/generated/avro/brain.collector.event.v1.avsc` — subject `brain.collector.event.v1` registered in Apicurio at collector startup.

**M2 note:** The drainer produces JSON for M1. Avro-encoded produce (with Apicurio subject ID header) is an M2 refinement. Stream-worker's `CollectorEventV1Schema.parse()` works on the JSON-decoded value directly.

---

## Commits Per Slice

| Slice | SHA | Description |
|---|---|---|
| Slice 1 | `0b1a342` | Contract field canonicalization + spool/bronze migrations |
| Slice 2 | `b25f51c` | Accept-before-validate edge + spool + drainer |
| Slice 3 | `2da8f73` | Edge + durability tests |

---

## Self-Review vs Security + QA Gate Criteria

| Gate | Status |
|---|---|
| Every mutation has access-control guard + tenant-membership check | collector_spool: no RLS (intentional — pre-brand-context, per plan D-2). bronze_events: RLS FORCE + two-arg policy (NN-1). |
| Cursor pagination (no OFFSET) | No list endpoints in collector; drainer uses `ORDER BY id LIMIT $1` (keyset, not offset). |
| Money in minor units | No money in this service. |
| Trace ID end-to-end + on error responses | `X-Correlation-Id` header returned on every /collect response. `extractCorrelationId` used in route handler. |
| Rate limit on the edge path | Config param `RATE_LIMIT_EVENTS_PER_MINUTE` present in `CollectorEnvSchema`. Implementation is an M2 item (fastify-rate-limit plugin not wired yet — acceptable for M1 spool-only edge). |
| `brain_app` (not `brain` superuser) | PgSpoolRepository uses `DATABASE_URL` — must be configured with brain_app credentials. Dev uses brain superuser; RLS is not on spool so this is acceptable for dev. |
| ACK-before-validate ordering | PROVEN — code structure + test. |
| Redpanda-down durability | PROVEN — test with dead broker. |
| Additive migrations only | Both migrations create new tables, no DROP/ALTER on existing tables (I-E02). |
| NN-1 two-arg current_setting | bronze_events policy confirmed two-arg form. |

**Must-fix items (for Security+QA):**
- Rate limiting (`RATE_LIMIT_EVENTS_PER_MINUTE` is configured but not enforced yet — fastify-rate-limit plugin is an M2 item; acceptable for M1 given the spool-only edge).
- The drainer produces JSON, not Avro. Avro wire encoding with Apicurio schema ID is M2.

---

## Intended State

```
stage: 3 complete (Track B)
owner: security+qa
track_b: COMPLETE
track_a_note: stream-worker (Track A) consumed the contract fixes from Slice 1 (commit 0b1a342).
              Topic: dev.collector.event.v1. Data-engineer reads §contract above.
```
