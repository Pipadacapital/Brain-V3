# Developer Report — Data Engineer
## feat-realized-revenue-ledger (Stage 3)

**Date:** 2026-06-16  
**Role:** Data Engineer  
**Branch:** `feat/realized-revenue-ledger`  
**Run:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`

---

## Files Delivered

### Slice 1 — Migration + banker's rounding
- `/Users/rishabhporwal/Desktop/Brain V3/db/migrations/0018_realized_revenue_ledger.sql`
- `/Users/rishabhporwal/Desktop/Brain V3/packages/money/src/index.ts` (added `roundToMinorBankers`)

### Slice 2 — Recognition engine
- `apps/core/src/modules/measurement/index.ts` (public surface updated)
- `apps/core/src/modules/measurement/internal/domain/recognition/entities/LedgerEntry.ts`
- `apps/core/src/modules/measurement/internal/domain/recognition/value-objects/RecognitionEvent.ts`
- `apps/core/src/modules/measurement/internal/domain/recognition/services/LedgerEventId.ts`
- `apps/core/src/modules/measurement/internal/domain/recognition/policies/RecognitionPolicy.ts`
- `apps/core/src/modules/measurement/internal/domain/recognition/policies/RoundingPolicy.ts`
- `apps/core/src/modules/measurement/internal/application/commands/RecognizeOrder.ts`
- `apps/core/src/modules/measurement/internal/application/commands/PostReversal.ts`
- `apps/core/src/modules/measurement/internal/application/queries/GetRealizedGmvAsOf.ts`
- `apps/core/src/modules/measurement/internal/infrastructure/repositories/PgLedgerRepository.ts`
- `apps/core/src/modules/measurement/internal/interfaces/consumers/OrderEventConsumer.ts`

### Slice 3 — Finalization job
- `apps/stream-worker/src/jobs/revenue-finalization.ts`

### Slice 4 — Test suite
- `apps/core/src/modules/measurement/tests/realized-revenue-ledger.live.test.ts`

---

## Slice Dispositions

### Slice 1 — PASS
Migration `0018_realized_revenue_ledger.sql` applied to dev PG. All 3 migration-time assertions passed (NN-1 two-arg, append-only grant, _minor-is-bigint). `roundToMinorBankers` added to `@brain/money`.

**Verification output:**
```
ALTER TABLE  (brand cols: cod_recognition_horizon_days INT DEFAULT 25, prepaid_recognition_horizon_days INT DEFAULT 7, currency_code CHAR(3) DEFAULT 'INR')
CREATE TABLE (realized_revenue_ledger)
CREATE INDEX (realized_revenue_ledger_dedup UNIQUE)
CREATE INDEX (idx_rrl_asof partial)
ALTER TABLE ENABLE ROW LEVEL SECURITY
ALTER TABLE FORCE ROW LEVEL SECURITY
CREATE POLICY (two-arg current_setting)
REVOKE ALL ... GRANT SELECT, INSERT
CREATE FUNCTION (ledger_currency_matches_brand)
CREATE TRIGGER (trg_ledger_currency BEFORE INSERT)
CREATE FUNCTION (realized_gmv_as_of STABLE SECURITY INVOKER)
DO (NN-1 assertion) — passed
DO (append-only grant assertion) — passed
DO (no-float-SQL assertion) — passed
```

**brain_app verification:**
```sql
SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user;
-- brain_app | f  (non-superuser confirmed)

SELECT COUNT(*) FROM realized_revenue_ledger;
-- 0  (no GUC → fail-closed)

