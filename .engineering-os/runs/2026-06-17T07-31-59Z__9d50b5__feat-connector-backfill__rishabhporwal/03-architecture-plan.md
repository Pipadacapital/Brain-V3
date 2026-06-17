# 03 — Architecture Plan: feat-connector-backfill

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 2 — Architecture (BINDING) |
| **Lane** | high_stakes |
| **Paradigm** | **Tier-0 deterministic** throughout. Zero model calls, $0/mo model spend. Backfill is a data-pipeline job: HTTP (Shopify REST) → cursor upsert → Kafka produce → existing Bronze writer. The only cost lever is the Shopify rate-limit (external constraint, not a model call). Justification: deterministic logic fully solves paging, mapping, idempotency, progress — no statistical/ML/model tier is warranted. |
| **Tracks** | A @data-engineer (lead) ∥ B @backend-developer ∥ C @frontend-web-developer |
| **Decision** | **GO for builders** |

---

## 0. The one structural insight (read first)

The live Bronze pipeline does **not** parse the rich `m1.events.v1` envelopes. The stream-worker's `ProcessEventUseCase` (apps/stream-worker/src/application/ProcessEventUseCase.ts:66) parses **`CollectorEventV1Schema`** (packages/contracts/src/events/sample.collector.event.v1.ts) — a flat envelope: `{schema_version, event_id(uuid), brand_id(uuid), correlation_id, event_name, occurred_at, ingested_at?, hashed_user_id?, hashed_session_id?, properties{}}`. The identity bridge (`ResolveIdentityUseCase.ts:73-82`) reads identifiers out of `payload.properties` (`email`/`phone`/`customer_id`).

**Therefore the backfill order event is a `CollectorEventV1` envelope with `event_name='order.backfill.v1'` and all order fields inside `properties`.** This is what makes "same code path, different lane" literally true: the existing `ProcessEventUseCase` writes it to Bronze unchanged, and the existing `IdentityBridgeConsumer` resolves identity unchanged. We add exactly ONE new consumer (Bronze-order → ledger projection) that was scaffolded but never wired (§ seam G).

Two real conflicts surfaced against the intake and are resolved below as ADRs: **event_id must be a UUID** (D-5 says sha256 → ADR-BF-2: UUIDv5 derivation), and **identity needs raw identifiers but D-10 says hash-only** (ADR-BF-5: hash-at-worker + carry the salted hashes as the identity keys, identity bridge consumes the hashes directly — no raw PII anywhere).

---

## 1. Bound seams — one-line ADRs

