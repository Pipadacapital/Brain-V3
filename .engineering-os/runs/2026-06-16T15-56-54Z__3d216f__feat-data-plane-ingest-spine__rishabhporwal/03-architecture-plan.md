# Architecture Plan — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 2 — architecture (binding plan) |
| **Decision** | ADVANCE |
| **Architect** | architect (subagent) |
| **Authored** | 2026-06-16 |
| **Base branch** | `master` (HEAD `8f7e613`, has all M1 control-plane + sprint-0 scaffolds) |
| **Feature branch** | `feat/data-plane-ingest-spine` |
| **Cost paradigm** | **Deterministic logic only** — no model/ML/statistical call anywhere on this path. HTTP edge + append-only spool + KafkaJS produce/consume + Zod validation + Redis SETNX dedup + SQL INSERT. Zero token spend. (cheapest-sufficient-effort gate: PASS — a model call here would be an anti-pattern.) |

---

## 0. Cost & footprint

- **Tokens/day:** 0. **Spend/mo (LLM):** $0. This is pure data-plane plumbing.
- **Infra footprint (dev/CI):** existing `core` + `ingest` docker profiles only. No new container, no new DB, no new package, no new stack layer (D-9).
- **Net-new persisted objects:** 2 Postgres tables via additive migrations (`collector_spool`, `bronze_events`) + 1 Redis key namespace (`dedup:*`). Both tables drop cleanly on `migrate:down` (zero data impact — neither is an immutable Bronze/ledger/audit table yet; see §6 ADR note).

---

## 1. D-4 RESOLUTION (the only novel risk) — decided FIRST

### Decision: **Postgres `bronze_events` staging-table fallback for M1.** Iceberg registration deferred to Phase 3.

### Why (spike outcome, decisive)

The CTO review's "CONFIRMED Iceberg via Nessie" line (02 §40) is **infra-present but not write-reachable from TypeScript**. Ground truth:

1. **There is no production-grade TypeScript Iceberg writer.** Grep of the entire repo (`package.json`, all `apps/*` + `packages/*`) returns **zero** Iceberg/Parquet/PyIceberg/Arrow deps. Writing an Iceberg row from TS requires three things none of which a TS library does end-to-end: (a) encode rows → Parquet data files, (b) construct Iceberg manifest + manifest-list metadata, (c) commit a snapshot to the catalog. **Nessie REST is a *catalog-metadata* service** (`/api/v2/config`, table-pointer/snapshot tracking) — it does **not** accept row writes; it only records where committed data files live.
2. **The mature Iceberg writers are JVM (Spark/Flink) and Python (PyIceberg)** — both **explicitly Phase-3-deferred** per `STACK.md:46` (Phase 3 adds Spark) and locked-choice #7 (`STACK.md:60`, "TypeScript everywhere… Python ML service is Phase 3"). Pulling PyIceberg or Spark into M1 = **a new stack layer + a fresh ADR + Stakeholder sign-off** — outside Architect authority and against the requirement's hard rule "no new pattern/deployable" (01 §45).
3. The D-4 binding itself names this exact fallback: *"If the Iceberg REST write path is not functional in TypeScript within that spike, the fallback binding is a Postgres `bronze_events` staging table for M1 only"* (02 §119). The spike outcome is **not-functional-in-TS**, so the named fallback fires.

**This keeps the slice unblocked, stays inside TypeScript-everywhere, and adds NO new stack layer** (Postgres is already PersistenceAdapter, ADR-001). It is the smallest, safest, most reversible path to M1's exit criterion (a row flows collector→Redpanda→stream-worker→Bronze behind isolation).

### What this changes (builders MUST internalise)

