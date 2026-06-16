# Security Review — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 4 — Security Review |
| **Reviewer** | security-reviewer |
| **Mode** | FULL (first review of this surface; high_stakes: multi_tenancy, connectors, schema_proto, durability_spool) |
| **Verdict** | **BOUNCE (FAIL)** |
| **Blocking findings** | 1 HIGH (SR-01) |
| **Date** | 2026-06-16 |

---

## Scope

Branch `feat/data-plane-ingest-spine` vs `master`. Diff covers 42 files, 3035 insertions. Primary surfaces:

- `db/migrations/0015_collector_spool.sql` + `0016_bronze_events.sql`
- `apps/collector/src/` (all new code)
- `apps/stream-worker/src/` (all new code)
- `packages/contracts/src/events/sample.collector.event.v1.ts` (field rename)
- `packages/events/src/index.ts` (type fix)

---

## P0 Bronze Isolation Verification — PASS (Live DB proof)

Verified directly against `brainv3-postgres-1` under `SET ROLE brain_app` (not superuser `brain`):

```
-- relrowsecurity=t, relforcerowsecurity=t: confirmed
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='bronze_events';
→ t | t

-- Policy: two-arg form confirmed (NN-1 pass)
(brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)
→ roles: {brain_app}

-- Negative control 1: no GUC → 0 rows (fail-closed)
SET ROLE brain_app; SELECT count(*) FROM bronze_events WHERE event_id='deadbeef...'; → 0

-- Negative control 2: wrong brand GUC → 0 rows
SET ROLE brain_app; SELECT set_config('app.current_brand_id','cccc...',false);
SELECT count(*) FROM bronze_events WHERE event_id='deadbeef...'; → 0

-- Positive control: correct brand GUC → 1 row
SET ROLE brain_app; SELECT set_config('app.current_brand_id','aaaa...',false);
SELECT count(*) FROM bronze_events WHERE event_id='deadbeef...'; → 1

-- Grants: brain_app has INSERT + SELECT only (no UPDATE/DELETE — append-only enforced at GRANT level)
```

RLS is correctly implemented. `current_user` confirmed `brain_app` in all three probes. FORCE ROW LEVEL SECURITY prevents table-owner bypass.

---

## Accept-Before-Validate (D-1) — CONFIRMED

Structural proof (code, not just test assertions):

1. `collect.route.ts` imports only `AcceptEventUseCase` and `extractCorrelationId`. Zero Kafka/Avro/Apicurio imports at `apps/collector/src/interfaces/rest/collect.route.ts`.
2. `accept-event.usecase.ts` imports only `stampEnvelope` and `SpoolRepository`. No `kafkajs` import path exists in this file.
3. `kafkajs` is declared in `apps/collector/package.json` deps (used by the drainer), but the import chain from the HTTP handler does NOT reach it.
4. ESLint passes cleanly on the collector (`pnpm --filter @brain/collector lint` → 0 errors).
5. Drainer starts in `main.ts` AFTER `app.listen()` returns — structurally after HTTP is accepting connections.

Accept-before-validate ordering is proven by import structure, not just test pass.

---

## Durability (F-3/D-1) — REAL, NOT MOCKED

`apps/collector/tests/durability.test.ts` test "Redpanda-down durability":

- Constructs `CollectorKafkaProducer` with `brokers: ['localhost:19999']` — a guaranteed-dead port.
- `kafkajs` performs actual TCP connect to `localhost:19999`; connection is refused; produce throws.
- `DrainEventsUseCase` catches the error; returns `drained=0`; spool row stays `status='pending'`.
- Recovery: live broker `localhost:9092` used; `drainedOnRecovery >= 1`; specific row becomes `'drained'`.

Ran live: 5/5 PASS with stderr showing `[drainer] produce failed for spool id=10: Error: [kafka] producer not connected` — the dead-broker path is definitively exercised.

---

## Dedup/Idempotency (D-3/D-7/F-5) — OK