- **ADR-BF-1 (backfill_job model, D-12):** New additive migration `0022_backfill_job.sql` — table per D-12 DDL (§2). FORCE RLS, two-arg fail-closed on `brand_id`; `brain_app` GRANT SELECT/INSERT/UPDATE, **no DELETE**. `0006` untouched. Rollback = `DROP TABLE` (rebuildable; no source-of-truth data).
- **ADR-BF-2 (event_id derivation, D-5 + bronze UUID column):** `bronze_events.event_id` is **UUID** (0016:24) and `CollectorEventV1Schema.event_id` is `.uuid()`. D-5's `sha256(brand_id:shopify_order_id:order.backfill.v1)` is formatted into an **RFC-4122 UUIDv5-shaped value**: `uuidV5FromSha256(brand_id, shopify_order_id)` = take the sha256 hex, set version nibble to `5` and variant bits, hyphenate. Deterministic, stable across re-runs, valid UUID, per-brand scoped. Lives in the worker (`apps/stream-worker/src/jobs/shopify-backfill/`), documented as the dedup key. NOT `randomUUID()`.
- **ADR-BF-3 (trigger, D-2/D-7/D-9/D-15):** Realize the 501 at `apps/core/src/main.ts:716` → `POST /api/v1/connectors/:id/backfill` (brand_admin+, hook already at main.ts:714). Order: load connector_instance under brand GUC → `getSecret(secret_ref)` null → **409 RECONNECT_REQUIRED** (D-7) → overlap-lock `SELECT ... FOR UPDATE SKIP LOCKED` on `backfill_job` where status IN (queued,running) → row found → **409 BACKFILL_ALREADY_RUNNING** (D-9) → INSERT `backfill_job` status=queued → audit append → **202 {job_id}**. `{request_id, data}` envelope.
- **ADR-BF-4 (progress API):** `GET /api/v1/connectors/:id/jobs` (brand_admin+) → latest job(s): `{status, records_processed, estimated_total|null, percent|null, cursor_date|null, achieved_depth_label|null, failure_reason|null, started_at, completed_at}`. Percent = `null` when estimated_total null (D-8 honesty). `{request_id, data}` envelope.
- **ADR-BF-5 (PII strip at worker boundary, D-10):** Worker reads `customer.email`/`customer.phone` from the Shopify order, computes the per-brand salted hashes **inside the worker** using the SAME `@brain/identity-core` `normalize+hashIdentifier` the identity bridge uses, and emits ONLY `hashed_customer_email`/`hashed_customer_phone` into `properties`. Raw email/phone/name/address are dropped at the mapping layer — never in the event, the Bronze `payload`, or any log. The identity bridge is adjusted to read pre-hashed identifiers when present (§ seam G / Track A detail). New schema passes `no-pii-schema-lint`.
- **ADR-BF-6 (worker placement, D-1/D-4):** `apps/stream-worker/src/jobs/shopify-backfill/` (job entrypoint `run.ts`, invoked `node dist/jobs/shopify-backfill/run.js` — mirrors `revenue-finalization.ts`). No new deployable. Emits **directly to Redpanda** via a worker-owned KafkaJS producer (mirrors `apps/collector/src/infrastructure/kafka-producer.ts`), NOT the collector HTTP edge.
- **ADR-BF-7 (lane, D-3):** Backfill topic **`{env}.collector.order.backfill.v1`** (single partition = natural throughput cap), consumer group **`stream-worker-backfill`**. This is a NEW dedicated topic, distinct from the pre-existing generic `{env}.collector.event.v1.backfill` replay lane in `infra/redpanda/topics.yml` (which is a Bronze-replay lane, different purpose — left untouched). Declared in `infra/redpanda/topics.yml`. The live group `stream-worker-live` (main.ts:36) is provably unaffected because it subscribes to a different topic.
- **ADR-BF-8 (Bronze landing):** The new backfill consumer (`BackfillOrderConsumer`) reuses the **existing** `ProcessEventUseCase` + `BronzeRepository` unchanged → idempotent on `(brand_id, event_id)` via Redis NX + PG PK (ProcessEventUseCase.ts:78,109). Same Bronze row shape as live. Re-run produces zero new rows.
- **ADR-BF-9 (ledger feed — the missing wire):** `OrderEventConsumer` (apps/core/src/modules/measurement/.../OrderEventConsumer.ts) exists but is **wired to nothing** (index.ts:20 says "used by stream-worker job" — that job was never built). The backfill slice wires it: a new stream-worker consumer on the backfill topic (or a Bronze-tailing consumer) maps `order.backfill.v1` → `RawOrderEvent` → `OrderEventConsumer.handle()` → `provisional_recognition`. `occurred_at = processed_at` flows straight through to the ledger row (RecognizeOrder.ts → economic_effective_at = occurred_at).
- **ADR-BF-10 (finalization — no new code, D-6):** Backfilled provisionals have `occurred_at = processed_at` (in the past). The EXISTING `revenue-finalization.ts:132` query `occurred_at + horizon_days < NOW()` fires on its next run → past-horizon → finalization (realized); in-horizon → stays provisional. **No new recognition/finalization code.** Verified: revenue-finalization enumerates brands via `list_active_brand_ids()` (0019 SECURITY DEFINER), so it sees the brand even under brain_app + GUC.
- **ADR-BF-11 (worker token access — cross-process, resolves the dev-secret trap):** The worker runs in **stream-worker**, a different process from **core**; core's `LocalSecretsManager` is an in-memory Map (LocalSecretsManager.ts:38) invisible across processes. The trigger's D-7 reconnect check runs in core (token present there). The **worker** instantiates its own `ISecretsManager` from the same env seam: in **prod** `AwsSecretsManager` (durable, shared) reads `secret_ref` directly — no problem. In **dev**, the worker reads the token from the same env-backed path the dev sync route uses (`getShopifyToken(secret_ref)` resolves the `SHOPIFY_*` env / dev convention). The job persists `failure_reason='RECONNECT_REQUIRED'` + checkpoint cursor if the worker's `getSecret` returns null (SP-3). This keeps the no-new-table cut (option a) while making the worker actually able to authenticate.
- **ADR-BF-12 (dashboard label, D-11):** Realized-revenue card label → **"Gross Revenue (ex-fees)"** + tooltip "Settlement fees not yet applied." No new metric — reuse the existing engine number (`realized_gmv_as_of`). Provisional shown separately, never summed with realized.
- **ADR-BF-13 (brand_id source, MT-1):** `brand_id` is taken from `connector_instance.brand_id` at job start (under brain_app + GUC), asserted on every emitted event. Never from the Shopify response, never from an env var.
- **ADR-BF-14 (amount_minor, D-13):** `decimalStringToMinor(str)` — split on `.`, assert ≤2 decimals, `BigInt(whole)*100n + BigInt(frac.padEnd(2,'0'))`. Never `parseFloat`. Emitted as a string in `properties.amount_minor` (BigInt → string for JSON); `OrderEventConsumer.toBigInt` (line 35) re-parses it. I-S07.
- **ADR-BF-15 (payment_method):** Map Shopify `gateway`/`payment_gateway_names`/`financial_status` → `'cod' | 'prepaid'` for the horizon split (COD gateways/`pending`+`Cash on Delivery` → cod, else prepaid). Carried in `properties.payment_method`; `OrderEventConsumer.toPaymentMethod` (line 30) consumes it.

