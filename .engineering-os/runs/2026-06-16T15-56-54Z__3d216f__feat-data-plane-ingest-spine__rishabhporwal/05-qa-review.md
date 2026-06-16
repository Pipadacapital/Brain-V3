# QA Review — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 5 — QA |
| **Mode** | FULL |
| **Verdict** | FAIL (conditional — 1 blocking gap) |
| **QA Agent** | qa-engineer (claude-sonnet-4-6) |
| **Reviewed** | 2026-06-16T16:35:00Z |
| **Branch** | `feat/data-plane-ingest-spine` |

---

## Verdict: FAIL

**Blocking gap: no single end-to-end wire test** covering the full path (HTTP POST → spool → drainer → Kafka produce → stream-worker consumer → bronze_events row). All components are tested separately against real infra, but the integration across the spool→drainer→Kafka wire seam is not exercised in a single test. This is a required part of the Slice 4 acceptance contract.

**Non-blocking gaps**: Apicurio schema path resolution broken (wrong __dirname from tsx), DLQ path not covered by test, rate limit deferred.

All typechecks, contract tests, durability tests, e2e tests, real-network smoke, and isolation negative controls PASSED.

---

## Test Evidence

### 1. Typechecks

```
pnpm --filter @brain/contracts typecheck → EXIT 0
pnpm --filter @brain/events typecheck    → EXIT 0
pnpm --filter @brain/collector typecheck → EXIT 0
pnpm --filter @brain/stream-worker typecheck → EXIT 0
```

### 2. Migrations Applied

```sql
-- 0015 collector_spool:
relrowsecurity=f, relforcerowsecurity=f (no RLS — correct, pre-brand-validation)
brain_app grants: INSERT, SELECT, UPDATE
Partial index: idx_collector_spool_pending ON collector_spool (id) WHERE status='pending'

-- 0016 bronze_events:
relrowsecurity=t, relforcerowsecurity=t (FORCE RLS — correct)
Policy tenant_isolation: (brand_id = current_setting('app.current_brand_id', true)::uuid)
brain_app grants: INSERT, SELECT (append-only)
PK: (brand_id, event_id)
```

### 3. Contract Tests (8/8 PASS)

```
vitest run --reporter=verbose
✓ parses a valid event
✓ rejects an event without brand_id (I-S01 negative control)
✓ rejects an event without correlation_id (ADR-009 negative control)
✓ rejects an event without event_id
✓ rejects a non-UUID brand_id
✓ rejects a non-UUID event_id
✓ accepts optional fields when provided (ingested_at field confirmed — F-6 fix)
✓ defaults schema_version to "1"
Test Files  1 passed (1) | Tests  8 passed (8) | Duration 163ms
EXIT: 0
```

### 4. Durability Tests (5/5 PASS)

```
pnpm --filter @brain/collector run test:durability
✓ ACK ordering: POST /collect → HTTP 200 → spool row present (status=pending)
✓ /v1/events alias → HTTP 202 → spool row present
✓ Redpanda-down durability: dead broker localhost:19999 → produce fails → row stays pending; live-broker drain → row drained
✓ GET /healthz → 200 alive
✓ GET /readyz → 200 ready
Tests  5 passed (5) | Duration 59ms
EXIT: 0
```

Dead broker is REAL: `CollectorKafkaProducer({brokers: ['localhost:19999']})` — kafkajs attempts real TCP connect to port 19999 (refused), not a mock.

### 5. Stream-Worker E2E (4/4 PASS under brain_app)

```
BRAIN_APP_DATABASE_URL="postgresql://brain_app:brain_app@localhost:5432/brain" \
REDIS_URL="redis://localhost:6379" KAFKA_BROKERS="localhost:9092" \
pnpm --filter @brain/stream-worker run test:e2e

✓ E2E: produce event → pipeline → bronze_events row > inserts a row...
✓ Dedup/replay: same event_id delivered twice → exactly one row > Redis NX dedup...
✓ Dedup/replay: same event_id delivered twice → exactly one row > PK backstop...
✓ Isolation negative control (I-S01 / D-8 RLS / F-4) > brand_A row: brand_B GUC→0 rows...

Test Files  1 passed (1) | Tests  4 passed (4) | Duration 233ms
EXIT: 0
```

Tests assert `currentUser === 'brain_app'` and `currentUser !== 'brain'` (line 171-172, 200, 224, 253-254). Uses real Redis, real PG (as brain_app), real Kafka producer.

### 6. Real-Network Smoke (PASS)

```bash
node_modules/.bin/tsx apps/collector/src/main.ts &  # PORT=3099

GET  http://localhost:3099/healthz → 200 {"status":"alive","service":"collector","version":"0.0.0"}
GET  http://localhost:3099/readyz  → 200 {"status":"ready","service":"collector","version":"0.0.0","deps":{"spool_db":"ok"}}
POST http://localhost:3099/collect → 200 {"accepted":true,"received_at":"2026-06-16T16:34:44.892Z"}
  X-Correlation-Id: smoke-test-001
  X-Spool-Id: 13

# Spool row confirmed in DB:
SELECT id, status FROM collector_spool WHERE raw_body->>'event_id' = 'smoke0001-...';
  id=13 | status=pending ✓
```

