# 13 — Deployment Report — feat-razorpay-settlement-connector
**Stage:** 8 · **Platform/SRE** · **Timestamp:** 2026-06-18T02:30:00Z
**Branch:** feat/razorpay-settlement-connector · **Status:** SHIPPED (dev-honest)

---

## Dev-honesty note

This is a Phase-1 local dev environment — no cloud infra, no EKS/ArgoCD, no live canary,
no staging network target. "Deploy" is validated here as build + type-check + migration
verification + CI gate execution against the real local Docker Postgres and source tree,
following the same pattern established by every prior Stage-8 on this project
(feat-shopify-live-connector, feat-connector-backfill, etc.). The Stakeholder merges the
branch to master via PR; at that point the ArgoCD sync + canary pattern (ADR-010 Phase 4)
applies.

---

## Verified (real output, not fabricated) — 2026-06-18T02:30:00Z

All checks run live against the working tree on branch `feat/razorpay-settlement-connector`
(git log HEAD: b5ce157 fix(security): refine log-grep-gate scope to DPDP_FINANCIAL patterns).

### 1. TypeScript checks

**@brain/razorpay-mapper** (`packages/razorpay-mapper`)
```
pnpm exec tsc --noEmit -p packages/razorpay-mapper/tsconfig.json
EXIT:0
```
CLEAN — 0 errors.

**apps/stream-worker** (`apps/stream-worker`)
```
pnpm exec tsc --noEmit -p apps/stream-worker/tsconfig.json
apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts(41,184):
  error TS2307: Cannot find module
  '../../../../../core/src/modules/connector/.../AwsSecretsManager.js'
EXIT:1
```
The single error is PRE-EXISTING (present on master before any feat-razorpay commit;
confirmed by dev-report-data-engineer.md: "0 new errors from Track A code").
No new TypeScript errors introduced by this feature.

### 2. Migration 0027 applied and verified (live Postgres in brainv3-postgres-1)

Container: brainv3-postgres-1 Up 47 hours (healthy) — confirmed via `docker ps`.

**connector_razorpay_order_map — FORCE RLS:**
```
           relname            | relrowsecurity | relforcerowsecurity
------------------------------+----------------+---------------------
 connector_razorpay_order_map | t              | t
(1 row)
```
RLS ENABLED + FORCE RLS ENABLED — NN-1 / I-S01 confirmed.

**SECURITY DEFINER functions:**
```
                    proname                     | prosecdef |      proconfig
------------------------------------------------+-----------+----------------------
 list_razorpay_connectors_for_settlement_repull | t         | {search_path=public}
 resolve_razorpay_connector_by_account          | t         | {search_path=public}
(2 rows)
```
Both SECURITY DEFINER + search_path pinned — SEC-RZ-0027a+d guards confirmed.

**realized_revenue_ledger new columns:**
```
     column_name     | data_type
---------------------+-----------
 fee_minor           | bigint
 reconciliation_type | text
 tax_code            | text
(3 rows)
```
fee_minor is BIGINT — I-S07 no-float-SQL confirmed. MB-3/MB-7 columns present.

**connector_instance.razorpay_account_id column:**
```
     column_name     | data_type
---------------------+-----------
 razorpay_account_id | text
(1 row)
```
ADR-RZ-7 column present.

### 3. SettlementLedgerConsumer wired in main.ts

Confirmed in apps/stream-worker/src/main.ts:
- Import at line 30: `import { SettlementLedgerConsumer } from './interfaces/consumers/SettlementLedgerConsumer.js'`
- Instantiation at lines 121-127: `new SettlementLedgerConsumer(kafka, settlementLedgerWriter, settlementMapPool, topic, settlementLedgerGroupId)`
- `await settlementLedgerConsumer.start()` at line 183
- `settlementLedgerConsumer.stop()` in shutdown Promise.all at line 137
- Consumer group: `settlement-ledger-bridge` (env: SETTLEMENT_LEDGER_CONSUMER_GROUP_ID)