- Redis key `dedup:{brand_id}:{event_id}` is tenant-prefixed (cross-brand collision impossible).
- `SET NX EX 604800` is atomic (no GET+SET race).
- `ON CONFLICT (brand_id, event_id) DO NOTHING` provides durable second layer if Redis misses.
- Offset committed ONLY after: (a) confirmed Bronze write, (b) confirmed dedup-hit, or (c) confirmed DLQ produce. `autoCommit: false` enforced in `CollectorEventConsumer`.
- Live test confirms: Redis NX → dedup_hit; manual Redis key delete → PK backstop fires; both paths → exactly 1 row.

---

## Field Name / Type Contract (F-1/F-6/D-5/D-6) — RESOLVED

- `ingest_at → ingested_at` renamed in Zod contract, test, codegen, Avro artifact. Confirmed in diff.
- `occurred_at: number` → `occurred_at: string` (ISO-8601) in `CollectorEventEnvelope`. Confirmed in `packages/events/src/index.ts`.
- `event_name → event_type` mapping in `ProcessEventUseCase.ts:92` is explicit, consistent, and documented.
- Avro `.avsc` regenerated and committed in same commit as Zod change (I-E01 satisfied).

---

## Iceberg Target Files (D-4) — UNTOUCHED

`git diff master..HEAD -- 'db/iceberg/'` produces zero output. `db/iceberg/bronze_table.sql`, `bronze_spec.json`, `schema-evolution-policy.md` are unchanged. D-4 amendment to ADR-003 is correctly noted in the architecture plan header of `0016_bronze_events.sql` as a dev/M1 staging mirror, not an edit to the Phase-3 target spec.

---

## Findings

### SR-01 — HIGH — ESLint NN-7 violation: raw Redis key construction in test file

**File:** `apps/stream-worker/src/tests/bronze.e2e.test.ts:114,115,217`

**Evidence:**
```
pnpm --filter @brain/stream-worker lint
→ 3 errors: "brain-redis/no-raw-redis-key"
  114:27  error  Raw Redis key construction detected. Use brandKey() ...
  115:27  error  Raw Redis key construction detected. ...
  217:27  error  Raw Redis key construction detected. ...
```

The test cleanup function constructs raw Redis keys via template literals:
```typescript
await redisClient.del(`dedup:${BRAND_A}:${eventId}`);  // line 114 — ERROR
await redisClient.del(`dedup:${BRAND_B}:${eventId}`);  // line 115 — ERROR
await redisClient.del(`dedup:${BRAND_A}:${DEDUP_EVENT_ID}`);  // line 217 — ERROR
```

**Severity:** HIGH. INVARIANTS.md anti-pattern §"Security" states: "No raw Redis keys built outside `tenant-context.brandKey()`. Raw key construction in application code is lint-banned." The `no-raw-redis-key` ESLint rule (`tools/eslint-rules/no-raw-redis-key.mjs`) fires on `redisClient.del(templateLiteral)`. This is an active CI gate failure — the lint step blocks merge.

**Note:** The `DedupPolicy.buildDedupKey()` function in production code itself uses a template literal (`dedup:${brandId}:${eventId}`) but passes it as a variable to `this.redis.set(key, ...)` — the ESLint rule passes on Identifier nodes (not raw construction at the call site). The production code is clean; only the test is failing. However, the lint CI gate is breaking on the test file and this constitutes a blocking finding.

**Fix:** Replace raw `redisClient.del(\`dedup:${BRAND_A}:...\`)` calls in the test cleanup with calls to `buildDedupKey(BRAND_A, eventId)` from `DedupPolicy`, using the key as a variable:
```typescript
import { buildDedupKey } from '../domain/bronze/DedupPolicy.js';
// ...
await redisClient.del(buildDedupKey(BRAND_A, eventId));  // passes lint (Identifier)
```

Additionally, consider whether `DedupPolicy.buildDedupKey()` itself should be extended to a `buildDedupKey()` variant that is registered in `tenant-context` or whether the lint rule's exception for `Identifier` nodes is the intended exception path for this namespace. If the lint rule is intended to cover all namespaces, a suppression comment with a reason and expiry must be added; if not (dedup keys are a different namespace from metric cache keys), document the exemption in the rule itself. For M1 the minimal fix is using the variable form.

---

### SR-02 — MEDIUM — No-GUC isolation negative control does not prove fail-closed (null GUC) due to session-scoped GUC leakage via pool connection reuse

**File:** `apps/stream-worker/src/tests/bronze.e2e.test.ts:256-262`