Server bound to real TCP port. Real PG connection. Real Redpanda producer (drainer connected and started).

### 7. Isolation Negative Control (non-inert, confirmed RED)

```
-- Setup: superuser inserts brand_A row
INSERT INTO bronze_events (...) VALUES ('dd000099-...', 'aaaaaaaa-...', ...)

-- NEGATIVE CONTROL 1: wrong brand GUC → 0 rows (RED)
brain_app: SET app.current_brand_id='bbbbbbbb-...' → SELECT count(*) → 0

-- NEGATIVE CONTROL 2: no GUC → 0 rows (RED, NN-1 fail-closed)
brain_app: no GUC SET → SELECT count(*) → 0

-- PROOF of why superuser is the false-pass trap:
brain: SELECT count(*) → 1 (bypasses RLS)

-- POSITIVE CONTROL: correct brand GUC → 1 row (GREEN)
brain_app: SET app.current_brand_id='aaaaaaaa-...' → SELECT count(*) → 1
```

Test asserts `currentUser = 'brain_app'` and `currentUser != 'brain'` — satisfies F-4 and MEMORY note.

### 8. Validity Check

```
uv run validity_check.py --paths apps/stream-worker/src/tests apps/collector/tests \
  --artifacts qa-review.verdict.json --require-negative-control
→ validity_check: clean (2 files scanned)
EXIT: 0
```

Anti-pattern scan: no BYPASSRLS, no superuser DSN, no tautological asserts.
Negative control: present and non-empty in qa-review.verdict.json.

---

## Blocking Findings

### F-QA-01 (MEDIUM — blocking for full Slice 4 acceptance contract)
**Missing full-wire E2E test (HTTP→spool→drainer→Kafka→consumer→bronze)**

The Slice 4 acceptance contract (arch plan §6) requires:
> "E2E happy path: synthetic event POST → collector → spool → drainer → Redpanda → stream-worker → assert bronze_events row"

What exists:
- Collector durability test covers POST→spool→drainer (via DrainEventsUseCase.execute() directly, not through the running drainer loop)
- Stream-worker e2e test covers Kafka message → pipeline → bronze (via useCase.execute() directly, not through the running consumer)
- The two are NOT wired together in a single test

The gap: no test POSTs to the collector HTTP server, waits for the drainer to produce to Kafka, starts the stream-worker consumer, and asserts the bronze_events row. This is the architecture-plan §7 "real-network smoke" requirement for the full pipeline.

**Remediation**: Add a tests/e2e/pipeline.e2e.test.ts that:
1. POSTs to collector (live HTTP)
2. Polls collector_spool until status='drained' (or timeout)
3. Polls bronze_events for the row (via brain_app connection)
4. Asserts row present and currentUser='brain_app'

---

## Non-Blocking Findings

### F-QA-02 (LOW) — Apicurio schema path resolution
`import.meta.url` in collector main.ts resolves to a path outside the monorepo when using tsx from a non-root CWD. Smoke test log: `Could not load Avro schema file: ENOENT: no such file or directory, open '/Users/rishabhporwal/Desktop/packages/contracts/...'`. The collector degraded correctly (D-10), but Apicurio registration was skipped. Fix: use `new URL('../../../../packages/contracts/generated/avro/...', import.meta.url).pathname`.

### F-QA-03 (LOW) — DLQ path untested
`CollectorEventConsumer` MAX_RETRY→DLQ path is implemented but not covered by any automated test. Add a unit test with mocked BronzeRepository throwing 5 times.

### F-QA-04 (LOW) — TimeoutNegativeWarning in vitest
Non-fatal Node.js warning about a negative setInterval duration. Tests pass. Investigate kafkajs sessionTimeout computation.

### F-QA-05 (LOW) — Rate limiting deferred to M2
RATE_LIMIT_EVENTS_PER_MINUTE env var defined but fastify-rate-limit not wired. Accepted M2 deferral.

---

## In-Lane DoD Checklist

- [x] Every claim has captured command output (FULL mode)
- [x] Real-network smoke captured (collector on real port 3099)
- [x] Metric parity: N/A (no metric calculations in this feature)
- [x] Operational readiness: health endpoints verified (/healthz, /readyz)
- [ ] Mutation tests on high-stakes paths: NOT RUN — gap, but deferred (no mutation test runner configured in STACK.md for this repo)
- [x] Verification-validity confirmed: no bypass-green, no inert probe, no tautological parity
- [x] validity_check EXIT 0 with negative_control artifact
- [x] RLS isolation negative controls: 3 probes captured (wrong-brand, no-GUC, superuser-proof)
- [ ] Full-wire E2E smoke: MISSING (F-QA-01 — blocking)

---

## journal stub

```markdown
## 2026-06-16T16:35:00Z — QA Engineer — feat-data-plane-ingest-spine
**Stage:** 5 · **Mode:** FULL · **Verdict:** FAIL
**Smoke:** PASS (collector on port 3099, POST /collect → 200, spool row confirmed)
**Parity:** N/A (no cross-runtime metrics)
**Validity:** negative-controls confirmed (wrong-brand→0, no-GUC→0, superuser-bypass-proof)
**Next:** bounce to data-engineer/backend-developer — add full-wire E2E pipeline test; fix Apicurio schema path resolution
```