**No new ADR beyond these** — all within I-S01 (RLS), I-S02 (no raw PII), I-S07 (minor units), I-S09 (secret-ref), I-E02 (additive), I-E05 (no new deployable). No new tech-stack layer, no breaking public-surface change.

---

## 2. Migration 0022 — DDL sketch (Track A, Slice A1)

```sql
-- 0022_backfill_job.sql — additive only (I-E02). 0006 untouched.
-- Rollback: DROP TABLE IF EXISTS backfill_job;  (rebuildable; no SoR data)
CREATE TABLE IF NOT EXISTS backfill_job (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id               UUID        NOT NULL REFERENCES brand(id),                    -- tenant key / RLS anchor (I-S01)
  connector_instance_id  UUID        NOT NULL REFERENCES connector_instance(id),
  status                 TEXT        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','completed','partial','failed')),
  records_processed      BIGINT      NOT NULL DEFAULT 0,
  estimated_total        BIGINT      NULL,                                             -- NULL = count failed (D-8 honesty)
  cursor_value           TEXT        NULL,                                             -- last since_id checkpoint
  cursor_date            TIMESTAMPTZ NULL,                                             -- oldest processed_at seen (progress display)
  achieved_depth_label   TEXT        NULL,                                             -- written at completion (HP-3)
  failure_reason         TEXT        NULL,
  started_at             TIMESTAMPTZ NULL,
  completed_at           TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS backfill_job_brand_connector_idx
  ON backfill_job (brand_id, connector_instance_id);
-- Overlap-lock support index (D-9): partial index on active jobs per connector.
CREATE INDEX IF NOT EXISTS backfill_job_active_idx
  ON backfill_job (connector_instance_id) WHERE status IN ('queued','running');
-- Worker poll index (D-2): pick up queued jobs.
CREATE INDEX IF NOT EXISTS backfill_job_queued_idx
  ON backfill_job (status) WHERE status = 'queued';

ALTER TABLE backfill_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE backfill_job FORCE ROW LEVEL SECURITY;
CREATE POLICY backfill_job_isolation ON backfill_job
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);   -- NN-1 two-arg fail-closed

REVOKE ALL ON backfill_job FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON backfill_job TO brain_app;   -- NO DELETE (D-12)
-- (mirror 0006's NN-1 DO $$ assertion block to fail the migration on any one-arg policy)
```

---

## 3. FROZEN interface contracts (Track A produces FIRST — B and C block on A0)

### 3a. Backfill order event — `order.backfill.v1` (a CollectorEventV1 envelope)

New file `packages/contracts/src/events/order.backfill.v1.ts`. The envelope IS `CollectorEventV1Schema` (so the existing pipeline parses it); this file defines the **`properties` payload contract** + the topic suffix + the event_id derivation note.

```ts
// order.backfill.v1 — properties payload for a backfilled Shopify order.
// Envelope = CollectorEventV1Schema (event_name='order.backfill.v1').
// event_id = uuidV5FromSha256(brand_id, shopify_order_id) — deterministic (ADR-BF-2/D-5).
// occurred_at (envelope) = Shopify processed_at ?? created_at (D-6).
// NO RAW PII (I-S02 / D-10) — schema-lint enforced.
export const OrderBackfillPropertiesSchema = z.object({
  source: z.literal('shopify'),
  shopify_order_id: z.string(),                 // numeric id as string (not PII)
  order_id: z.string(),                         // = shopify_order_id; ledger order_id
  amount_minor: z.string(),                     // BIGINT-as-string, minor units (D-13)
  currency_code: z.string().length(3),
  payment_method: z.enum(['cod','prepaid']),    // for horizon split (ADR-BF-15)
  financial_status: z.string().optional(),
  fulfillment_status: z.string().nullable().optional(),
  cancelled_at: z.string().datetime({offset:false}).nullable().optional(),
  // identity keys — HASHED ONLY (D-10). Consumed by the identity bridge.
  hashed_customer_email: z.string().max(64).optional(),
  hashed_customer_phone: z.string().max(64).optional(),
  storefront_customer_id: z.string().optional(), // numeric Shopify customer id (not PII)
});
export const ORDER_BACKFILL_V1_TOPIC_SUFFIX = 'collector.order.backfill.v1' as const;
```

