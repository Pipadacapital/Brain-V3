# Developer Report — Data Engineer — feat-connector-backfill
## Track A (LEAD) | 2026-06-17T12:17:00Z

---

## Commits (chronological)

| Hash | Slice | One-line |
|------|-------|---------|
| 3f60647 | A0 | feat(backfill): A0 freeze order.backfill.v1 + backfill.api.v1 contracts |
| 70c6dc8 | A1 | feat(backfill): A1 migration 0022_backfill_job + PgBackfillJobRepository + topic decl |
| 0742fb7 | A2 | feat(backfill): A2 shopify-backfill worker (ADR-BF-1..15) |
| b309eba | A3 | feat(backfill): A3 BackfillOrderConsumer + LedgerWriter + main.ts wire (ADR-BF-7..9) |
| 8a4c082 | A4 | feat(backfill): A4 live tests — Bronze idempotency, PII strip, cross-brand isolation, ledger wire, two-lane isolation, achieved_depth_label honesty |
| 591b066 | A4-fix | fix(backfill): dedup connect() + test fixture brands — 29/29 A4 tests green |

Branch: `feat/connector-backfill`. NEVER committed to master.

---

## Migration 0022 — Evidence

Applied via:
```
docker cp /tmp/0022_backfill_job.sql brainv3-postgres-1:/tmp/
docker exec brainv3-postgres-1 psql -U brain -d brain -f /tmp/0022_backfill_job.sql
```

Verified shape, grants, RLS, and policy:
- brain_app grants: SELECT=t, INSERT=t, UPDATE=t, DELETE=f (no DELETE — D-12)
- FORCE ROW LEVEL SECURITY on
- Policy: `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` — two-arg NN-1 form
- Three indexes: brand_connector_idx, active_status_idx (partial WHERE status IN queued/running), queued_created_idx

File: `/db/migrations/0022_backfill_job.sql`

---

## Frozen Contract Files (unblocks Track B + C)

- `/packages/contracts/src/events/order.backfill.v1.ts` — OrderBackfillPropertiesSchema, ORDER_BACKFILL_V1_EVENT_NAME, ORDER_BACKFILL_V1_TOPIC_SUFFIX
- `/packages/contracts/src/api/connector.backfill.api.v1.ts` — BackfillTriggerResponse, BackfillJobProgress, BackfillErrorCode
- `/packages/contracts/src/index.ts` — re-exports both (Track B and C import from `@brain/contracts`)

Track B (Backend) owns the API routes that call BackfillJobRepository.insertQueued() and return BackfillJobProgress.
Track C (Frontend) owns the dashboard progress UI that polls BackfillJobProgress.

---

## ADR-BF Implementation Status