| Aspect | Iceberg path (deferred) | **Bound M1 path** |
|---|---|---|
| Bronze sink | Iceberg table `brain_bronze.collector_events` via Nessie | **Postgres table `bronze_events`** in the `brain` DB |
| Tenant isolation | partition `bucket(16, brand_id)` + S3 prefix predicate (D-8) | **Postgres RLS** — two-arg `current_setting('app.current_brand_id', TRUE)::uuid`, `FORCE ROW LEVEL SECURITY`, verified under `SET ROLE brain_app` (D-8 *re-bound to RLS for M1* — see §4) |
| Write mechanism | Parquet→MinIO + Nessie commit | `INSERT INTO bronze_events (...)` under `brain_app` |
| `bronze_events` columns | — | mirror `bronze_spec.json` field-for-field (event_id, brand_id, occurred_at, ingested_at, schema_name, schema_version, event_type, correlation_id, partition_key, payload, processing_flags, collector_version) so the Phase-3 Iceberg migration is a mechanical column-map, not a redesign |

### Forward path (documented, not built now)

`bronze_events` is the **dev/M1 staging mirror**. The Phase-3 Iceberg-SoR flip (`STACK.md:46`) registers the same rows into `brain_bronze.collector_events` via a Spark/PyIceberg nightly job reading `bronze_events`. Column shape is identical by design. **The `db/iceberg/bronze_table.sql` + `bronze_spec.json` artifacts stay as-is** — they are the Phase-3 target spec, not an M1 dependency. No edit to those files in this run.

### ADR flag

This is an **amendment note on ADR-003/ADR-002**, NOT a new ADR: the *target* (Bronze = Iceberg) is unchanged; M1 uses the **explicitly-pre-sanctioned D-4 fallback** as a dev/staging shim. Builders write `bronze_events` as a clearly-marked `-- DEV/M1 STAGING MIRROR; Phase-3 → Iceberg (STACK.md:46)` header. **Stakeholder is informed via this plan; no gate waiver required** (the fallback was pre-authorised in 02 §119). If a future run wants `bronze_events` to become a *permanent* SoR, that is a fresh ADR — out of scope here.

---

## 2. End-to-end flow (binds D-1, D-2, D-7, D-10)

