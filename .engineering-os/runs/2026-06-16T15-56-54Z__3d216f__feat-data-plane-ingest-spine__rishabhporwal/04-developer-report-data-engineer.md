# Developer Report — Data Engineer (Track A)
# feat-data-plane-ingest-spine · Stage 3

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 3 — implementation (Track A, data-engineer) |
| **Track** | A — stream-worker pipeline + Bronze sink + Redis dedup |
| **Branch** | `feat/data-plane-ingest-spine` |
| **Date** | 2026-06-16 |

---

## Files Produced / Modified

### Slice 1 — Migration 0016_bronze_events (committed by backend-developer track in same slice commit `0b1a342`)

- `/Users/rishabhporwal/Desktop/Brain V3/db/migrations/0016_bronze_events.sql` — Bronze staging table; FORCE ROW LEVEL SECURITY; two-arg `current_setting` (NN-1); INSERT+SELECT only grant (append-only); PK `(brand_id, event_id)` idempotency backstop.
- `/Users/rishabhporwal/Desktop/Brain V3/db/migrations/0015_collector_spool.sql` — Collector spool (no RLS; INSERT+SELECT+UPDATE for drainer).

### Slice 2 — Stream-worker pipeline (commit `69f5892`)

DDD structure under `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/`:

- `domain/bronze/BronzeRow.ts` — Value object mirroring `bronze_spec.json` field-for-field.
- `domain/bronze/DedupPolicy.ts` — Dedup key `dedup:{brand_id}:{event_id}` + TTL 604800s.
- `infrastructure/redis/RedisDedupAdapter.ts` — Redis SET NX EX (tenant-prefixed key, I-S01).
- `infrastructure/pg/BronzeRepository.ts` — INSERT under `brain_app` + `set_config` GUC per transaction (D-8, NN-1 two-arg).
- `infrastructure/kafka/DlqProducer.ts` — DLQ produce after MAX_RETRY=5 (D-7).
- `application/ProcessEventUseCase.ts` — Pipeline: Zod parse → Redis dedup → BronzeRepository write; M1-local Zod (not Apicurio per §3 simplification). M2 marker present.
- `interfaces/consumers/CollectorEventConsumer.ts` — KafkaJS consumer; `autoCommit: false`; offset committed ONLY after confirmed write/dedup/DLQ (D-7 invariant).
- `main.ts` — Entrypoint; graceful SIGTERM/SIGINT drain.
- `package.json` — Added `ioredis`, `pg`, `@brain/db` deps; `test:e2e` script.

### Slice 3 — Tests (commit `258c258`)

- `src/tests/bronze.e2e.test.ts` — 4 live tests against real infra.
- `vitest.config.ts` — Test config.

---

## Slice Dispositions

| Slice | Status | Commit |
|---|---|---|
| 1 — Migration 0016 | APPLIED + RLS-FORCE verified | `0b1a342` (backend-developer drove; data-engineer verified shape) |
| 2 — stream-worker pipeline | COMPLETE; typecheck EXIT 0 | `69f5892` |
| 3 — Tests (e2e + dedup + isolation) | 4/4 PASS on live infra | `258c258` |

---

## Contract Section

The stream-worker consumes from `dev.collector.event.v1`. Contract field names consumed:

| Field | Source | Usage |
|---|---|---|
| `brand_id` | `CollectorEventV1Schema` (Zod) | Tenant key — RLS GUC, dedup key prefix, bronze_events PK |
| `event_id` | `CollectorEventV1Schema` | Idempotency key — dedup key suffix, bronze_events PK |
| `occurred_at` | `CollectorEventV1Schema` (ISO-8601 string) | Converted to `timestamptz` at bronze write boundary (D-6) |
| `ingested_at` | `CollectorEventV1Schema` (renamed from `ingest_at` per F-6) | Converted to `timestamptz` at bronze write boundary |
| `correlation_id` | `CollectorEventV1Schema` | Propagated to bronze_events (ADR-009) |
| `event_name` | `CollectorEventV1Schema` | Written as `event_type` in bronze_events |
| `properties` | `CollectorEventV1Schema` | Included in `payload` JSONB (no raw PII, I-S02) |
| `schema_version` | M1 literal `1` | Written as `schema_version=1`; Apicurio-resolved version is M2 |
| `schema_name` | M1 literal `'brain.collector.event.v1'` | Written as `schema_name`; F-10 marker |

