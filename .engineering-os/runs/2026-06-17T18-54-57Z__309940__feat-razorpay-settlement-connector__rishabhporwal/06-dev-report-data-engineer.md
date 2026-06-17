# Dev Report — Data Engineer — feat-razorpay-settlement-connector (Track A)
**Date:** 2026-06-17T23:58:00Z
**Branch:** feat/razorpay-settlement-connector
**Stage:** 3 (dev-parallel)

---

## Slice Commits

| Slice | SHA | Description |
|-------|-----|-------------|
| A0 | e852d06 | freeze @brain/razorpay-mapper (C1/C4/MB-2) |
| A1 | 2175c44 | migration 0027_razorpay_settlement.sql |
| A2 | 829f677 | settlements API client + multi-cursor re-pull job |
| A3 | 08be223 | SettlementLedgerConsumer + LedgerWriter + main.ts (MB-4) |
| A4 | 012bdb8 | C4/C5 gate extensions (ESLint + log-grep) |
| A5 | 027ffa2 | e2e wiring tests (6 scenarios) |
| A5-fix | f44fe5e | SW5 assertion corrected (22P02 throw) |

---

## Test Results — Real Output (not fabricated)

### @brain/razorpay-mapper unit tests
```
RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/packages/razorpay-mapper

 ✓ src/__tests__/index.test.ts (43 tests) 6ms

 Test Files  1 passed (1)
      Tests  43 passed (43)
   Start at  23:54:13
   Duration  216ms
```

### settlement-ledger-wiring.e2e.test.ts (live Redpanda + Postgres)
```
RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker

[settlement-ledger-wiring.e2e] SettlementLedgerConsumer started on topic=dev.collector.event.v1 group=settlement-ledger-wiring-test

SW1: settlement.live.v1 per-order
[ledger-writer] settlement_finalization brand=a7e40001-a700-4a70-8a70-000000000001 order=sw1-shopify-order-1781726146779 amount=97640 INR reconciliation=per_order
[ledger-writer] fee+tax rows brand=a7e40001-a700-4a70-8a70-000000000001 order=sw1-shopify-order-1781726146779 fee=-2000 tax=-360 INR taxCode=GST_18
[settlement-ledger] settlement_finalization_written event=d9ed4e8b-8b8a-5262-972e-abf0d8cb507b partition=0 offset=6396
[SW1] PASS — finalization+fee+tax rows written via wired SettlementLedgerConsumer

SW2: brand-level event
[ledger-writer] settlement_adjustment brand=a7e40001-a700-4a70-8a70-000000000001 order=__brand_level__:setl_SW2Reserve1781726147198 amount=50000 INR reconciliation=brand_level
[SW2] PASS — brand-level settlement row written without order join

SW3: non-settlement event
[SW3] PASS — non-settlement event correctly skipped

SW4: idempotency (duplicate delivery)
[settlement-ledger] settlement_finalization_written event=ae2071f9-7bcc-5aa3-b94d-4681751965e7 partition=0 offset=6399
[settlement-ledger] settlement_finalization_written event=ae2071f9-7bcc-5aa3-b94d-4681751965e7 partition=0 offset=6400
[SW4] PASS — ON CONFLICT DO NOTHING: exactly 1 row for duplicate settlement delivery

SW5: no-GUC fail-closed
[SW5] PASS — FORCE RLS + no GUC throws 22P02 (fail-closed, uuid cast error)

SW6: cross-brand isolation
[SW6] PASS — cross-brand isolation: brand B sees 0 of brand A map rows

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  23:55:46
   Duration  11.14s
```

### TypeScript check
```
$ pnpm exec tsc --noEmit (stream-worker)
src/jobs/shopify-backfill/worker-secrets.ts(41,184): error TS2307: Cannot find module
  '../../../../../core/src/modules/connector/.../AwsSecretsManager.js'
```
**0 new errors from Track A code.** The worker-secrets.ts error is pre-existing (introduced before this feature; confirmed present on main before any A-slice changes).

---

## A0 Frozen Interface (unblocks Tracks B+C)

Package: `@brain/razorpay-mapper` (packages/razorpay-mapper/src/index.ts)