UPDATE realized_revenue_ledger SET amount_minor = 1 WHERE brand_id = gen_random_uuid();
-- ERROR: permission denied for table realized_revenue_ledger
```

`pnpm --filter @brain/money typecheck` → EXIT 0

### Slice 2 — PASS
Recognition engine wired in `apps/core/src/modules/measurement/internal/`. All money via `@brain/money` (bigint, no floats). `PgLedgerRepository` uses `set_config` GUC-first in same transaction, `ON CONFLICT (dedup key) DO NOTHING`. `GetRealizedGmvAsOfQuery` calls `realized_gmv_as_of()` named function only (no ad-hoc SUM).

`pnpm --filter @brain/core typecheck` → EXIT 0

### Slice 3 — PASS
`revenue-finalization.ts` Argo job (sibling of `phone-guard-reeval.ts`). Per-brand provisional scan with RTO/cancellation pre-check (M-3 race safety), finalization-exists guard, deterministic `ledger_event_id` (SHA-256), `ON CONFLICT DO NOTHING`, billing_posted_period from finalization's `occurred_at` (dual-date D-2).

`pnpm --filter @brain/stream-worker typecheck` → EXIT 0

### Slice 4 — PASS (30/30)
```
Tests  30 passed (30)
Duration  248ms
```

---

## Proof: No-Double-Count Closed-Sum

**Test:** `1. closed-sum / no-double-count` (3 sub-tests)

Golden fixture for order `order-closed-sum-{uuid}` with `saleAmount = 100000n` (INR 1000.00):

1. After inserting `provisional_recognition(+100000)`:
   - `realized_gmv_as_of(brand_a, today)` = **0** (provisional excluded)

2. After inserting `finalization(+100000)`:
   - `realized_gmv_as_of(brand_a, today)` = **100000** (correct realized GMV)
   - Naive `SUM(amount_minor)` = **200000** (provisional + finalization — WRONG, double-counted)
   - `realized_gmv_as_of` ≠ naiveSum — **proves the function is load-bearing** (D-3)

3. After inserting `refund(-100000)`:
   - `realized_gmv_as_of(brand_a, today)` = **0** (finalization + refund = 0, closed-sum proven)

**The named function `realized_gmv_as_of` is the sole correct as-of path. Ad-hoc SUM double-counts by 2×.**

---

## Proof: Append-Only-by-GRANT

**Migration-time (Assertion-2):**
```sql
DO $$ ... SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_name='realized_revenue_ledger' AND grantee='brain_app'
  AND privilege_type IN ('UPDATE', 'DELETE')
... RAISE EXCEPTION IF ANY FOUND $$
-- No row found → assertion passed → migration committed
```

**Runtime proof under brain_app:**
```sql
SET ROLE brain_app;
UPDATE realized_revenue_ledger SET amount_minor = 1 WHERE brand_id = ...;
-- ERROR: permission denied for table realized_revenue_ledger

DELETE FROM realized_revenue_ledger WHERE brand_id = ...;
-- ERROR: permission denied for table realized_revenue_ledger
```

Test `3. dual-date immutability`: UPDATE → permission denied ✓, DELETE → permission denied ✓

**This is structural immutability — not convention. brain_app has no UPDATE/DELETE grant.**

---

## Proof: Dual-Date Immutability

**Test:** `3. dual-date immutability > late reversal posts new current-period row`

- June finalization (`occurred_at = 2026-06-01T10:00:00Z`) → `billing_posted_period = '2026-06'`, `amount_minor = +75000`
- July RTO reversal (`occurred_at = 2026-07-05T10:00:00Z`) → `billing_posted_period = '2026-07'`, `amount_minor = -75000`
- June rows queried after July reversal: **1 row, amount = +75000 (unchanged)**
- July row confirmed: **1 row, amount = -75000, period '2026-07'**
- **No row from June was edited or deleted.** Two separate rows, two separate periods.

---

## Proof: No-Float Money

**Migration assertion (DO-block at apply time):**
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'realized_revenue_ledger' AND column_name LIKE '%_minor'
  AND data_type <> 'bigint'
-- 0 rows found → no float types on _minor columns → migration passed
```