**Contract mismatch notes for reconciliation with backend Track B:**
- The `CollectorEventV1Schema` uses `event_name` (not `event_type`). The bronze_events column is `event_type`. The stream-worker maps `event_name → event_type`. If the drainer produces events with a different field name, the Zod parse will still succeed (Zod parses `event_name`) and the mapping is transparent.
- `ingested_at` field was renamed from `ingest_at` (F-6, now fixed in the contract per git diff). The stream-worker uses `ingested_at`.

---

## Verification Output (real, live infra)

### 1. Migration 0016 applied + RLS-FORCE verified under `SET ROLE brain_app`

```
-- Verified via docker exec brainv3-postgres-1 psql:

SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'bronze_events';
     relname     | relrowsecurity | relforcerowsecurity
-----------------+----------------+---------------------
 bronze_events   | t              | t

SELECT tablename, policyname, roles, qual FROM pg_policies WHERE tablename = 'bronze_events';
   tablename   |    policyname    |    roles    |                                   qual
---------------+------------------+-------------+--------------------------------------------------------------------------
 bronze_events | tenant_isolation | {brain_app} | (brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)

SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'bronze_events' AND grantee = 'brain_app';
  grantee  | privilege_type
-----------+----------------
 brain_app | INSERT
 brain_app | SELECT
```

### 2. typecheck EXIT 0

```
> @brain/stream-worker@0.0.0 typecheck /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker
> tsc --noEmit
[exit 0]
```

### 3. Tests — 4/4 PASS on live Redpanda + Redis + PG

```
> @brain/stream-worker@0.0.0 test:e2e
> vitest run --no-file-parallelism src/tests/bronze.e2e.test.ts

 RUN  v2.1.9

 ✓ E2E: produce event → pipeline → bronze_events row > inserts a row... 
 ✓ Dedup/replay: same event_id delivered twice → exactly one row > Redis NX dedup...
 ✓ Dedup/replay: same event_id delivered twice → exactly one row > PK backstop...
 ✓ Isolation negative control (I-S01 / D-8 RLS / F-4) > brand_A row: brand_B GUC→0 rows...

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  233ms
```

---

## Isolation Proof Under `brain_app` (not superuser `brain`)

Verified via tests and direct psql:

```sql
-- No GUC → 0 rows (fail-closed, NN-1)
SET ROLE brain_app;
SELECT current_user;           -- brain_app
SELECT count(*) FROM bronze_events;  -- 0

-- Wrong brand GUC → 0 rows
SELECT set_config('app.current_brand_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
SELECT count(*) FROM bronze_events;  -- 0

-- Correct brand GUC → 1 row
SELECT set_config('app.current_brand_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT count(*) FROM bronze_events;  -- 1
RESET ROLE;
```

Tests assert `currentUser === 'brain_app'` and `currentUser !== 'brain'` before each isolation check — false-pass prevention (F-4, MEMORY note).

---

---

## BOUNCE r1 — 2026-06-16T21:00:00Z (Data Engineer delta fixes)

### SR-01 fix — Raw Redis keys in test (lint gate)

**Finding:** `no-raw-redis-key` (NN-7) ESLint rule flagged 3 template-literal Redis keys in `bronze.e2e.test.ts` at lines 114, 115, 217.

**Fix:** Imported `buildDedupKey` from `../domain/bronze/DedupPolicy.js` and replaced all 3 call sites:
- `redisClient.del(\`dedup:${BRAND_A}:${eventId}\`)` → `redisClient.del(buildDedupKey(BRAND_A, eventId))`
- `redisClient.del(\`dedup:${BRAND_B}:${eventId}\`)` → `redisClient.del(buildDedupKey(BRAND_B, eventId))`
- `redisClient.del(\`dedup:${BRAND_A}:${DEDUP_EVENT_ID}\`)` → `redisClient.del(buildDedupKey(BRAND_A, DEDUP_EVENT_ID))`

**Proof:**
```
> @brain/stream-worker@0.0.0 lint
> eslint .
[exit 0, 0 errors]
```

**Commit:** `3567196`

---

### F-QA-02 fix — Avro schema path ENOENT

**Finding:** `join(__dirname, '../../../../packages/contracts/...')` resolved outside the monorepo root when CWD was not the repo root. 4 levels up from `apps/collector/src/` overshoots to `Desktop/`.

**Fix:** Replaced with `fileURLToPath(new URL('../../../packages/contracts/generated/avro/brain.collector.event.v1.avsc', import.meta.url))`. 3 levels up from the source file always resolves correctly regardless of CWD.

**Proof:**
```
node -e "
  const { URL, pathToFileURL, fileURLToPath } = require('url');
  const url = pathToFileURL('/Users/rishabhporwal/Desktop/Brain V3/apps/collector/src/main.ts').href;
  const path = fileURLToPath(new URL('../../../packages/contracts/generated/avro/brain.collector.event.v1.avsc', url));
  console.log('exists:', require('fs').existsSync(path)); // true
"
# → exists: true

> @brain/collector@0.0.0 typecheck
> tsc --noEmit
[exit 0]
```