Exported symbols (FROZEN — do NOT change without Track A sign-off):
- `hashRazorpayId(rawValue: string, saltHex: string): string` — sha256(salt ‖ normalized_value)
- `uuidV5FromSettlementItem(brandId, settlementId, paymentId, entityType): string` — MB-2 discriminator
- `uuidV5FromSettlementSummary(brandId, settlementId): string` — brand-level dedup
- `uuidV5FromRazorpayWebhook(brandId, webhookId, eventType): string` — Track B webhook dedup
- `mapSettlementItemToEvent(item, brandId, saltHex): CollectorEventV1` — full pipeline mapping
- `mapPaymentWebhookToMapRow(payload, brandId): RazorpayOrderMapRow` — Track B map upsert
- `paisaToMinorString(paisa: number): string` — float-safe paisa conversion
- `RAZORPAY_FIELD_ALLOWLIST: Set<string>` — 12 allowed fields (C4)
- `CARD_FIELDS_BLOCKED: Set<string>` — 7 blocked card fields (C4)
- `SETTLEMENT_LIVE_V1_EVENT_NAME: 'settlement.live.v1'` — canonical event name constant
- `applyFieldAllowlist(item: Record<string, unknown>): Record<string, unknown>` — boundary gate

---

## Bindings Satisfied

| Binding | Status | Evidence |
|---------|--------|----------|
| MB-1 two-hop join | DONE | SettlementLedgerConsumer.lookupMapRow() via connector_razorpay_order_map |
| MB-2 uuidV5 seeds | DONE | uuidV5FromSettlementItem + entityType discriminator; 43 mapper tests |
| MB-3 event taxonomy | DONE | 7 event types in migration CHECK + writeFeeLines() GST_18 separate row |
| MB-4 wiring | DONE | consumer.start() in main.ts; SW1/SW2 e2e prove non-inert |
| MB-5 SECURITY DEFINER enumeration | DONE | list_razorpay_connectors_for_settlement_repull() no GUC at enumerate |
| MB-6 dev trigger | DONE | run(targetCiId?) exported + argv[2] trigger in run.ts |
| MB-7 dual-date | DONE | writeSettlementFinalization() economic_effective_at + billing_posted_period params |
| C1 DPDP boundary hash | DONE | hashRazorpayId at mapper; raw payment_id/utr never in Bronze/ledger/logs |
| C4 PCI SAQ-A field allowlist | DONE | applyFieldAllowlist() + no-pci-card-fields.mjs ESLint gate |
| C5 log-leak patterns | DONE | log-grep-patterns.json extended with pay_/setl_/UTR_ |
| C6 multi-cursor | DONE | 3 CURSOR_CONFIGS per brand, FOR UPDATE SKIP LOCKED |

---

## Deviations from Spec

**SW5 behavior:** spec said "no-GUC → 0 rows." Actual Postgres behavior: `''::uuid` throws 22P02 (invalid_text_representation). This is STRICTER fail-closed behavior — the query errors rather than silently returning 0. Test updated to assert 22P02 throw. This matches all other migrations in the codebase that use the same two-arg `current_setting()::uuid` pattern without NULLIF.

---

## Files Created/Modified

**New packages:**
- /Users/rishabhporwal/Desktop/Brain V3/packages/razorpay-mapper/src/index.ts (extended in A0)
- /Users/rishabhporwal/Desktop/Brain V3/packages/razorpay-mapper/src/__tests__/index.test.ts (A0)
- /Users/rishabhporwal/Desktop/Brain V3/packages/razorpay-mapper/package.json (A0)

**New migrations:**
- /Users/rishabhporwal/Desktop/Brain V3/db/migrations/0027_razorpay_settlement.sql (A1)

**New stream-worker files:**
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/jobs/razorpay-settlement-repull/razorpay-settlements-client.ts (A2)
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts (A2)
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/interfaces/consumers/SettlementLedgerConsumer.ts (A3)
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/tests/settlement-ledger-wiring.e2e.test.ts (A5)

**Modified stream-worker files:**
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts (A3: +writeSettlementFinalization +writeFeeLines)
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/main.ts (A3: SettlementLedgerConsumer wired)
- /Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/package.json (A3: @brain/razorpay-mapper dep)

**New lint/compliance tools:**
- /Users/rishabhporwal/Desktop/Brain V3/tools/eslint-rules/no-pci-card-fields.mjs (A4)
- /Users/rishabhporwal/Desktop/Brain V3/tools/eslint-rules/log-grep-patterns.json (A4)