```
┌─────────────────────── COLLECTOR (@backend-developer) ───────────────────────┐
│ POST /collect                                                                  │
│   1. read raw body (no validation)                                             │
│   2. stamp received_at = now()                                                 │
│   3. INSERT INTO collector_spool (raw_body, received_at, status='pending')     │  D-1/D-2
│      └─ this INSERT (durable commit) IS the ACK boundary                        │
│   4. return HTTP 200 { accepted: true }   ◄── BEFORE any validate/produce       │
│                                                                                 │
│ DRAINER  (separate async loop — NOT in the request handler)                     │  D-1
│   poll: SELECT ... WHERE status='pending' ORDER BY id LIMIT batch               │
│   for each: KafkaJS produce → dev.collector.event.v1 (key = brand_id:event_id)  │
│   on produce-confirmed: UPDATE status='drained', drained_at=now()               │
│   on Redpanda-down: leave status='pending' (back-pressure; NO drop, NO error    │  F-3
│                     to the already-200'd caller); retry next tick               │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │ Redpanda  dev.collector.event.v1
                                   ▼
┌──────────────────── STREAM-WORKER (@data-engineer) ──────────────────────────┐
│ consume(message)                                                               │
│   1. decode → validate against CollectorEventV1 (Zod parse for M1 — see §3)     │  F-1/F-6
│   2. dedup: Redis SET dedup:{brand_id}:{event_id} NX EX 604800  (7d TTL)        │  D-3
│        ├─ key already existed (NX fails) → DUPLICATE → commit offset, skip write│
│        └─ key set (first sight) → proceed                                       │
│   3. write Bronze: INSERT INTO bronze_events (...) under brain_app + GUC set    │  D-4/D-8
│   4. ONLY AFTER write confirmed → commit Kafka offset                           │  D-7
│   on write failure: do NOT commit offset → retried next poll                    │  D-7/F-3
│   after MAX_RETRY=5 failures for the same offset → produce to                   │  D-7
│        dev.collector.event.v1.dlq, THEN commit offset                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Ordering invariants (non-negotiable, block at review):**
- The `collector_spool` INSERT commits **before** HTTP 200. No validate, no Apicurio call, no Kafka produce in the request path (D-1, I-ST02).
- Kafka offset commit happens **strictly after** a confirmed Bronze write or a confirmed dedup-hit or a confirmed DLQ produce (D-7). Commit-before-write = silent data loss = block at review.

---

## 3. Contract fixes (binds D-5, D-6, F-1, F-6) — Slice 1, BEFORE any consumer or Apicurio registration

Contract-first (I-E01): codegen output committed **before** consumers consume. Three layers must agree on field name + type. Current state has two real mismatches:

| Fix | File:line | Change |
|---|---|---|
| **F-6 / D-5** `ingest_at` → `ingested_at` | `packages/contracts/src/events/sample.collector.event.v1.ts:61` | rename Zod field `ingest_at` → `ingested_at` (still `.optional()`). Safe — never registered to Apicurio yet, so no FULL_TRANSITIVE break. |
| **F-1 / D-6** envelope `occurred_at`/`ingested_at` type | `packages/events/src/index.ts:26-27` | change `occurred_at: number` → `occurred_at: string` and `ingested_at: number` → `ingested_at: string` (ISO-8601). Drop "millis since epoch" comments. No millis-as-number anywhere in the envelope. |
| **F-1** stale comment | `packages/contracts/src/events/sample.collector.event.v1.ts:11` | the comment "stream-worker converts to epoch-ms for Bronze partition" is now false — replace with "stream-worker writes `occurred_at` as `timestamptz` at the Bronze boundary; no epoch-ms representation." |
| **codegen** Avro regen | run `pnpm --filter @brain/contracts run gen:contracts` | regenerates `generated/avro/brain.collector.event.v1.avsc` (renames `ingest_at`→`ingested_at` field). **Commit the regenerated `.avsc` in the SAME commit as the Zod change** (I-E01). |

**`occurred_at` type boundary (D-6):** contract + Avro wire = ISO-8601 string. Bronze `occurred_at` column = `timestamptz`. The stream-worker converts at the write boundary: `new Date(event.occurred_at)` → pg `timestamptz` (pg driver accepts a JS Date or ISO string directly). No numeric representation.

**M1 validation simplification (sanctioned, 02 §133):** for the stream-worker validate step, use a **local Zod `CollectorEventV1Schema.parse()`** — NOT the full Apicurio fetch-and-validate. Apicurio registration still happens at collector startup (D-10) so the schema is registered, but the consumer's per-message validate is Zod-local for M1. This cuts the stream-worker's hot-path dependency on Apicurio being up. Full registry-validate on consume is an M2 item — leave a `// M2: replace with Apicurio validateSchemaCompatibility` marker.

---

## 4. Tenant isolation (binds D-8 — RE-BOUND to RLS for the Postgres M1 sink)

Because the M1 sink is Postgres (§1), data-plane isolation is enforced by **Postgres RLS**, exactly mirroring the control-plane pattern in `0001_init.sql:169-177` — NOT by Iceberg partition predicate (that returns in Phase 3). This is the correct, already-proven mechanism for a Postgres table; it is *stronger* than the M1 Iceberg predicate would have been (DB-enforced vs query-discipline).

`bronze_events` RLS (in the migration, §5):
```
ALTER TABLE bronze_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bronze_events FORCE ROW LEVEL SECURITY;   -- forces even table owner
CREATE POLICY tenant_isolation ON bronze_events
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);   -- NN-1 two-arg
REVOKE ALL ON bronze_events FROM brain_app;
GRANT SELECT, INSERT ON bronze_events TO brain_app;   -- append-only at GRANT level (no UPDATE/DELETE)
```
- **Two-arg form is mandatory** (NN-1): missing GUC → NULL → `brand_id = NULL` → FALSE → 0 rows (fail-closed). The migration's `0001` NN-1 assertion (`0001_init.sql:182-199`) will re-scan and FAIL the migration if a one-arg form sneaks in — builders inherit that guard automatically.
- **Append-only by GRANT** (I-E02): `bronze_events` gets `INSERT, SELECT` only — no `UPDATE/DELETE` for `brain_app`. Bronze is immutable.
- The stream-worker sets the GUC per write: `SET LOCAL app.current_brand_id = $brand_id` inside the same transaction as the INSERT (so the row it writes is visible to itself and RLS-scoped). Use the existing connection pattern; **the stream-worker connects as `brain_app`, NOT `brain`** (see test note below).

