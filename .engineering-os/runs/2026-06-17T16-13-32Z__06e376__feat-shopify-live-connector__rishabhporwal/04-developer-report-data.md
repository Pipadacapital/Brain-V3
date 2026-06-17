# Developer Report — Data Engineer — feat-shopify-live-connector
**Date:** 2026-06-17T21:05:00Z
**Branch:** feat/shopify-live-connector
**Req ID:** feat-shopify-live-connector
**Stage:** 3 (dev-parallel complete)
**Track:** A (data-engineer, LEAD)

---

## Commits

| Hash | Slice | Summary |
|------|-------|---------|
| 7cdbc81 | A0 | Freeze @brain/shopify-mapper — uuidV5FromOrderLive (D-6), uuidV5FromOrderBackfill, mapOrderToEvent; backfill shims re-point |
| 43ab45b | A1 | Migration 0026 — list_connectors_for_repull() + resolve_connector_by_shop_domain() SECURITY DEFINER fns |
| 25d0af6 | A2 | 35-day re-pull job (shopify-live-client.ts + run.ts) — SECURITY DEFINER enumeration, SKIP LOCKED, live lane emission |
| db123af | A3 | LedgerWriter.writeReversal() + LiveOrderConsumer — provisional vs rto_reversal branch on cancelled_at |
| 90f409c | A4 | Live connector e2e tests — 16/16 GREEN under brain_app + assertBrainApp |

---

## Deliverables

### A0: @brain/shopify-mapper package

New workspace package at `packages/shopify-mapper/` (`@brain/shopify-mapper`).

**Key exports:**

```typescript
// D-6 dedup: distinct per state change
export function uuidV5FromOrderLive(brandId: string, orderId: string, updatedAtUtcMs: number): string
// input: `${brandId}:${orderId}:${updatedAtUtcMs}:order.live.v1`
// sha256 → first 16 bytes → version nibble=5, RFC4122 variant bits

export function uuidV5FromOrderBackfill(brandId: string, shopifyOrderId: string): string
// input: `${brandId}:${shopifyOrderId}:order.backfill.v1`

export function mapOrderToEvent(
  order: ShopifyOrderShape,
  saltHex: string,
  regionCode: string,
  eventName: 'order.backfill.v1' | 'order.live.v1'
): MappedOrderEvent

export function decimalStringToMinor(str: string): bigint
export const ORDER_LIVE_V1_EVENT_NAME = 'order.live.v1' as const
export const ORDER_BACKFILL_V1_EVENT_NAME = 'order.backfill.v1' as const
```

D-6 worked example:
- brandId: `c07ec701-0a00-4a00-8a00-000000000001`
- orderId: `LIVE-T1-ORDER-001`
- updatedAtUtcMs: `1748772000000` (2026-06-01T10:00:00Z)
- input string: `c07ec701-0a00-4a00-8a00-000000000001:LIVE-T1-ORDER-001:1748772000000:order.live.v1`
- result: UUID-shaped, version 5, RFC4122 variant, distinct from backfill UUID for same order

Namespace separation: `:order.live.v1` vs `:order.backfill.v1` — guaranteed no collision even for the same (brandId, orderId) pair.

Backfill shims: `order-mapper.ts`, `uuid-utils.ts`, `money-utils.ts` in stream-worker re-export from `@brain/shopify-mapper` — zero functional change to existing backfill path.

### A1: Migration 0026

File: `db/migrations/0026_live_connector_security_definer_fns.sql`

Two SECURITY DEFINER functions applied to dev DB:

**list_connectors_for_repull()**: Returns all `connector_instance` rows where `provider='shopify' AND status='connected'`, ordered by created_at ASC. Bypasses FORCE RLS (runs as superuser 'brain'). GRANT EXECUTE TO brain_app.

**resolve_connector_by_shop_domain(p_shop_domain text)**: Returns the connected shopify connector for a given shop domain. LIMIT 1.

Security assertions (three DO blocks each, mirrors migration 0023):
- SECURITY DEFINER = true: PASS
- search_path = public: PASS
- brain_app EXECUTE granted: PASS

### A2: 35-day re-pull job

Files:
- `apps/stream-worker/src/jobs/shopify-repull/run.ts`
- `apps/stream-worker/src/jobs/shopify-repull/shopify-live-client.ts`

Key design properties:
- Enumerates connectors via `list_connectors_for_repull()` — brand_id NEVER from env/header/Shopify
- GUC set (`set_config`) AFTER enumerate, before any brand-scoped write
- `FOR UPDATE SKIP LOCKED` on `connector_cursor` row (resource=`orders.repull`) — prevents double re-pull
- `resource='orders.repull'` distinct from backfill `resource='orders'` — cursors never collide
- 35-day window via `updated_at_min = new Date(now - 35d).toISOString()`
- Pagination: since_id ascending stable walk (250 orders/page, 10 retry on 429)
- Emits to LIVE topic (collector.event.v1) with `event_name='order.live.v1'` + `uuidV5FromOrderLive` event_id
- `setSyncState` updates `last_sync_at=NOW()` only on `state='connected'` (not on syncing/error)
- `updated_at` included in Shopify fields request (required for live event_id derivation)

### A3: LedgerWriter.writeReversal() + LiveOrderConsumer