**Evidence:** The `readBronzeAsApp` helper uses `set_config('app.current_brand_id', $1, false)` — the third argument `false` means session scope, not transaction scope. When the pool client is released and reused for the next `readBronzeAsApp(eventId, null)` call (Case 2 in the isolation test), the session-level GUC from Case 1 (brand_B UUID) persists on the reused connection. Confirmed via psql:

```sql
SET ROLE brain_app;
SELECT set_config('app.current_brand_id','bbbb...', false);
RESET ROLE;
SELECT current_setting('app.current_brand_id', true);
→ 'bbbb...'  -- GUC still set after RESET ROLE on same connection
```

Case 2 asserts `noGuc === 0`, which passes — but because brand_B ≠ brand_A (not because the GUC is null). The NN-1 fail-closed property (null GUC → `brand_id = NULL` → false → 0 rows) is not what is tested. The test passes for the right result but through the wrong mechanism.

**Severity:** MEDIUM. The isolation test does pass and no false positive on isolation exists (brand_B GUC producing 0 rows is a valid isolation assertion). However, the stated purpose of Case 2 — proving null-GUC fail-closed — is not demonstrated. A future regression that removes FORCE RLS would not be caught by this test.

**Fix:** Use `set_config('app.current_brand_id', $1, true)` (transaction-scoped, third arg = `true`) in `readBronzeAsApp`, and wrap each call in an explicit `BEGIN`/`COMMIT` block, OR open a fresh connection for each readBronzeAsApp call rather than using a pool. Alternatively, for the null case specifically: assert `current_setting('app.current_brand_id', true) IS NULL` at the start of the no-GUC probe to confirm no GUC is set.

---

### SR-03 — MEDIUM — collector_spool.raw_body stores unvalidated caller-supplied body including potential PII

**File:** `apps/collector/src/infrastructure/pg-spool.repository.ts:38-46`

The collector spools `{ ...envelope.rawBody, _received_at }` as JSONB. Since the handler accepts and spools any body without validation (D-1 by design), a caller can POST arbitrary fields including raw PII (`email`, `phone`, `name`) and they land in `collector_spool.raw_body`.

**Severity:** MEDIUM. `collector_spool` is a temporary staging table (no RLS, not an SoR) and rows are drained and marked `'drained'` but not deleted. The spool accumulates all raw bodies. For the M1 synthetic event scope, the Zod contract schema (`CollectorEventV1Schema`) does not permit raw PII fields, so compliant callers cannot submit PII. However:
1. There is no enforcement that callers are compliant (the handler accepts any body).
2. The `hashed_user_id` / `hashed_session_id` fields in the schema are hashed — correct.
3. A malicious or misconfigured caller could POST `{ email: "user@example.com", brand_id: "..." }` and it would be spooled.

This is acceptable for M1 with two conditions: (a) the spool is treated as transient staging only with a housekeeping job TTL (currently not defined — the migration comments say "archival is a future housekeeping job"), and (b) the collector is behind an API gateway or write-key auth that only allows compliant clients. For M1 internal-only scope this is deferred-acceptable but must be tracked.

**Recommended action:** Track as tech-debt. Add to the M2 backlog: (a) spool housekeeping job (delete `status='drained'` rows older than 7 days), and (b) document that the collector must sit behind API gateway / write-key authentication before accepting external traffic.

---

### SR-04 — LOW — Rate limiting configured but not enforced

**File:** `apps/collector/src/main.ts` / `CollectorEnvSchema` in `@brain/config`

`RATE_LIMIT_EVENTS_PER_MINUTE` is defined in the env schema but the `fastify-rate-limit` plugin is not registered. The developer report correctly flags this as an M2 item and it is acceptable for M1 (internal synthetic event only, behind no external traffic). Note for M2: an unbounded spool write target with no rate limiting is a DoS vector when exposed to external callers.

---

### SR-05 — INFO — TimeoutNegativeWarning in test output

Both test suites emit `TimeoutNegativeWarning: -1781627533435 is a negative number. Timeout duration was set to 1.` This indicates a vitest timeout calculation overflow, likely when the test completes faster than the configured timeout. Tests still pass. This is cosmetic noise but worth fixing to avoid masking real timeout issues.

---

## Security Checklist