---

## DELTA Re-Review — 2026-06-16T20:58:30Z

**Mode:** DELTA (reasoning scope: F-QA-01 + regression; test scope: FULL prior suite)
**Prior verdict:** FAIL (blocking: F-QA-01)
**Delta verdict:** PASS

### F-QA-01 — RESOLVED

New test: `apps/stream-worker/src/tests/pipeline-wire.e2e.test.ts`

**Non-inert confirmation:** Test spawns collector as real child process (`spawn('pnpm', ['exec', 'tsx', ...])`), binds a real OS port (random, via `net.createServer().listen(0)`), sends a real TCP HTTP POST via `node:http`, polls `collector_spool` via real PG, and runs `CollectorEventConsumer` in-process consuming from real Redpanda. No `app.inject()` seam, no Kafka mock.

**Live run 2026-06-16T20:57:00Z (captured output):**

```
[pipeline-wire.e2e] collector ready on port 50281
[pipeline-wire.e2e] stream-worker consumer started
[pipeline-wire.e2e] POST /collect event_id=df150b29-1ea0-4260-9c72-b78040bfe0d6
[pipeline-wire.e2e] spool_id=15
[drainer] drained 1 event(s)
[stream-worker] written brand=aaaa1111-aaaa-4aaa-8aaa-111111111111 event=df150b29-1ea0-4260-9c72-b78040bfe0d6 partition=0 offset=14
[pipeline-wire.e2e] spool row drained — event produced to Redpanda
[pipeline-wire.e2e] bronze_events row found: event_id=df150b29-1ea0-4260-9c72-b78040bfe0d6 current_user=brain_app
[pipeline-wire.e2e] RLS negative control: wrong-brand GUC → 0 rows (expected 0)
✓ Full-wire pipeline E2E (F-QA-01) > event travels end-to-end: POST /collect → spool(drained) → Redpanda → stream-worker → bronze_events under brain_app 326ms
Test Files 1 passed (1) · Tests 1 passed (1) · Duration 38.55s
```

**Assertions confirmed:**
- `current_user = 'brain_app'` — NOT superuser `brain` (F-4 false-pass trap closed)
- Wrong-brand GUC (BRAND_B) → 0 rows (RLS negative control, asserted in test body)
- Full chain: POST → spool (drained) → Redpanda → stream-worker consumer → bronze_events

### F-QA-02 — RESOLVED

`apps/collector/src/main.ts` line 49: `fileURLToPath(new URL('../../../packages/contracts/generated/avro/...', import.meta.url))` — file-relative URL, CWD-independent.

### F-QA-03 — RESOLVED

```
dlq.unit.test.ts live run 2026-06-16T20:56:46Z:
✓ CollectorEventConsumer — DLQ routing (F-QA-03) > routes message to DLQ after MAX_RETRY=5... 5ms
Test Files 1 passed (1) · Tests 1 passed (1) · Duration 106ms
```

Asserts: useCase called 5×, DLQ topic `dev.collector.event.v1.dlq` receives 1 message, `x-dlq-reason` header contains `max_retry_exceeded`, offset committed to `43` (current+1) after DLQ produce.

### Regression Suite

| Test | Prior | Delta |
|---|---|---|
| bronze.e2e.test.ts (4 tests) | PASS | PASS (4/4, 224ms) |
| collector test:durability (5 tests) | PASS | PASS (5/5, 288ms) |
| dlq.unit.test.ts (1 test) | NEW | PASS (1/1, 106ms) |
| pipeline-wire.e2e.test.ts (1 test) | NEW | PASS (1/1, 38.55s) |

### Checks

| Gate | Result |
|---|---|
| Typecheck @brain/stream-worker | EXIT 0 |
| validity_check --require-negative-control (3 files) | EXIT 0 — clean |
| RLS negative control in pipeline-wire.e2e.test.ts | CONFIRMED (wrong-brand GUC → 0 rows, asserted in test body) |
| current_user = 'brain_app' asserted | CONFIRMED (line 370-371 of pipeline-wire.e2e.test.ts) |

### Open (non-blocking, unchanged)

- F-QA-04: TimeoutNegativeWarning from kafkajs internals (non-blocking, tests pass)
- F-QA-05: Rate limiting deferred to M2 (accepted)

---

## journal stub

```markdown
## 2026-06-16T20:58:30Z — QA Engineer — feat-data-plane-ingest-spine
**Stage:** 5 · **Mode:** DELTA (reasoning); FULL suite (tests) · **Verdict:** PASS
**Smoke:** PASS (pipeline-wire.e2e.test.ts — real subprocess, real TCP, real Redpanda, real PG as brain_app)
**Parity:** N/A
**Validity:** negative-controls confirmed in test body (wrong-brand GUC → 0 rows; current_user='brain_app' asserted)
**Next:** HANDOFF → Security Reviewer reconcile (no new security surface in this delta)
```