**`collector_spool` is NOT brand-scoped** (D-2): spool sits *before* brand validation; events are enqueued raw. No RLS on `collector_spool`. `brain_app` gets `SELECT, INSERT, UPDATE` (drainer flips `status`). Documented in the migration header.

**Isolation test under `SET ROLE brain_app`** (F-4, MEMORY: dev superuser `brain` masks RLS): every isolation assertion MUST run on a connection that has executed `SET ROLE brain_app` (or connects as a login role granted `brain_app`) AND sets `app.current_brand_id`. A test running as superuser `brain` is a **false pass** — it bypasses RLS and sees all rows. This is the #1 test-correctness trap; called out in every isolation test below.

---

## 5. Migrations (additive, node-pg-migrate raw-SQL, binds D-2 + D-4-fallback + D-9)

Style note: this repo's migrations are **raw `.sql` files** under `db/migrations/` (NOT JS pgm modules) — match `0014_member_lifecycle.sql`. Each has a clear header + the implicit down = `DROP TABLE IF EXISTS` (reversible, zero data impact; neither table is yet an immutable SoR).

**`db/migrations/0015_collector_spool.sql`** (D-2):
```
collector_spool (
  id           BIGSERIAL    PRIMARY KEY,
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  raw_body     JSONB        NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'pending',   -- pending | drained
  drained_at   TIMESTAMPTZ
)
-- index for the drainer poll: WHERE status='pending' ORDER BY id
CREATE INDEX idx_collector_spool_pending ON collector_spool (id) WHERE status = 'pending';
-- NO RLS (pre-brand-validation). GRANT SELECT, INSERT, UPDATE ON collector_spool TO brain_app;
```

**`db/migrations/0016_bronze_events.sql`** (D-4 fallback) — columns mirror `bronze_spec.json` exactly:
```
bronze_events (
  event_id          UUID         NOT NULL,
  brand_id          UUID         NOT NULL,        -- tenant key / RLS anchor
  occurred_at       TIMESTAMPTZ  NOT NULL,
  ingested_at       TIMESTAMPTZ  NOT NULL,
  schema_name       TEXT         NOT NULL,
  schema_version    INT          NOT NULL,
  event_type        TEXT         NOT NULL,
  correlation_id    TEXT         NOT NULL,
  partition_key     TEXT         NOT NULL,
  payload           JSONB        NOT NULL,         -- no raw PII (I-S02)
  processing_flags  JSONB,                          -- nullable (evolution-safe)
  collector_version TEXT,                           -- nullable
  PRIMARY KEY (brand_id, event_id)                  -- tenant-first PK; also the idempotency key (I-ST04)
)
+ RLS block from §4 (FORCE, two-arg policy, brain_app INSERT+SELECT only)
+ header: '-- DEV/M1 STAGING MIRROR of brain_bronze.collector_events. Phase-3 → Iceberg (STACK.md:46).'
```
The `(brand_id, event_id)` PK gives a **DB-level idempotency backstop** even if Redis dedup misses (a duplicate INSERT raises a unique violation the worker treats as a dedup-hit → commit offset). Redis (D-3) is the fast first-line dedup; the PK is the durable second line.

Both migrations: additive only, no `DROP`/`ALTER…DROP` on any existing table (I-E02). `migrate:down` for each = `DROP TABLE` (clean — these are new tables, not yet SoR).

---

## 6. Slices (smallest-first) + acceptance contracts

> **COMMIT PER SLICE.** Prior runs (feat-members-team-management) lost ~61 min of work to infra socket timeouts — only committed-per-slice work survived. Each slice below ends with a commit on `feat/data-plane-ingest-spine`. Do not batch.

### Slice 1 — D-4 spike confirmation + contract fixes + migrations  *(shared; lands FIRST; both tracks gated on it)*
**Owner: @backend-developer drives, @data-engineer reviews the bronze_events shape.**

