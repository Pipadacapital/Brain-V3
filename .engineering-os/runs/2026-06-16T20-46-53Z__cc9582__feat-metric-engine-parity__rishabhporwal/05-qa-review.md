# QA Review -- feat-metric-engine-parity
Stage: 5 (QA Engineer) | Mode: FULL | Verdict: PASS
Date: 2026-06-16T21:26:24Z | Branch: feat/metric-engine-parity

## Verdict: PASS (2 LOW deferred findings, 0 blocking)

All VETO criteria satisfied. The parity oracle is non-tautological (live RED proof executed by QA).
Gate is blocking and affected. Migration 0020 applied with SECURITY INVOKER (prosecdef=f).
No float in money path. 16/16 tests GREEN on clean DB.

## Execution Evidence

### Typecheck -- all EXIT 0

pnpm --filter @brain/metric-engine typecheck      -> tsc --noEmit EXIT 0
pnpm --filter @brain/tool-parity-oracle typecheck -> tsc --noEmit EXIT 0
pnpm --filter @brain/core typecheck               -> tsc --noEmit EXIT 0

### Migration 0020

psql: provisional_gmv_as_of present, prosecdef=f (SECURITY INVOKER confirmed)

### Parity Suite

Run 1 (dirty DB): 8/16 FAILED -- stale ledger rows from prior interrupted dev session.
  afterEach clears within-session but cannot clean prior orphan rows.

Run 2: 16/16 PASSED
  F1 clean_finalized:           engine={INR:50000n} ref={INR:50000n}
  F2 full_rto_to_zero:          engine={INR:0n}     ref={INR:0n}
  F3 partial_refund:            engine={INR:35000n} ref={INR:35000n}
  F4 provisional_plus_finalized: realized={INR:50000n} prov={INR:20000n}
  F5 two_brand_two_currency:    A={INR:50000n} B={AED:30000n}
  RED PROOF captured:           FAIL: TS=50001 REF=50000 delta=1 > tolerance=0
  RED PROOF reverted GREEN:     PASS: TS=50000 REF=50000 delta=0

Run 3: 16/16 PASSED (stable confirmation)

### RED PROOF -- QA Live Perturbation Cycle

validity_check --require-negative-control exited 3 (VETO). QA executed live cycle:

  Perturbation (realized-revenue.ts:73): BigInt(raw) -> BigInt(raw) + 1n
  Command: pnpm --filter @brain/tool-parity-oracle test:parity
  Result:  8/16 FAILED
    F1: delta=1 (engine=50001n, ref=50000n)
    F2: delta=1 (engine=1n, ref=0n)
    F3: delta=1 (engine=35001n, ref=35000n)
    F4: delta=1 (engine=50001n, ref=50000n) on realized
    F5: delta=1 (engine=50001n, ref=50000n) on Brand A

  Revert: restored to BigInt(raw)
  Command: pnpm --filter @brain/tool-parity-oracle test:parity
  Result:  16/16 PASSED

Gate is non-tautological. 1 minor unit drift detected across all INR realized fixtures.

### Oracle Non-Tautological Import Check

grep -n "^import" tools/parity-oracle/src/reference.ts
  -> line 30: import type { PoolClient } from 'pg';

Zero @brain/metric-engine imports. Zero calls to realized_gmv_as_of or provisional_gmv_as_of.
Reference predicates: recognition_label = 'finalized' GROUP BY currency_code
Engine predicates:    event_type <> 'provisional_recognition' (scalar BIGINT)

### CI Gate

pnpm turbo run test:parity --affected --dry-run
  Packages in scope: @brain/metric-engine, @brain/tool-parity-oracle (both present)
  @brain/tool-parity-oracle#test:parity dependsOn @brain/metric-engine#build

pr.yml:33 -- no continue-on-error. Gate is blocking.

### No-Float

grep -rn "parseFloat" packages/metric-engine/src/ -> NO MATCHES
All money fields bigint. checkParity delta: bigint arithmetic only (ts >= ref ? ts-ref : ref-ts)

### Isolation

ISO-1: current_user=brain_app, is_superuser=false (confirmed via appPool query)
ISO-2: Brand A engine returns 0 when only Brand B rows seeded (see QA-F2 weakness)
ISO-3: empty GUC -> fail-closed (UUID cast error or 0 rows via RLS)

## Findings

QA-F1 (LOW, deferred M2): Tests not idempotent on dirty DB
  beforeAll clears test brand UUIDs but prior interrupted sessions leave orphan rows.
  CI starts clean; local dev can hit this after process kill.
  Fix: explicit truncation for test brand IDs in globalSetup or guarded beforeAll.

QA-F2 (LOW, deferred M2): ISO-2 proves absence-of-data, not RLS block
  ISO-2 returns 0 for Brand A because Brand A has no rows, not because RLS blocked it.
  Stronger test: seed Brand A rows, run engine with Brand B GUC, expect 0.
  ISO-1 (non-superuser confirmed) and ISO-3 (fail-closed) are sound; this is a gap.

## Acceptance Contract Checklist

D-2 CRITICAL non-tautological  : PASS (import check + live RED proof)
D-2 1-minor delta fails CI      : PASS (8 fixtures red on +1n perturbation)
D-1 registry                   : PASS (9/9 unit tests)
D-3 CI dep edge                : PASS (--dry-run confirms affected scope)
D-4 0020 SECURITY INVOKER      : PASS (prosecdef=f confirmed in DB)
D-5 Map<CurrencyCode,bigint>   : PASS (F5 A=INR B=AED no blend)
D-6 import fence               : PASS (code reviewed; pattern !(measurement|analytics))
D-7 F-SEC-02 withBrandTxn      : PASS (code reviewed: BEGIN/set_config/fn/COMMIT)
bigint-fixtures no-float        : PASS (grep confirms no float in money path)
I-S01 isolation brain_app       : PASS with QA-F2 weakness (deferred)
CI gate blocking                : PASS (no continue-on-error in pr.yml)

## Journal

2026-06-16T21:26:24Z -- QA Engineer -- feat-metric-engine-parity
Stage: 5 | Mode: FULL | Verdict: PASS
Smoke: 16/16 live-DB parity (runs 2+3 stable)
Parity: PASS all 5 fixtures tolerance=0 plus RED PROOF executed by QA engineer
Validity: negative-control confirmed (perturb->8RED->revert->16GREEN)
Next: HANDOFF to final reconciliation