**Commit:** `6e3fd83`

---

### F-QA-01 fix — Full-wire e2e test

**Finding:** No single test exercised POST /collect → spool → drainer → Redpanda → stream-worker consumer → bronze_events as one chain.

**Fix:** Added `apps/stream-worker/src/tests/pipeline-wire.e2e.test.ts`. The test:
1. Spawns a real collector subprocess (`tsx`) on an OS-assigned port with `APICURIO_REGISTRY_URL=http://127.0.0.1:9` to fast-fail Apicurio (degrades gracefully per D-10) so the HTTP listener opens after ~32s backoff.
2. POSTs to `POST /collect` via real TCP (`http.request`), verifies `HTTP 200 + {accepted: true}`.
3. Polls `collector_spool` (superuser pool) until `status='drained'` — confirms drainer produced to Redpanda.
4. Starts `CollectorEventConsumer` in-process, polls `bronze_events` under `brain_app + correct-brand GUC`.
5. Asserts `event_id` arrived, `current_user='brain_app'` (not 'brain'), and wrong-brand GUC → 0 rows (RLS negative control).
Skips gracefully if Redpanda/PG/Redis are unreachable. `vitest hookTimeout/testTimeout` raised to 120s.

**Proof — test output (real run):**
```
[pipeline-wire.e2e] collector ready on port 64956
[pipeline-wire.e2e] POST /collect event_id=7b7618ab-7a3d-428f-99b2-25e7be4d2d4b
[pipeline-wire.e2e] spool_id=14
[drainer] drained 1 event(s)
[stream-worker] written brand=aaaa1111-aaaa-4aaa-8aaa-111111111111 event=7b7618ab-7a3d-428f-99b2-25e7be4d2d4b partition=0 offset=13
[pipeline-wire.e2e] spool row drained — event produced to Redpanda
[pipeline-wire.e2e] bronze_events row found: event_id=7b7618ab-7a3d-428f-99b2-25e7be4d2d4b current_user=brain_app
[pipeline-wire.e2e] RLS negative control: wrong-brand GUC → 0 rows (expected 0)
 ✓ event travels end-to-end: POST /collect → spool(drained) → Redpanda → stream-worker → bronze_events under brain_app 328ms
 Test Files  1 passed (1)
     Tests  1 passed (1)
```

**Commit:** `dcf2d55`

---

### F-QA-03 fix — DLQ unit test

**Finding:** DLQ routing path (MAX_RETRY=5 → DLQ produce → offset commit) not covered by any test.

**Fix:** Added `apps/stream-worker/src/tests/dlq.unit.test.ts`. Mocks `ProcessEventUseCase.execute` to throw on every call, delivers the same (partition=0, offset=42) message 5 times, and asserts:
- Offset NOT committed on attempts 1-4 (D-7)
- DLQ message produced to `dev.collector.event.v1.dlq` with `x-dlq-reason=max_retry_exceeded` header on attempt 5
- Offset committed to '43' AFTER DLQ produce (D-7)
No live infra required.

**Proof:**
```
 ✓ CollectorEventConsumer — DLQ routing (F-QA-03) > routes message to DLQ after MAX_RETRY=5 BronzeRepository errors and commits offset
[stream-worker] DLQ (max retry) partition=0 offset=42
 Test Files  1 passed (1) / Tests  1 passed (1) / Duration  168ms
```

**Commit:** `0fb9119`

---

## In-Lane DoD Checklist

- [x] Pipeline tenant-keyed end to end: `brand_id` in Redis dedup key prefix, bronze_events RLS, Postgres PK.
- [x] Exactly-once (idempotent): Redis NX (first line) + PK ON CONFLICT DO NOTHING (durable backstop).
- [x] Output replayable from stream/lakehouse: bronze_events is append-only; same event re-delivered = dedup-hit.
- [x] Offset commit ONLY after confirmed write (D-7): `autoCommit: false`; manual commit after each outcome.
- [x] DLQ after MAX_RETRY=5: routed to `dev.collector.event.v1.dlq`, then commit.
- [x] RLS: FORCE ROW LEVEL SECURITY; two-arg `current_setting` (NN-1); fail-closed.
- [x] Connects as `brain_app` not `brain`; tests assert `current_user = 'brain_app'`.
- [x] Typecheck EXIT 0.
- [x] 4/4 tests pass on live infra.