Acceptance contract (ALL required, pass-1):
- [ ] §1 D-4 fallback confirmed: a throwaway 15-min check that a TS KafkaJS consumer can `INSERT INTO bronze_events` under `brain_app` succeeds, and that no TS Iceberg writer exists (grep clean). Record the one-line outcome in the slice commit message. *(Decision is already bound to Postgres; this is the confirm-and-move step, not a re-litigation.)*
- [ ] §3 contract fixes applied: `ingest_at`→`ingested_at` (Zod), `occurred_at`/`ingested_at` → `string` (envelope), stale comments fixed.
- [ ] `pnpm --filter @brain/contracts run gen:contracts` run; regenerated `.avsc` shows `ingested_at` (not `ingest_at`); **committed in the same commit** (I-E01).
- [ ] `0015_collector_spool.sql` + `0016_bronze_events.sql` written per §5; `pnpm migrate:up` succeeds against the `core` profile Postgres; NN-1 assertion passes; `migrate:down` of both is clean.
- [ ] `pnpm --filter @brain/contracts test` green (the existing `sample.collector.event.v1.test.ts` still passes against the renamed field — update the test if it asserts `ingest_at`).
- [ ] **Commit:** `feat(data-plane): contract field canonicalization + spool/bronze migrations [slice 1]`.

### Slice 2 — Collector accept-before-validate edge  *(@backend-developer)*
DDD: `apps/collector/src/` organized by bounded context — `domain/ingest/` (envelope value-object, spool entry entity), `application/` (accept use-case, drain use-case), `infrastructure/` (pg spool repo, kafka producer), `interfaces/rest/` (POST /collect), `interfaces/jobs/` (drainer loop), `observability/health`. NO controllers/services/models tree.

Acceptance contract:
- [ ] Fastify server; `POST /collect` reads body → stamps `received_at` → `INSERT INTO collector_spool (status='pending')` → returns HTTP 200. **No validation/produce in the handler** (D-1). `file:` new under `apps/collector/src/interfaces/rest/collect.route.ts` + `application/accept-event.usecase.ts`.
- [ ] Drainer is a **separate async loop** (`interfaces/jobs/drainer.ts`), not inline: polls `pending`, KafkaJS-produces to `dev.collector.event.v1` with key `brand_id:event_id` (use `buildPartitionKey` from `@brain/events:140`), then `UPDATE status='drained'`. On produce error: leave `pending`, log, retry next tick (F-3 back-pressure). MAX spool batch + poll interval are config (`@brain/config`).
- [ ] Apicurio registration on startup with exponential backoff (max 30s) before opening the HTTP listener (D-10) using `registerSchema` (`@brain/events:61`); collector serves only after Apicurio healthy OR backoff exhausted-then-log-and-degrade (do NOT crash-loop — degrade to spool-only; the spool still ACKs, which is the whole point of accept-before-validate).
- [ ] Connects to Postgres as `brain_app` (or a login role granted it), not `brain`.
- [ ] Health endpoint `/healthz` (liveness) + `/readyz` (spool DB reachable).
- [ ] Collector connects as `brain_app`; spool INSERT works (no RLS on spool, §4).
- [ ] **Commit:** `feat(collector): accept-before-validate edge + spool + drainer [slice 2]`.

### Slice 3 — Stream-worker pipeline + Bronze sink + Redis dedup  *(@data-engineer)*
DDD: `apps/stream-worker/src/` — `domain/bronze/` (BronzeRow value-object, dedup policy), `application/` (process-event use-case), `infrastructure/` (kafka consumer, pg bronze repo, redis dedup adapter), `interfaces/consumers/`.