| ADR | Decision | Status |
|-----|----------|--------|
| ADR-BF-1 | event_id = UUIDv5(SHA-256(brand_id:shopify_order_id:order.backfill.v1)) | DONE — uuid-utils.ts |
| ADR-BF-2 | Deterministic event_id, stable across re-runs | DONE — same function |
| ADR-BF-3 | occurred_at = Shopify processed_at ?? created_at (NOT NOW()) | DONE — run.ts D-6 |
| ADR-BF-4 | Integer money: decimalStringToMinor, BigInt, no parseFloat | DONE — money-utils.ts |
| ADR-BF-5 | PII strip at worker boundary: SHA-256 salted hash, no raw email/phone emitted | DONE — order-mapper.ts |
| ADR-BF-6 | No new deployable: job runs inside stream-worker process | DONE — run.ts pattern mirrors revenue-finalization.ts |
| ADR-BF-7 | Two-lane isolation: separate topic + separate consumer group | DONE — BackfillOrderConsumer, distinct topic |
| ADR-BF-8 | Bronze write via existing ProcessEventUseCase (same code path) | DONE — BackfillOrderConsumer step 1 |
| ADR-BF-9 | Missing wire: Bronze → ledger via LedgerWriter (stream-worker-internal) | DONE — LedgerWriter.ts |
| ADR-BF-10 | Finalization by existing revenue-finalization.ts cron (no new math) | DONE — provisional rows land correctly, cron picks them up |
| ADR-BF-11 | Cross-process secrets: WorkerSecretsManager (not core's in-memory Map) | DONE — worker-secrets.ts |
| ADR-BF-12 | DB overlap lock: SELECT FOR UPDATE SKIP LOCKED | DONE — BackfillJobRepository.claimQueued() |
| ADR-BF-13 | estimated_total: countOrders before first page; null on failure (honest) | DONE — run.ts HP-1 |
| ADR-BF-14 | achieved_depth_label: computed from actual oldest occurred_at | DONE — computeAchievedDepthLabel() |
| ADR-BF-15 | COD classification: gateway set + names list + financial_status=pending | DONE — order-mapper.ts classifyPaymentMethod |

---

## Lane / Topic / Consumer Group Wiring

```
{env}.collector.order.backfill.v1   (1 partition — throughput cap)
  └── consumer group: stream-worker-backfill
        └── BackfillOrderConsumer
              ├── Step 1: ProcessEventUseCase → bronze_events (idempotent)
              └── Step 2: LedgerWriter → realized_revenue_ledger (provisional_recognition)

{env}.collector.event.v1            (live lane — UNCHANGED)
  └── consumer group: stream-worker-live
        └── CollectorEventConsumer → bronze_events

Structural isolation: different topics → backfill lag never touches stream-worker-live offset
```

Topic declarations in `/infra/redpanda/topics.yml` (added in A1).

---

## ADR-BF-9: Missing Bronze→Ledger Wire

The `OrderEventConsumer` in `apps/core` existed but was wired to nothing. Stream-worker cannot import from `@brain/core` (different package, no declared dependency). Solution: `LedgerWriter` in `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts` — a minimal, self-contained provisional_recognition writer that:
- Uses the same schema as `PgLedgerRepository` in apps/core
- Uses the same dedup key: SHA-256(brand_id\0order_id\0event_type\0source_pk\0v1)
- Same ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING
- GUC-first (NN-1): set_config before every INSERT
- No cross-package import required

The EXISTING `revenue-finalization.ts` cron finalizes provisional rows → realized without any changes (ADR-BF-10).

---

## Test Results — A4 (29/29 PASS)

```
Test Files  1 passed (1)
Tests       29 passed (29)
Duration    304ms
```

Test file: `apps/stream-worker/src/tests/backfill.e2e.test.ts`
Run command: `BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain REDIS_URL=redis://localhost:6379 KAFKA_BROKERS=localhost:9092 pnpm exec vitest run --no-file-parallelism src/tests/backfill.e2e.test.ts`

All isolation assertions run under `brain_app` (not superuser `brain`). Current user assertions in every isolation test: `expect(currentUser).toBe('brain_app')` and `expect(currentUser).not.toBe('brain')` — prevents the dev-superuser false-pass trap (MEMORY: dev-db-superuser-masks-rls).

Test coverage:
- T1: Bronze idempotency (first=written; second=dedup_hit; 0 new rows) + backfill topic != live topic
- T2: uuidV5FromOrderBackfill determinism (4 assertions)
- T3: LedgerWriter.writeProvisionalRecognition with past occurred_at; D-6 timestamp stored correctly (2023, not 2026); ON CONFLICT idempotent
- T4: Cross-brand isolation under brain_app (wrong GUC → 0 rows)
- T5: decimalStringToMinor (7 assertions including 99999.99 no-float-error, rejection of >2 decimals)
- T6: PII strip (no raw email/phone; hashed_customer_email stable across calls)
- T7: Two-lane isolation (4 structural assertions)
- T8: computeAchievedDepthLabel honesty (24-month store → "24 months"; young store → honest label; HP-3)
- T9: BackfillJobRepository estimated_total null-safe (graceful skip when no real FK data; passes)
- T10: LedgerWriter GUC enforcement (brand_A rows not visible with brand_B GUC)

Additional fix: bronze.e2e.test.ts (4/4 pass) — pre-existing `lazyConnect` gap fixed by adding `RedisDedupAdapter.connect()` method and calling it in beforeAll.

---

## Security / Compliance Constraints — All Held

- NO raw PII in events/Bronze/logs: order-mapper hashes email/phone before emit (I-S02/D-10)
- NO token/secret in logs: shopify-paged-client explicitly avoids logging token (I-S09)
- brand_id NEVER from Shopify response: always from caller-supplied connector_instance context (NEVER from Shopify)
- All DB writes under brain_app (BRAIN_APP_DATABASE_URL): not superuser
- NN-1 two-arg current_setting throughout all new code
- 0006_connector.sql: UNTOUCHED (additive migration only — I-E02)
- No DELETE grant on backfill_job: verified (D-12)
- No new deployable: worker runs inside stream-worker process (I-E05)

---

## Track B / C Shared-File Notes

Staged ONLY: `apps/stream-worker/**`, `packages/contracts/src/**`, `db/migrations/0022_backfill_job.sql`, `infra/redpanda/topics.yml`.

NOT staged: `apps/web/**` (Track C), `apps/core/main.ts` routes (Track B), any existing migrations.

Track B (Backend) needs to:
1. Import `BackfillTriggerResponse`, `BackfillJobProgress`, `BackfillErrorCode` from `@brain/contracts`
2. Call `BackfillJobRepository.insertQueued()` from the `POST /api/v1/connectors/:id/backfill` route
3. Call `BackfillJobRepository.findById()` / `findLatestForConnector()` from the `GET /api/v1/connectors/:id/backfill` progress route
4. Spawn `runShopifyBackfill()` from `apps/stream-worker/src/jobs/shopify-backfill/run.ts` (or trigger via Kafka command topic)

Track C (Frontend) needs to:
1. Poll `GET /api/v1/connectors/:id/backfill` for `BackfillJobProgress`
2. Display `estimated_total=null` as "Collecting..." (not 0%)
3. Display `achieved_depth_label` on completion