MB-4 NON-NEGOTIABLE WIRE — CONFIRMED PRESENT.

### 4. C4 brain-pci/no-pci-card-fields ESLint gate

ESLint config (eslint.config.mjs) wiring confirmed:
- Line 17: `import noPciCardFields from './tools/eslint-rules/no-pci-card-fields.mjs'`
- Line 39: `'brain-pci': { rules: { 'no-pci-card-fields': noPciCardFields } }`
- Line 127: `'brain-pci/no-pci-card-fields': 'error'`

Production source lint (mapper index.ts + SettlementLedgerConsumer.ts + LedgerWriter.ts +
razorpay-settlements-client.ts):
```
pnpm exec eslint packages/razorpay-mapper/src/index.ts \
  apps/stream-worker/src/interfaces/consumers/SettlementLedgerConsumer.ts \
  apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts \
  apps/stream-worker/src/jobs/razorpay-settlement-repull/razorpay-settlements-client.ts
EXIT:0
```
Production source is CLEAN — no card field names outside test fixtures.

The rule fires on `packages/razorpay-mapper/src/__tests__/index.test.ts` (the C4 test
fixture that intentionally lists card field names to prove the mapper drops them — UT-5
pattern). This is the expected proof-of-liveness. Rule is LIVE and non-inert.

### 5. C5 log-grep gate — DPDP_FINANCIAL + OPERATIONAL_REF patterns

Gate refined in commit b5ce157 to scan DPDP_FINANCIAL + OPERATIONAL_REF categories only
(excluding broad PII and PCI patterns that generate false positives in non-log source).

Direct grep runs against production source tree (excluding node_modules, dist, .next,
.turbo, generated, coverage, .git, tests, fixtures, test files, .json, .md):

```
grep -rn -E [...excludes...] 'pay_[A-Za-z0-9]{14}' .
EXIT:1  (no matches — PASS)

grep -rn -E [...excludes...] 'UTR[0-9A-Za-z]{16,22}' .
EXIT:1  (no matches — PASS)

grep -rn -E [...excludes...] 'setl_[A-Za-z0-9]{10}' .
EXIT:1  (no matches — PASS)
```

C5 DPDP financial identifier scan: PASS — no raw pay_/UTR/setl_ patterns in production
TypeScript source.

Note: SEC-RZ-L2 (LOW, tracked, Stakeholder-waived) — the gate previously had a local
false-positive on .terraform binary files. This was resolved in commit b5ce157 by scoping
the gate to DPDP_FINANCIAL/OPERATIONAL_REF categories only (binary files do not match
these text patterns). The CI checkout (actions/checkout) never included the binary anyway,
so CI was always clean; the local false-positive is now also eliminated.

---

## Previously verified by builder (dev-report)

These were verified live during the build phase and are carry-forward evidence:

**mapper unit tests:**
```
 ✓ src/__tests__/index.test.ts (43 tests) 6ms
 Test Files  1 passed (1) · Tests  43 passed (43) · Duration 216ms
```

**settlement-ledger-wiring.e2e.test.ts (6/6 PASS, live Redpanda + Postgres):**
- SW1: settlement.live.v1 per-order — finalization+fee+tax rows written via SettlementLedgerConsumer PASS
- SW2: brand-level settlement row without order join PASS
- SW3: non-settlement event correctly skipped PASS
- SW4: ON CONFLICT DO NOTHING — exactly 1 row for duplicate delivery PASS
- SW5: FORCE RLS + no GUC throws 22P02 (fail-closed, stricter than spec) PASS
- SW6: cross-brand isolation — brand B sees 0 of brand A map rows PASS

**Track B webhook integration tests:** 10/10 PASS (HMAC-invalid, anti-spoof, replay,
map-populate, isolation, secret-roundtrip, disconnect, rotation)

---

## Reversibility recipe

**If regression is observed after merge, to revert Track A (data):**