**LedgerWriter.writeReversal()** (`apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts`):
- Writes a new negative ledger row for cancellation/RTO events
- `amount_minor = -${order.amountMinor}` (BIGINT-as-string signed, I-S07)
- `recognition_label = 'finalized'` (not provisional — reversal is final)
- `event_type = 'rto_reversal' | 'cancellation'`
- ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING — idempotent
- Sale/provisional/finalized rows UNTOUCHED (append-only by brain_app GRANT: SELECT+INSERT only)

**LiveOrderConsumer** (`apps/stream-worker/src/interfaces/consumers/LiveOrderConsumer.ts`):
- `extractLiveOrderForLedger()`: parses `order.live.v1` envelope → `BackfillOrderForLedger`
- `routeLiveOrderToLedger()`: routes on `cancelled_at`:
  - `cancelled_at != null` → `writeReversal()` → returns `'reversal'`
  - `cancelled_at == null` → `writeProvisionalRecognition()` → returns `'provisional'`
- Does NOT subscribe to a new topic — called from CollectorEventConsumer composition after Bronze write

### A4: E2E Tests

File: `apps/stream-worker/src/tests/live-connector.e2e.test.ts`

**16/16 tests passing** under `BRAIN_APP_DATABASE_URL` (brain_app role, RLS enforced, assertBrainApp()).

| Test | Coverage |
|------|---------|
| T1 | order.live.v1 → Bronze write; live topic = collector.event.v1 (not backfill) |
| T2-a | uuidV5FromOrderBackfill != uuidV5FromOrderLive for same order (D-6 namespace proof) |
| T2-b | backfill Bronze + live Bronze for same order = 2 distinct rows |
| T3-a | two distinct updated_at → two distinct Bronze rows |
| T3-b | same updated_at retry → ONE Bronze row (dedup: r1='written', r2='dedup_hit') |
| T4-a | non-cancelled → provisional_recognition row, positive amount |
| T4-b | cancelled → rto_reversal (negative), provisional untouched, realized_gmv_as_of <= 0 (D-13) |
| T5-a | upsertRepullCursor stores resource=orders.repull |
| T5-b | orders.repull cursor distinct from orders cursor (backfill) |
| T6 | SKIP LOCKED: first acquireRepullLock=true, second=false when row locked |
| T7-a | assertBrainApp: current_user=brain_app, is_superuser=false |
| T7-b | bare SELECT on connector_instance without GUC = 0 rows (FORCE RLS fail-closed) |
| T7-c | list_connectors_for_repull() returns seeded row without GUC (SECURITY DEFINER bypasses RLS) |
| T8-a | Brand B GUC → 0 Brand A Bronze rows (cross-brand isolation) |
| T8-b | Brand A GUC → 1 Brand A Bronze row (positive control) |

Infrastructure note: All Bronze/ledger reads in tests wrapped in `BEGIN + set_config('app.current_brand_id', brandId, true) + SELECT + COMMIT`. Raw `appPool.query()` without GUC returns 0 rows under FORCE RLS.

---

## Stream/Batch Parity

| Path | Metric computation |
|------|-------------------|
| Live (order.live.v1) | `writeProvisionalRecognition()` → same schema as backfill provisional |
| Backfill (order.backfill.v1) | `writeProvisionalRecognition()` — same LedgerWriter method |
| Finalization (cron) | `revenue-finalization.ts` reads provisionals, writes finalized rows — unchanged |
| Reversal (RTO) | `writeReversal()` → negative rto_reversal row — overrides economic outcome |

Parity: provisional_recognition dedup key = SHA-256(brand_id + order_id + 'provisional_recognition' + source_pk + v1) — matches revenue-finalization.ts `computeLedgerEventId`. Same schema, same ON CONFLICT constraint, same finalization cron.

---

## Guardrails Honored

- brand_id NEVER from env/Shopify/header — always from `list_connectors_for_repull()` SECURITY DEFINER result
- GUC set AFTER enumerate, before any brand-scoped read/write (NN-1)
- NO raw PII in events/Bronze/logs (customer.phone/email not propagated)
- NO token in logs (I-S09 — accessToken in Authorization header only)
- Append-only ledger: brain_app SELECT+INSERT only; reversal is a new negative row
- NEVER touched brand 60d543dc-* (all tests use CONNECTOR_TEST_BRAND_A/B fixture brands)
- All commits on feat/shopify-live-connector branch (NEVER committed to master)
- No new deployable (re-pull job and LiveOrderConsumer compose into stream-worker)

---

## Test Verification

```
npx vitest run apps/stream-worker/src/tests/live-connector.e2e.test.ts
→ 16/16 PASS

npx vitest run apps/stream-worker/src/tests/
→ 115/115 PASS (10 test files, zero regressions)
```

---

## Deviations from Architecture Plan

None material. One implementation note:

The T3-b "same updated_at retry → ONE row" test uses `Date.now()`-based order IDs to ensure event_ids are fresh per run (Redis dedup TTL is 7 days; the `afterAll` cleanup deletes Bronze rows for test brands — without fresh IDs, a prior run's Redis entry causes `dedup_hit` with no Bronze row). This is an integration-test harness concern, not a production behavior difference.