| Gate | Result | Evidence |
|---|---|---|
| Bronze RLS FORCE + two-arg current_setting | PASS | Live psql proof; `relforcerowsecurity=t`; policy qual confirmed two-arg |
| Under `SET ROLE brain_app` NOT superuser `brain` | PASS | Live psql + test assertion `currentUser === 'brain_app'` |
| No-GUC → 0 rows (fail-closed) | PARTIAL — see SR-02 | Live psql proves it; test doesn't cleanly prove it |
| Wrong-brand GUC → 0 rows | PASS | Live psql + test |
| Correct-brand GUC → 1 row | PASS | Live psql + test |
| Accept-before-validate (no Kafka in handler) | PASS | Import structure + ESLint clean on collector |
| Durability real (dead broker, not mock) | PASS | Test uses unreachable port; stderr confirms TCP fail |
| Offset commit after Bronze write | PASS | `autoCommit: false` + manual commit after outcome |
| Dedup Redis NX tenant-prefixed | PASS | `dedup:{brand_id}:{event_id}` format |
| Dedup PK backstop | PASS | `ON CONFLICT (brand_id, event_id) DO NOTHING` |
| event_name → event_type consistent | PASS | ProcessEventUseCase:92 explicit mapping; schema field confirmed |
| ingested_at canonical (not ingest_at) | PASS | Zod, Avro, test all use ingested_at |
| No hardcoded secrets in diff | PASS | SASL credentials from env vars via CollectorEnvSchema |
| Iceberg target files untouched | PASS | `git diff master..HEAD -- db/iceberg/` = empty |
| Migrations additive only | PASS | New tables only; no DROP/ALTER on existing |
| Append-only Bronze at GRANT level | PASS | brain_app: INSERT+SELECT only; no UPDATE/DELETE |
| PII in payload | PASS | Only hashed identifiers (hashed_user_id, hashed_session_id) |
| NN-7 lint (raw Redis keys) | FAIL | 3 errors in test file (SR-01) |
| No raw PII in logs | PASS | Log statements use IDs and outcome strings, not event bodies |
| Correlation ID propagation | PASS | X-Correlation-Id on all /collect and /v1/events responses |
| Body size limit | PASS | `bodyLimit: 1024 * 1024` (1 MiB) on Fastify |
| Rate limiting | NOT WIRED (M2) | Config present, plugin not registered (acceptable M1) |
| Consent flags on Bronze row | NOT IN SCOPE M1 | M1 synthetic event; consent_flags on customer topics is M2 |

---

## Summary

The implementation is substantively correct on the security properties that matter most:

- Bronze tenant isolation is real, live-proven, and fail-closed.
- Accept-before-validate is structurally enforced (import graph, not just test).
- Durability test uses a genuinely dead broker.
- Dedup is two-layer and tenant-prefixed.
- No secrets in code; no PII in logs; additive migrations only.

**One HIGH blocking finding (SR-01):** The ESLint `no-raw-redis-key` (NN-7) rule is actively failing CI on 3 lines in the test cleanup function. This is a lint gate failure. The fix is mechanical: replace template literal Redis key construction with `buildDedupKey(...)` variable form.

**Two MEDIUM findings (SR-02, SR-03):** The no-GUC negative control is imprecise (but the isolation itself is sound); the spool stores unvalidated bodies (acceptable for M1 internal scope with tech-debt tracking).

**Verdict: BOUNCE.** Fix SR-01 (HIGH), note SR-02 and SR-03 as tech-debt entries, then return for DELTA re-review.


---

## DELTA Re-Review — 2026-06-16T21:10:00Z

| Field | Value |
|---|---|
| **Mode** | DELTA (bounce-fix re-review) |
| **Verdict** | **PASS** |
| **Scope** | SR-01 closure + SR-02/SR-03/SR-04 disposition |
| **Diff since BOUNCE** | Commits 3567196, 6e3fd83, dcf2d55, 0fb9119, ef78505 |
| **Lint** | `pnpm --filter @brain/stream-worker lint` → 0 errors (exit 0) |
| **Blocking findings** | 0 |

### SR-01 — RESOLVED