Acceptance contract:
- [ ] KafkaJS consumer (live group) on `dev.collector.event.v1`; for each message: Zod `CollectorEventV1Schema.parse()` (M1-local validate, §3) → Redis `SET dedup:{brand_id}:{event_id} NX EX 604800` (D-3) → on first-sight `INSERT INTO bronze_events` under `brain_app` with `SET LOCAL app.current_brand_id` in the same txn (§4) → **commit offset only after write confirmed** (D-7).
- [ ] Dedup-hit (NX fails) → commit offset, skip write. Unique-violation on INSERT (PK backstop, §5) → treat as dedup-hit → commit offset.
- [ ] Failure → do NOT commit; retry. After `MAX_RETRY=5` for the same offset → produce to `dev.collector.event.v1.dlq` → then commit (D-7). Retry count tracked per (partition, offset) in memory.
- [ ] `schema_name='brain.collector.event.v1'`, `schema_version` populated (M1: literal `1` from the Zod `schema_version` field — F-10; the Apicurio-resolved version is an M2 refinement, leave a marker).
- [ ] `occurred_at` written as `timestamptz` via `new Date(occurred_at)` (D-6); `ingested_at` from envelope; `partition_key` = `buildPartitionKey`.
- [ ] Connects as `brain_app`, not `brain`.
- [ ] **Commit:** `feat(stream-worker): consume→dedup→bronze sink + DLQ [slice 3]`.

### Slice 4 — E2E + durability + dedup + isolation tests  *(both tracks; @data-engineer owns the harness, @backend-developer the durability case)*
Test harness under `tests/` (cross-service), spins `core` + `ingest` docker profiles (or testcontainers).

Acceptance contract (the 4 named tests — ALL required, this is M1's exit gate, doc 05 §14):
- [ ] **E2E happy path:** synthetic event POST → collector → spool → drainer → Redpanda → stream-worker → assert a `bronze_events` row exists for `(brand_id, event_id)`, read **under `SET ROLE brain_app` + GUC = brand_A** (F-4).
- [ ] **Durability (I-ST02):** POST an event while Redpanda is **stopped** → assert HTTP 200 still returned AND row sits in `collector_spool` with `status='pending'` → start Redpanda → assert drainer drains it → row appears in Bronze. (ACK survives downstream-down.)
- [ ] **Dedup / replay (I-ST04):** deliver the same event twice (re-produce to Kafka or replay the spool) → assert exactly **one** `bronze_events` row.
- [ ] **Isolation negative control (I-S01, D-8-as-RLS):** write brand_A's event; under `SET ROLE brain_app` + GUC = brand_B, `SELECT * FROM bronze_events` → **0 rows** (brand_A's event_id NOT visible). Then flip GUC = brand_A → 1 row. **Must run as `brain_app`** — a `brain`-superuser run is a false pass (assert the test connection is non-superuser; fail the test if `current_user='brain'`).
- [ ] **Commit:** `test(data-plane): e2e + durability + dedup + isolation [slice 4]`.

### Slice 5 — Deploy track (REQUIRED — no service change ships without its pipeline)  *(@backend-developer + @data-engineer for their respective services)*
Both `collector` and `stream-worker` are existing deployables (D-9) — wire their **affected-only** build + deploy, never deploy-all.

Acceptance contract:
- [ ] Per-service Dockerfile present/updated for `apps/collector` + `apps/stream-worker` (image build builds only the affected app + its workspace deps — turbo-pruned).
- [ ] CI: affected-detection so only changed services build/deploy (match the existing GitHub Actions→ECR→Helm→ArgoCD pattern, `STACK.md:42` DeployAdapter).
- [ ] Each service: health probe (`/healthz`,`/readyz` for collector; consumer-lag/liveness for stream-worker), graceful drain (drainer finishes in-flight spool batch; consumer commits offset on SIGTERM), canary + ArgoCD auto-rollback alarm (consumer error-rate / DLQ-rate threshold).
- [ ] No new GitOps app (existing deployables); overlays updated for the 2 services only.
- [ ] **Commit:** `chore(deploy): collector + stream-worker pipelines + probes [slice 5]`.

---

## 7. Test strategy (real-network smoke, no mocked infra at the seams)