### 3b. Job / progress envelope (the API contract B serves, C renders)

```ts
// connector.backfill.api.v1 — trigger + progress shapes (frozen by A0).
export interface BackfillTriggerResponse { job_id: string; status: 'queued'; }
export interface BackfillJobProgress {
  job_id: string;
  status: 'queued'|'running'|'completed'|'partial'|'failed';
  records_processed: number;          // BIGINT→number (safe at M1 volumes)
  estimated_total: number | null;     // null = honest "Collecting your data…" (D-8)
  percent: number | null;             // null when estimated_total null
  cursor_date: string | null;         // ISO; oldest processed_at seen
  achieved_depth_label: string | null;
  failure_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
}
// Error codes (409): 'RECONNECT_REQUIRED' (D-7), 'BACKFILL_ALREADY_RUNNING' (D-9).
// All responses: { request_id, data } | { request_id, error:{code,message} }.
```

**A0 = freeze 3a + 3b in `packages/contracts` and commit.** That commit is the green light for B and C to start in parallel.

---

## 4. Lane / topic mechanism (D-3)

- Add to `infra/redpanda/topics.yml`: topic `{env}.collector.order.backfill.v1`, **partitions: 1** (single partition = natural throughput cap, SI-3/D-3), retention 30d, plus consumer group `stream-worker-backfill`. DLQ topic `{env}.collector.order.backfill.v1.dlq` (mirrors existing DLQ pattern).
- Worker producer (ADR-BF-6) sends to this topic; partition key = `brand_id:event_id` via `buildPartitionKey` (reuse `@brain/events`, as collector kafka-producer.ts:77).
- New `BackfillOrderConsumer` (clone of `CollectorEventConsumer` structure: autoCommit=false, offset-after-write, MAX_RETRY=5→DLQ) subscribes to the backfill topic, group `stream-worker-backfill`, reusing `ProcessEventUseCase` (Bronze write) — wired in `apps/stream-worker/src/main.ts` alongside the two existing consumers (no new deployable; SI-1 confirmed).
- **Isolation guarantee:** `stream-worker-live` (main.ts:36, topic `dev.collector.event.v1`) and `stream-worker-backfill` (topic `dev.collector.order.backfill.v1`) are on **different topics** → Redpanda partitioning makes a backfill storm structurally incapable of lagging the live group. Provable by the offset-lag test (Success #13).

---

## 5. Worker state machine (Track A)

```
queued ──worker poll picks up (UPDATE→running, set started_at)──▶ running
running:
  1. load connector_instance (brand GUC) → brand_id, shop_domain, secret_ref, currency
  2. worker getSecret(secret_ref); null → status=failed, failure_reason='RECONNECT_REQUIRED' (ADR-BF-11)
  3. countOrders(status=any, created_at_min=now-24mo) → estimated_total (null on failure, D-8/HP-1)
  4. page loop (since_id + Link, limit=250, created_at_min=now-24mo, D-14):
       per page:
         per order: map→OrderBackfillProperties (ADR-BF-2/5/14/15), produce to backfill topic
         upsert connector_cursor (resource='orders', cursor_value=last since_id) + backfill_job
           (records_processed+=n, cursor_date=min(processed_at), updated_at) — AFTER each page (D-14)
         429 → read Retry-After (int sec) → sleep → retry same page (IR-2/D-14)
         401 → status=failed, failure_reason='SHOPIFY_AUTH_ERROR', keep cursor (SP-3); stop
       Link has no rel=next OR window exhausted → done
  5. compute achieved_depth_label from oldest processed_at vs 24mo target (HP-3):
       oldest ≈ now-24mo  → "24 months"
       store younger      → "since store creation (N months)"
  ──▶ completed (set completed_at, achieved_depth_label)
  any unrecoverable page error after retries ──▶ failed (failure_reason) | partial (cursor saved, recoverable)
```

Resume: a new trigger re-reads `connector_cursor` and continues from `cursor_value` (mid-run crash is recoverable; idempotent Bronze means re-pulled overlap produces zero dups).

---

## 6. Track split + commit-per-slice (COMMIT PER SLICE — non-negotiable; a Stage-8 agent died on the infra socket timeout this run, only committed work survives)

Branch: `feat/connector-backfill` off master HEAD.

### Track A — @data-engineer (LEAD)
- **A0 (FREEZE FIRST):** contracts `order.backfill.v1.ts` (3a) + `connector.backfill.api.v1.ts` (3b) in `packages/contracts`. **Commit.** → green light for B & C.
- **A1:** migration `0022_backfill_job.sql` (§2) + repo (`PgBackfillJobRepository`: insertQueued, claimQueued FOR UPDATE SKIP LOCKED, updateProgress, finalize) + topic decl in `topics.yml`. **Commit.**
- **A2:** worker `apps/stream-worker/src/jobs/shopify-backfill/` — `uuidV5FromSha256`, `decimalStringToMinor`, PII-strip+hash mapper, paging (since_id+Link, 250, 429/Retry-After, 401), countOrders, cursor+progress updates, state machine (§5), worker-side secrets seam (ADR-BF-11). Extend `ShopifyAdminClient`: `getOrders` paging (since_id, limit=250, created_at_min, return Link header) + `countOrders(created_at_min)`. **Commit.**
- **A3:** lane consumer `BackfillOrderConsumer` (Bronze write via existing `ProcessEventUseCase`) + wire in `main.ts`; identity bridge reads pre-hashed identifiers (ADR-BF-5); **wire the ledger feed** (ADR-BF-9: backfill→`OrderEventConsumer.handle`→provisional). **Commit.**
- **A4 (live tests):** fixture orders land on backfill topic NOT live topic; idempotent re-run → 0 new Bronze rows; cursor resume; isolation under **`brain_app`** (BRAIN_APP_DATABASE_URL pool, non-inert count===0); offset-lag isolation (Success #13); past-horizon backfilled order → finalization job → realized (Success #10). **Commit.**

### Track B — @backend-developer (starts post-A0)
- **B1:** realize the 501 (main.ts:716) → trigger: load connector (brand GUC) → getSecret null→409 RECONNECT_REQUIRED → overlap-lock FOR UPDATE SKIP LOCKED →409 BACKFILL_ALREADY_RUNNING → INSERT queued → **audit append** (actor, connector_instance_id, brand_id, Success #14) → 202 {job_id}. `{request_id,data}`. **Commit.**
- **B2:** `GET /connectors/:id/jobs` progress (3b shape; percent null when estimated_total null). **Commit.**
- **B3 (live tests):** manager→403 (non-inert negative control, D-15/Success #1); reconnect→409; overlap-lock no double-pull (two concurrent triggers, one 409); progress real not fabricated; audit row asserted. **Commit.**

### Track C — @frontend-web-developer (starts post-A0)
- **C1:** "Collecting your data" progress UX — records_processed/estimated_total/%/cursor_date, achieved-depth label, terminal states (completed/partial/failed+reason; never "running" forever, HP-4). Trigger button **brand_admin only**. **Commit.**
- **C2:** dashboard realized-revenue card → **"Gross Revenue (ex-fees)"** label + tooltip "Settlement fees not yet applied" (D-11/MC-2); provisional shown separately, never summed. **Commit.**
- **C3 (e2e):** trigger→progress renders real counts→on completion the realized number shows; manager can't trigger (button absent + API 403). **Commit.**

**Deploy-pipeline note:** No new service/deployable (D-1/I-E05) — `stream-worker` and `core` already have deploy pipelines; the worker is an existing-deployable job and the consumer is wired into the existing `stream-worker` main. No new GitOps app. The only infra delta is the additive `topics.yml` topic (applied by the existing redpanda-init / terraform redpanda module) — fold the topic-apply into A1's commit.

---

## 7. Test plan → mapped to intake Success Criteria (§ intake 1–14)

| # | Success criterion | Track / test |
|---|---|---|
| 1 | trigger 202 + job_id; manager 403 (non-inert) | B3 |
| 2 | second trigger → 409 BACKFILL_ALREADY_RUNNING | B3 (concurrent) |
| 3 | lost dev token → 409 RECONNECT_REQUIRED | B3 |
| 4 | pages of 250, cursor after every page, 429+Retry-After | A4 (fixture/mock Shopify) |
| 5 | each order → Bronze on backfill topic (not live); event_id deterministic; re-run 0 new rows | A4 |
| 6 | GET jobs real records_processed/estimated_total/percent/cursor_date | B3 + A4 |
| 7 | achieved_depth_label at completion = actual oldest date | A4 |
| 8 | terminal states explicit (completed/partial/failed+reason) | A4 + C1 |
| 9 | no raw PII in Bronze payload, logs, identity_link — hashes only | A4 (PII-strip + schema-lint) |
| 10 | occurred_at=processed_at; existing finalization job finalizes on next run | A4 (seed past-horizon, run revenue-finalization.ts) |
| 11 | "Gross Revenue (ex-fees)" label; provisional/realized separate, never summed | C3 |
| 12 | cross-brand isolation: under **brain_app** + wrong GUC, backfill_job & bronze 0 rows | A4 (BRAIN_APP_DATABASE_URL pool, MT-2) |
| 13 | live group offset lag unaffected by backfill storm | A4 (flood backfill topic, measure live lag) |
| 14 | audit log records trigger (actor, connector_instance_id, brand_id) | B3 |

**Real-network smoke:** A4 uses a fixture/mock Shopify HTTP server (real fetch against a local stub) for paging/429/Link; the live Boddactive backfill is the Stage-validation, not a unit gate. Isolation tests MUST run under `brain_app` (dev superuser `brain` masks RLS — MEMORY; two prior bounces).

---

## 8. Risk / reversibility

- **Reversible:** `0022` is additive, `DROP TABLE` rollback (rebuildable). New topic is additive. New worker/consumer are new files; backfill is gated by an explicit trigger (off by default). The 501→202 change is the only edit to a live route, behind the existing brand_admin gate.
- **Risk — event_id UUID shape (ADR-BF-2):** if the UUIDv5 derivation isn't stable, re-runs double-insert. Mitigated: pure function of (brand_id, shopify_order_id), unit-tested for determinism; Redis NX + PG PK are the backstops.
- **Risk — cross-process secret in dev (ADR-BF-11):** worker can't see core's in-memory token. Mitigated: worker reads the env-backed dev path; null → fail with checkpoint, not a silent hang.
- **Risk — payment_method classification (ADR-BF-15):** wrong cod/prepaid → wrong horizon. Mitigated: conservative mapping + the finalization job only finalizes past the (larger) COD horizon.
- **Risk — overlap-lock race (D-9):** mitigated DB-level `FOR UPDATE SKIP LOCKED`, never in-process (HP-2).

---

## 9. OUT OF THIS SLICE (hard boundary — do not scope-creep)

- **Live sync / webhooks / polling / 35-day re-pull window** — separate slice.
- **Settlement / Razorpay fees / net-of-fees recognition** — Razorpay slice (this slice is gross GMV, labeled).
- **Meta / Google Ads / other connectors** — Shopify orders only.
- **Argo Workflows orchestration** — stream-worker job pattern is the M1 runner.
- **Silver / Gold / dbt / StarRocks** — backfill lands Bronze; Postgres ledger is the M1 read path.
- **Shopify GraphQL Bulk Operations** — REST since_id sufficient for M1 volumes; Phase 2.
- **Product / customer / inventory backfill** — orders only (the realized-revenue spine).
- **Durable dev secret store (option b)** — reconnect-before-backfill (option a) is sufficient.
- **No NEW deployable of any kind.**

---

## Single-Primitive sweep — CLEAN (extend-only)

ONE Bronze writer (`ProcessEventUseCase` reused), ONE identity bridge (reused, reads pre-hashed), ONE ledger recognition path (`OrderEventConsumer`/`RecognizeOrder` wired, not forked), ONE finalization job (unchanged), ONE secrets seam (`ISecretsManager`, worker instantiates same), ONE audit log (`auditWriter.append`), ONE requireRole guard, ONE connector_cursor watermark, ONE collector event envelope (`CollectorEventV1`). New: ONE additive table, ONE additive topic, ONE worker job, ONE lane consumer, ONE Bronze-order→ledger wire that was scaffolded-but-missing. No per-channel fork, no new service/deployable.

## Over-engineering self-check — PASS
Tier-0 deterministic; no model call; no new infra layer; reuses every spine primitive; smallest additive surface (1 table, 1 topic, 1 job, 1 consumer, 1 wire); single-partition cap instead of a config layer; option-a dev secret instead of a new store.