**Test `4. no-float-money lint + migration BIGINT assertion`:**
- `all _minor columns on realized_revenue_ledger are bigint` ✓
- `no parseFloat / float arithmetic on money identifiers in recognition engine` ✓
- `no NUMERIC/FLOAT/DOUBLE type on _minor columns in 0018 migration SQL` ✓

**Grep proof:**
```
grep -rn "NUMERIC|REAL|DOUBLE|FLOAT" db/migrations/0018_realized_revenue_ledger.sql | grep -v "^\s*--\|-- " | grep "_minor"
(no output — CLEAN)
```

**ESLint no-float-money fires on bad fixture:**
```
tools/eslint-rules/fixtures/bad-float-money.ts
  5:7   warning  Monetary column "revenue_amount"... brain-money/no-float-money
  5:32  warning  Float literal assigned to... brain-money/no-float-money
  8:21  warning  Float literal assigned to... brain-money/no-float-money
  12:3  warning  Monetary column "service_fee"... brain-money/no-float-money
✖ 4 problems (0 errors, 4 warnings)
```

---

## Proof: Single-Currency Guard

**Test:** `5. single-currency guard — BEFORE INSERT trigger`

```sql
-- Brand A has currency_code = 'INR'
INSERT INTO realized_revenue_ledger (... currency_code = 'AED' ...) VALUES (...);
-- ERROR:  currency mismatch: ledger row currency=AED but brand aaaaa018-... currency=INR.
--   All ledger rows for a brand must share its currency_code.
```

The BEFORE INSERT trigger `trg_ledger_currency` → `ledger_currency_matches_brand()` fires and rejects the mismatched INSERT.

---

## Proof: Isolation Under brain_app

**Test:** `6. isolation negative-control under brain_app`

```
current_user = 'brain_app', is_superuser = false  ✓

No GUC: COUNT(*) = 0 (fail-closed: empty string → uuid cast fails → 0 rows) ✓

Brand-A GUC, query brand_B: COUNT(*) WHERE brand_id = BRAND_B = 0 (RLS blocks) ✓
```

**The dev superuser `brain` BYPASSES RLS — all isolation tests run under `brain_app` (NOSUPERUSER NOBYPASSRLS).**

---

## Proof: Replay Idempotency

**Test:** `7. replay-idempotency — dedup key`

Same Bronze event emitted 3×:
- Insert 1: `inserted = true` (row written)
- Insert 2: `inserted = false` (dedup key conflict → ON CONFLICT DO NOTHING)
- Insert 3: `inserted = false` (dedup key conflict → ON CONFLICT DO NOTHING)
- DB row count: **1** (not 3)
- `ledger_replay_suppressed_total{brand_a:provisional_recognition}` = **2**

---

## Typecheck Summary

```
pnpm --filter @brain/money typecheck  → EXIT 0
pnpm --filter @brain/core typecheck   → EXIT 0
pnpm --filter @brain/stream-worker typecheck → EXIT 0
```

---

## Commits (per slice)

| Slice | SHA | Message |
|---|---|---|
| S1 | `d4e046f` | feat: 0018 realized_revenue_ledger migration + as-of fn + roundToMinorBankers |
| S2 | `2fbdb55` | feat: recognition engine (provisional + signed reversals, idempotent writer) |
| S3 | `62e3e6b` | feat: horizon finalization job + reversal paths + replay metric |
| S4 | `fa8afdd` | test: closed-sum, immutability, isolation, dedup, rounding, horizon (30/30 pass) |

---

## D-5 Reconciliation Tolerance (Sprint-0 Freeze Required)

Per architecture §D-5: reconciliation tolerance (±2–3% by W4, >±5% stop-and-fix) is a Data Engineer Sprint-0 freeze, non-blocking for this slice. External Shopify reconciliation tests are not in M1 scope (`01-requirement.md:72`). The closed-sum tests use exact integer equality (no tolerance). **Freeze the tolerance value as a named constant before any external-reconciliation integration test runs.**