**Evidence:** Commit 3567196 (`fix(SR-01)`): the three raw template-literal Redis key constructions at `bronze.e2e.test.ts:114,115,217` are replaced with `buildDedupKey(BRAND_A, eventId)` / `buildDedupKey(BRAND_B, eventId)` / `buildDedupKey(BRAND_A, DEDUP_EVENT_ID)` imported from `domain/bronze/DedupPolicy.js`. Delta lint run confirms 0 NN-7 violations. Only 1 file changed in that commit (`apps/stream-worker/src/tests/bronze.e2e.test.ts`, 4 insertions / 3 deletions). Test-only change; no production code altered.

### Regression check — CLEAN

Commits since the BOUNCE (`3567196`, `6e3fd83`, `dcf2d55`, `0fb9119`, `ef78505`) touch:
- `apps/stream-worker/src/tests/bronze.e2e.test.ts` — fix only (test cleanup keys)
- `apps/collector/src/main.ts` — Avro schema path resolution (CWD-independent `import.meta.url` fix; no auth/RLS/isolation logic)
- `apps/stream-worker/src/tests/pipeline-wire.e2e.test.ts` — new full-wire E2E test (additive)
- `apps/stream-worker/src/tests/dlq.unit.test.ts` — new DLQ unit test (additive)
- `apps/stream-worker/vitest.config.ts` — timeout raised to 120s
- `.engineering-os/live.log` + developer report (docs only)

`git diff 6fb8768..HEAD -- db/migrations/` = empty. Bronze RLS migration (`0015`, `0016`) untouched. No production isolation, RLS, or secrets code weakened.

### SR-02 — SHIP-AS-TECHDEBT (disposition confirmed)

The bounce-fix added `pipeline-wire.e2e.test.ts` Step 5: a wrong-brand GUC negative control executed on a dedicated `wrongBrandClient` connection (not a pool-reuse path), asserting `wrongBrandCount === 0` under `brain_app`. This strengthens the wrong-brand isolation probe as a full-wire assertion. The null-GUC fail-closed path in `bronze.e2e.test.ts` Case 2 remains imprecise (session-scope `set_config(..., false)` means a prior brand_B GUC persists; the 0-row result is correct isolation, but it's proving wrong-brand≠right-brand, not null→fail-closed). RLS FORCE property is correct in production; this is a test-precision gap only. Deferred to M2: fix `readBronzeAsApp` to use `set_config(..., true)` (transaction-scope) + explicit `BEGIN`/`COMMIT`, or open a fresh connection per call, to prove the null-GUC case cleanly.

### SR-03 — SHIP-AS-TECHDEBT (M2)

No change from FULL review disposition. M1 internal synthetic event scope; Zod contract enforces hashed identifiers. M2 items: spool housekeeping job (delete `status='drained'` rows >7 days); collector must be behind API gateway/write-key auth before external traffic.

### SR-04 — SHIP-AS-TECHDEBT (M2)

No change from FULL review disposition. M1 internal only; no external traffic. M2: register `fastify-rate-limit` using `RATE_LIMIT_EVENTS_PER_MINUTE` before external exposure.

### No new findings introduced by bounce

Secrets grep on new files (`pipeline-wire.e2e.test.ts`, `dlq.unit.test.ts`): 0 hardcoded secrets. All credentials from env vars. No new mutation endpoints, MCP tools, connectors, or outbound channels introduced by the bounce commits.

### DELTA Security Checklist

| Gate | Result |
|---|---|
| SR-01 lint NN-7 clean | PASS — 0 errors |
| Test-only change (no prod regression) | PASS — migrations untouched; no RLS/isolation code altered |
| SR-02 null-GUC precision | PARTIAL — wrong-brand probe strengthened (pipeline-wire); null-GUC imprecision deferred M2 |
| SR-03 spool PII | DEFERRED M2 — acceptable M1 internal scope |
| SR-04 rate-limit | DEFERRED M2 — acceptable M1 internal scope |
| New secrets in bounce commits | PASS — none found |
| New endpoints/tools/connectors in bounce | PASS — none; test + path-fix + docs only |
| Verification validity (no bypass-green probes) | PASS — brain_app asserted; `current_user != 'brain'` in all isolation probes |

**Verdict: PASS.** SR-01 (HIGH) closed. 0 open CRITICAL/HIGH. Two MEDs and one LOW deferred as tracked tech-debt for M2.