- Infra: real Redpanda + real Postgres (+ Redis) via `docker compose --profile core --profile ingest up` or testcontainers — **no mocked Kafka, no mocked DB** at the integration seam (real-network smoke).
- Every isolation/Bronze-read assertion runs **as `brain_app`** with an explicit `current_user != 'brain'` guard (false-pass prevention, F-4).
- Durability test must actually **stop Redpanda** (not mock a produce error) so the spool-hold path is exercised end-to-end.
- Dedup test exercises **both** Redis NX and the PK unique backstop.

---

## 8. Single-Primitive sweep — CLEAN

- **Spool** = ONE (`collector_spool`), not per-connector. The `/webhook/{connector}` route is out of M1 scope (synthetic `/collect` only, 01 §54) — when added later it drains into the SAME spool + SAME topic. No per-channel fork.
- **Dedup** = ONE mechanism (Redis `dedup:{brand_id}:{event_id}` + PK backstop) consumed by the one stream-worker. Not a per-event-type dedup.
- **Bronze sink** = ONE table (`bronze_events`) for all event types; `event_type` is a column, not a table-per-type fork.
- **Tenant key** = `brand_id` at every layer (spool drains it, Kafka partition key, Bronze RLS, Redis dedup key prefix) — I-S01 enforced independently at each layer.
- Extends existing primitives (`@brain/events` partition-key + Apicurio helpers, `@brain/tenant-context`, the `0001` RLS pattern) — nothing net-new invented.

## 9. Alternatives considered + rejected

1. **TS Iceberg-REST write in M1 (D-4 option a).** REJECTED: no production TS Iceberg writer exists; Nessie is catalog-only; would require hand-rolling Parquet+manifest+snapshot commit — high-risk, blocks the whole slice, and is exactly the "spike can't prove it" branch the CTO pre-authorised falling back from (02 §119).
2. **PyIceberg / Spark micro-job in M1 (D-4 option b/c).** REJECTED: new stack layer + new language + new ADR + Stakeholder sign-off — violates "no new pattern/deployable" (01 §45) and locked-choice #7 (Python/Spark = Phase 3, `STACK.md:46/60`). Outside Architect authority.
3. **Filesystem fsync spool (F-9).** REJECTED for dev/CI: needs a persistent volume; risky on tmpfs in CI. Postgres append spool (D-2) fits the existing PersistenceAdapter and is volume-free.
4. **Synchronous produce-then-ACK.** REJECTED: violates D-1/I-ST02 (the 99.95% durability invariant) — a downstream outage at ACK drops the event.
5. **Commit Kafka offset before Bronze write.** REJECTED: silent loss on Bronze-down (D-7/F-3).

## 10. Over-engineering self-check — PASS

Scope is already thin (one synthetic event, no identity graph/ledger/metric engine — 01 §53). The spool→drain split is the *minimum* correct complexity for accept-before-validate (not removable). The only simplification applied is the sanctioned M1 Zod-local validate instead of full Apicurio consume-validate (02 §133). Plan length matches a high-stakes data-plane critical-path band: 5 slices, each 2–5 min tasks with file paths.

---

## 11. Builder must-not-miss (folded from F-1…F-10, all in acceptance contracts above)

- F-1/F-6/D-5/D-6 → Slice 1 (contract canonicalization, codegen committed first).
- F-2/D-1 → Slice 2 (ACK before validate; drainer separate loop).
- F-3/D-7 → Slices 2+3 (spool back-pressure; offset commit AFTER Bronze write; DLQ after 5).
- F-4/D-8 → Slice 4 (ALL isolation tests under `SET ROLE brain_app`; superuser = false pass).
- F-5/D-3 → Slice 3 (Redis dedup + PK backstop).
- F-7/D-4 → Slice 1 (Postgres `bronze_events` fallback — bound, not re-litigated).
- F-8/D-10 → Slice 2 (Apicurio backoff; degrade-don't-crash).
- F-9/D-2 → Slice 1+2 (Postgres spool, no FS volume).
- F-10 → Slice 3 (`schema_name`/`schema_version` populated; literal v1 for M1).
- **COMMIT PER SLICE** (infra-timeout survival).
- Connect as `brain_app`, never `brain` (RLS only enforces under `brain_app`; dev superuser masks it).