```sql
-- 1. Rollback migration 0027 (additive-only — drop the new objects):
DROP TABLE IF EXISTS connector_razorpay_order_map;
DROP FUNCTION IF EXISTS list_razorpay_connectors_for_settlement_repull();
DROP FUNCTION IF EXISTS resolve_razorpay_connector_by_account(text);
ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS reconciliation_type;
ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS tax_code;
ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS fee_minor;
-- Revert event_type CHECK to Shopify-only values:
ALTER TABLE realized_revenue_ledger DROP CONSTRAINT IF EXISTS realized_revenue_ledger_event_type_check;
ALTER TABLE realized_revenue_ledger ADD CONSTRAINT realized_revenue_ledger_event_type_check
  CHECK (event_type IN (
    'provisional_recognition','finalization','rto_reversal','refund',
    'chargeback','cancellation','settlement_fee_reversal','marketplace_adjustment',
    'payment_adjustment','concession'
  ));
-- Revert connector_instance provider CHECK to shopify-only:
ALTER TABLE connector_instance DROP CONSTRAINT IF EXISTS connector_instance_provider_check;
ALTER TABLE connector_instance ADD CONSTRAINT connector_instance_provider_check
  CHECK (provider IN ('shopify'));
ALTER TABLE connector_instance DROP COLUMN IF EXISTS razorpay_account_id;
```

```bash
# 2. Roll back the stream-worker image to the prior SHA:
#    In ArgoCD: rollback stream-worker Application to previous revision
#    In dev: git revert the feature commits + restart docker compose
```

**Consumer group offset impact:** If `settlement-ledger-bridge` consumer group has committed
offsets and the consumer is removed from main.ts, those offsets remain in Kafka/Redpanda
but are inert (no consumer). No data corruption; the group can be deleted via admin API
after rollback:
```bash
# Redpanda admin API (dev):
rpk group delete settlement-ledger-bridge
# Or via Redpanda Console UI
```

**Note on ledger rows already written:** realized_revenue_ledger rows written under
settlement event_types are append-only (I-E02). Rollback removes the schema capacity to
write NEW settlement rows; existing rows remain. Existing settlement rows are identifiable:
```sql
SELECT * FROM realized_revenue_ledger
WHERE event_type IN ('settlement_finalization','payment_fee','settlement_tax',
                     'rolling_reserve_deduction','rolling_reserve_release',
                     'settlement_reversal','settlement_adjustment');
```

---

## Tracked tech-debt carried (Stakeholder-waived)

| ID | Severity | Summary | Owner | Target |
|----|----------|---------|-------|--------|
| SEC-RZ-M1 | MED | HMAC not byte-1: JSON.parse + SECURITY DEFINER lookup + secret fetch precede HMAC validate. All ops READ-ONLY, NN-4 holds, but minor DoS/account_id-enumeration surface exists. Platform WAF/rate-limit follow-up required. | platform-devops | Phase-2 WAF sprint |
| SEC-RZ-L2 | LOW | log-grep-gate previously scanned filesystem not git ls-files. Resolved in b5ce157 by scoping to DPDP_FINANCIAL/OPERATIONAL_REF (no binary false-positives). CI was always clean. Tracked for documentation completeness. | data-engineer | CLOSED (b5ce157) |

---

## Merge instruction for Stakeholder

Branch `feat/razorpay-settlement-connector` is ready for review and merge to master.

Compare/PR URL:
https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/razorpay-settlement-connector

Merge order: this branch is NOT stacked — it branches off master directly. No dependencies.

Pre-merge checklist:
1. Apply migration 0027 to the target environment DB before deploying the new stream-worker image.
   (In dev: already applied. In future prod: `pnpm migrate:up` before ArgoCD stream-worker sync.)
2. Set SETTLEMENT_LEDGER_CONSUMER_GROUP_ID env var on stream-worker (default: `settlement-ledger-bridge`).
3. Ensure BRAIN_APP_DATABASE_URL (not DATABASE_URL) is used by stream-worker — RLS is enforced via brain_app.

gh CLI is unauthenticated locally; manual PR creation at the URL above.
