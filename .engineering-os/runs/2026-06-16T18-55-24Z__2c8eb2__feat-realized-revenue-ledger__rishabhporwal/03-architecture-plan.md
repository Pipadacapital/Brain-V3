# Architecture Plan — feat-realized-revenue-ledger

**Stage:** 2 (architecture, binding) · **Decision:** ADVANCE · **Date:** 2026-06-16
**Architect:** architect · **req_id:** `feat-realized-revenue-ledger`
**Branch:** `feat/realized-revenue-ledger` (base `master`)
**Run:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`

> The MONEY substrate. Append-only-by-GRANT (not convention), a no-double-count NAMED function, dual-date immutability, and no-float BIGINT are the four load-bearing walls. Everything else serves them.

---

## 0. Cost-routing paradigm (the gate)

**Tier-0 deterministic — zero model calls — $0/mo, 0 tokens/day.**

Every operation is a DB transaction, a CHECK/UNIQUE constraint, a SQL aggregate inside a named function, or a deterministic time-horizon comparison in the finalization job. There is no classification, no ranking, no natural-language step anywhere in the ledger. A model call on this surface = paradigm-bypass and must be blocked at review. Justification: recognition is a pure rule (`occurred_at + horizon_days < now AND no RTO/cancel → finalization`); the as-of read is a pure signed SUM; reversals are signed inserts. Confirmed by CTO review §Cost-Routing.

**Spend estimate:** $0/mo. **Token estimate:** 0/day. **Compute:** one Argo-job run/day (finalization sweep) + O(rows-per-brand) inserts on ingest — bounded by Bronze order volume; no new infra.

---

## 1. Single-Primitive sweep (extend before create)

| Concern | Decision | Evidence |
|---|---|---|
| **The ledger** | ONE `realized_revenue_ledger`, event_type discriminator — NOT per-type tables | doc-08 §7.1 (`08_Brain_Data_Model_and_Database_Schema.md:336`), §0.4 #1 (`:46`). Per-type tables re-introduce the cross-table double-count bug. CLEAN. |
| **Money arithmetic** | Reuse `packages/money` as-is — `money()/add()/subtract()/multiply()/compare()` | `packages/money/src/index.ts:55-100`. No package API change (CTO §"No New Deployable":124). Banker's-rounding helper is the ONLY addition — see D-7. |
| **No-float enforcement** | Reuse existing `no-float-money` ESLint rule for `.ts`; add a DDL-level CHECK for SQL (lint covers TS only) | `tools/eslint-rules/no-float-money.mjs:15-18`; wired `error` in `eslint.config.mjs:112`. SQL gap = M-2; closed in §3.7. |
| **RLS / tenant isolation** | Copy the exact 0017 template (ENABLE+FORCE, two-arg `current_setting`, REVOKE+minimal GRANT, NN-1 DO-block) | `db/migrations/0017_identity_graph.sql:46-53,88-96,279-314`; `0016_bronze_events.sql:43-58` (append-only-by-grant INSERT+SELECT). CLEAN extend. |
| **Recognition writer** | NEW bounded context in the EXISTING `core` monolith module `measurement` (currently `export {}`) | `apps/core/src/modules/measurement/index.ts:7`. No new deployable. |
| **Finalization job** | EXISTING Argo-job type — sibling of `phone-guard-reeval.ts` in `apps/stream-worker/src/jobs/` | `apps/stream-worker/src/jobs/phone-guard-reeval.ts`; STACK ADR-010 (`STACK.md:26` — Argo Workflows for scheduled jobs). No new deployable. |
| **brand config columns** | EXTEND `brand` table (`ALTER ADD COLUMN IF NOT EXISTS`) — same pattern 0017 used for salt/threshold | `db/migrations/0004_brand.sql:17-28`; `0017:27-29`. |

**Verdict: CLEAN — extend-only.** ONE ledger, ONE money library, ONE RLS pattern, ONE named as-of function. No new service, no new table family, no new queue, no new deployable.

---

## 2. Architecture decisions — ALL bindings D-1..D-7 RESOLVED

### D-2 — Closed-period immutability boundary (CRITICAL) — BOUND

- `billing_posted_period CHAR(7)` in `YYYY-MM` format (e.g. `'2026-06'`). **NOTE — Canon reconciliation:** doc-08 §7.1 (`:344`) loosely types this `date`; the operational binding is `CHAR(7)` (the *period*, not a day) per CTO D-2 (`02-cto-advisor-review.md:99`). The `CHAR(7)` form is the correct operational substrate (a period is a month, not an instant). This is a tightening, not a contradiction — recorded in the journal; no Canon amendment needed (doc-08 is descriptive of the rule, not the storage type).
- **"Closed" definition:** a period `(brand_id, period)` is *closed* iff a `billing_run` row exists for it. **`billing_run` does not exist in M1** (the billing meter is an explicit non-goal — `01-requirement.md:57`). Therefore **in M1 ALL periods are open.** No closure can occur. We do NOT create `billing_run` in this slice (smallest/safest — no speculative table).
- **Immutability is STRUCTURAL, not procedural:** `brain_app` is granted `SELECT, INSERT` ONLY — **NO UPDATE, NO DELETE** (`REVOKE ALL ... GRANT SELECT, INSERT`). A written row can never be edited or deleted by the app role, regardless of period state. This is the same append-only-by-grant guarantee as `bronze_events` (`0016:55-56`). A migration-time assertion (§3.5) proves the grant.
- **Dual-date operational consequence:** the writer sets `billing_posted_period` from the **event's own `occurred_at`** (`to_char(occurred_at,'YYYY-MM')`), NOT the original sale's period. A late reversal in July for a June sale posts `billing_posted_period='2026-07'` with `economic_effective_at=<reversal time>` — June's rows are never touched. When `billing_run` ships (later slice) the writer will read the current open period instead of raw `occurred_at`; the column + the grant are forward-compatible, so that is an additive change. M1 binds `occurred_at`-derived period.

### D-4 — Replay-idempotency dedup key (CRITICAL) — BOUND

- **Ledger-event identity (PK):** `ledger_event_id TEXT` = deterministic `sha256(brand_id ‖ order_id ‖ event_type ‖ source_pk ‖ version)` per doc-08 §7.1 (`:337`). PK = `(brand_id, ledger_event_id)`. This makes Bronze replay idempotent at the row-identity level.
- **Dedup UNIQUE (the D-4 binding):** `UNIQUE (brand_id, order_id, event_type, (occurred_at::date))`. Rationale (CTO D-4 `:105`): `occurred_at::date` distinguishes a *legitimate* second `finalization` (split shipment, different day → allowed) from a *replay* of the same-day event (suppressed). A pure `(brand_id, order_id, event_type)` would wrongly collapse legit split-shipment double-finalization; adding `occurred_at::date` admits the legit case while still killing same-day replays.
- **Writer behavior:** `INSERT ... ON CONFLICT (brand_id, order_id, event_type, (occurred_at::date)) DO NOTHING`. On a suppressed conflict, increment a `ledger_replay_suppressed_total{brand_id,event_type}` counter (Tier-0 metric; reuses the observability spine). Test: re-emit the same Bronze batch → ledger `COUNT(*)` unchanged AND the suppression counter increments by the replay count.
- A second UNIQUE on the PK (`brand_id, ledger_event_id`) is implicit via the PK and gives the deterministic-id idempotency backstop; the column UNIQUE above is the business-key guard.

### D-3 — No-double-count as-of read = NAMED Postgres function — BOUND

- **`realized_gmv_as_of(p_brand_id UUID, p_as_of DATE) RETURNS BIGINT`** — a `SECURITY INVOKER`, `STABLE`, `LANGUAGE sql` function. It is the **sole** as-of read path; ad-hoc `SUM(amount_minor)` in app/SQL is forbidden (block at review).
- **Recognition filter baked in (the no-double-count heart):** the body sums `amount_minor` WHERE `brand_id = p_brand_id AND economic_effective_at::date <= p_as_of AND event_type <> 'provisional_recognition'`. It **excludes `provisional_recognition`** so a coexisting provisional + finalization row for the same order is never double-counted. The signed-sum then nets finalization (+) against reversals (−).
- **event_type → realized contribution map (exact):**

  | event_type | sign of `amount_minor` | counts toward realized GMV? |
  |---|---|---|
  | `provisional_recognition` | + | **NO** — excluded by the function filter (not yet realized) |
  | `finalization` | + | YES (+) |
  | `rto_reversal` | − | YES (−) |
  | `refund` | − | YES (−) |
  | `chargeback` | − | YES (−) |
  | `cancellation` | − | YES (−) |
  | `settlement_fee_reversal` | − | YES (−) |
  | `marketplace_adjustment` | ± | YES (signed as written) |
  | `payment_adjustment` | ± | YES (signed as written) |
  | `concession` | − | YES (−) |

  Equivalent to: realized = `Σ(finalization) − Σ(reversals)` = signed sum over all event_types except `provisional_recognition`. This matches doc-08 §7.3 closed-sum (`:379`) and METRICS.md `recognition_label='finalized'`. The function is `SECURITY INVOKER` so it executes under the caller's RLS context — cross-brand reads remain 0 under `brain_app`.

### D-1 — COD/prepaid recognition horizon — BOUND

- Add two `brand` columns: `cod_recognition_horizon_days INT NOT NULL DEFAULT 25`, `prepaid_recognition_horizon_days INT NOT NULL DEFAULT 7` (additive, defaults backfill existing rows — same as 0017 salt/threshold pattern). Brand-configurable by UPDATE; no per-payment-method config in M1; no P80 cold-start benchmark (defaults apply until overridden — CTO D-1 `:96`).
- **Finalization job semantics (resolves M-3 race):** the job selects provisionals whose `occurred_at + horizon_days < now()` and emits a `finalization` event ONLY if there is **no existing `rto_reversal`/`cancellation` row for that `(brand_id, order_id)`** AND **no existing `finalization` row already**. The horizon is chosen per row by payment method (COD → `cod_recognition_horizon_days`, prepaid → `prepaid_recognition_horizon_days`; payment method read from the provisional's source payload/Silver). Even if a same-window race emits both finalization and reversal, the signed-sum property nets to the correct realized value (finalization + reversal = 0) and the dedup UNIQUE prevents a double finalization. The RTO-existence pre-check makes the common path correct; the signed-sum is the safety net.
- FX-rate pinning is at recognition event time, not finalization time (CTO D-1) — but M1 is single-currency so `fx_rate_id` is **NULL** (no `fx_rate` table exists in the repo; do NOT create one). `fx_rate_id UUID NULL` column present for forward-compat, no FK.

### D-6 — Single-currency-per-brand guard — BOUND (BEFORE INSERT trigger)

- Add `currency_code CHAR(3) NOT NULL DEFAULT 'INR'` to `brand` (additive). The ledger row carries its own `currency_code CHAR(3) NOT NULL` (doc-08 §7.1).
- **Enforcement = a BEFORE INSERT trigger** (not an app-only guard — chosen because the ledger is a high-stakes SoR and an app-only guard can be bypassed by any future writer; structural > procedural, consistent with the immutability-by-grant philosophy): `ledger_currency_matches_brand()` raises EXCEPTION if `NEW.currency_code <> (SELECT currency_code FROM brand WHERE id = NEW.brand_id)`. This prevents silent heterogeneous-currency sums that would make `realized_gmv_as_of` wrong (CTO M-1 `:75`, D-6 `:111`). The TS-side `assertSameCurrency` (`packages/money:102`) covers the arithmetic path; the trigger covers the raw-SQL path. Both required. The trigger reads `brand` under RLS (same brand context), so it is tenant-safe.

### D-7 — Rounding / allocation — BOUND (banker's rounding + adjustment column)

- All money math via `packages/money` (integer minor units only). **No division of `amount_minor` in M1** — there is no per-channel allocation in this slice (that is `attribution_credit_ledger`, a non-goal). So the common path never rounds.
- For the rare fractional-minor case (a settlement/marketplace fee expressed with sub-minor precision upstream), apply **banker's rounding (round-half-to-even)** and write the delta to a new `rounding_adjustment_minor BIGINT NOT NULL DEFAULT 0` column on the ledger row — never silent truncation (CTO D-7 `:114`).
- **New helper in `packages/money`** (the only package addition): `roundToMinorBankers(value: bigint, scale: bigint): { minor: bigint; adjustment_minor: bigint }` (round-half-to-even). `packages/money` currently has NO `divide`/`round` (verified `index.ts` — grep clean), so this is a genuine, minimal extension, not a duplicate. Lint-clean (operates on `bigint`).

### D-5 — Reconciliation tolerance — NOT the Architect's binding (deferred to Data Engineer Sprint-0)

Per CTO D-5 (`:108`): the reconciliation tolerance value (±2–3% by W4, >±5% stop-and-fix) is a **Data-Engineer Sprint-0 freeze**, not an Architect binding, and does NOT block this design. The reconciliation test against external Shopify data is not in this slice (no live Shopify — `01-requirement.md:72`). The closed-sum / no-double-count tests (Slice 4) use exact integer equality (no tolerance). Flagged in the HANDOFF for the Data Engineer to freeze before any external-reconciliation integration test.

### no-float in SQL — BOUND (M-2 closed)

The `no-float-money` lint covers `.ts` ONLY (`eslint.config.mjs:112`). For the migration: **every money column is `BIGINT`** (`amount_minor`, `rounding_adjustment_minor`) — NEVER `NUMERIC`/`REAL`/`DOUBLE PRECISION`. A migration-time DO-block assertion (§3.5) inspects `information_schema.columns` and RAISEs if any `*_minor` column on the ledger is not `bigint`. This is the SQL-side equivalent of the lint and is a REQUIRED pass-1 acceptance item.

---

## 3. The migration — `0018_realized_revenue_ledger.sql`

Additive only (I-E02). Down = `DROP TABLE IF EXISTS realized_revenue_ledger; DROP FUNCTION IF EXISTS realized_gmv_as_of; DROP FUNCTION IF EXISTS ledger_currency_matches_brand; ALTER TABLE brand DROP COLUMN IF EXISTS ...` (ledger is rebuildable from Bronze in M1 → DROP is clean; it is NOT yet the Iceberg immutable SoR — same reasoning as `0016:21`). Next free int after `0017` = `0018`; renumber on collision.

### 3.1 brand column adds (D-1, D-6) — `ALTER ADD COLUMN IF NOT EXISTS`
```
cod_recognition_horizon_days     INT      NOT NULL DEFAULT 25
prepaid_recognition_horizon_days INT      NOT NULL DEFAULT 7
currency_code                    CHAR(3)  NOT NULL DEFAULT 'INR'
```

### 3.2 `realized_revenue_ledger` table (doc-08 §7.1 — exact columns)
```
brand_id                    UUID    NOT NULL                 -- tenant key / RLS anchor (I-S01)
ledger_event_id             TEXT    NOT NULL                 -- deterministic sha256(...) — idempotent id
order_id                    TEXT    NOT NULL
brain_id                    UUID    NULL                     -- identity ref; never PII (references customer brain_id)
event_type                  TEXT    NOT NULL CHECK (event_type IN
                              ('provisional_recognition','finalization','rto_reversal','refund',
                               'chargeback','cancellation','settlement_fee_reversal',
                               'marketplace_adjustment','payment_adjustment','concession'))
amount_minor                BIGINT  NOT NULL                 -- SIGNED; reversals negative; NEVER NUMERIC/float (I-S07)
currency_code               CHAR(3) NOT NULL                 -- paired with amount_minor ALWAYS
fx_rate_id                  UUID    NULL                     -- M1 single-currency → always NULL; no FK (no fx_rate table)
rounding_adjustment_minor   BIGINT  NOT NULL DEFAULT 0       -- D-7 banker's-rounding delta; BIGINT (I-S07)
occurred_at                 TIMESTAMPTZ NOT NULL             -- event-time (dual-date #1)
economic_effective_at       TIMESTAMPTZ NOT NULL             -- economic-time; drives as-of math (dual-date #2)
billing_posted_period       CHAR(7) NOT NULL                 -- 'YYYY-MM' open period (D-2); closed periods immutable
recognition_label           TEXT    NOT NULL CHECK (recognition_label IN ('provisional','settling','finalized'))
supersedes_ledger_event_id  TEXT    NULL
settlement_source           TEXT    NULL
maturity_state              TEXT    NULL
ledger_snapshot_id          TEXT    NULL
raw_event_id                TEXT    NULL                     -- Bronze event_id provenance
created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
PRIMARY KEY (brand_id, ledger_event_id)                      -- tenant-first; deterministic-id idempotency backstop
```
- **Dedup UNIQUE (D-4):** `CREATE UNIQUE INDEX realized_revenue_ledger_dedup ON realized_revenue_ledger (brand_id, order_id, event_type, (occurred_at::date));`
- **As-of scan index:** `CREATE INDEX idx_rrl_asof ON realized_revenue_ledger (brand_id, economic_effective_at) WHERE event_type <> 'provisional_recognition';` (partial — serves the named function).
- **CHECK billing_posted_period format:** `CHECK (billing_posted_period ~ '^\d{4}-\d{2}$')`.

### 3.3 RLS (copy 0017 template exactly)
```
ALTER TABLE realized_revenue_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE realized_revenue_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY realized_revenue_ledger_isolation ON realized_revenue_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON realized_revenue_ledger FROM brain_app;
GRANT SELECT, INSERT ON realized_revenue_ledger TO brain_app;   -- APPEND-ONLY BY GRANT: no UPDATE/DELETE (D-2)
```

### 3.4 BEFORE INSERT currency trigger (D-6)
```
CREATE FUNCTION ledger_currency_matches_brand() RETURNS trigger AS $$
BEGIN
  IF NEW.currency_code <> (SELECT currency_code FROM brand WHERE id = NEW.brand_id) THEN
    RAISE EXCEPTION 'currency mismatch: ledger row % vs brand currency for brand %',
      NEW.currency_code, NEW.brand_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ledger_currency BEFORE INSERT ON realized_revenue_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_currency_matches_brand();
```

### 3.5 Migration-time assertions (copy 0017 NN-1 DO-block + two new)
1. **NN-1 two-arg** — copy the exact DO-block from `0017:279-314` / `0004:61-88` (fail if any policy uses one-arg `current_setting`).
2. **Append-only grant assertion (D-2/H-4):** a DO-block querying `information_schema.role_table_grants` that RAISEs if `brain_app` holds `UPDATE` or `DELETE` on `realized_revenue_ledger`.
3. **No-float-SQL assertion (M-2):** a DO-block querying `information_schema.columns` that RAISEs if any column matching `%_minor` on `realized_revenue_ledger` has `data_type <> 'bigint'`.

### 3.6 `realized_gmv_as_of` function (D-3)
```
CREATE OR REPLACE FUNCTION realized_gmv_as_of(p_brand_id UUID, p_as_of DATE)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(SUM(amount_minor), 0)::BIGINT
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND economic_effective_at::date <= p_as_of
    AND event_type <> 'provisional_recognition';   -- no-double-count: excludes provisionals
$$;
```

### 3.7 SQL no-float gate
All `*_minor` columns are `BIGINT` (verified in 3.2). The §3.5(3) assertion enforces it at migration time; the DDL is also a REQUIRED grep-review item (`grep -i 'numeric\|real\|double\|float' 0018_*.sql` must return zero money-column hits).

---

## 4. Recognition engine — `apps/core/src/modules/measurement/internal/`

DDD bounded context inside the existing `core` monolith (no new deployable). `measurement/index.ts` exposes only the public use-cases; all impl is private under `internal/` (boundary lint already wired — `measurement/index.ts:5`).

```
measurement/
  index.ts                          # public surface: RecognizeOrderUseCase, ReverseUseCase, GetRealizedGmvAsOfQuery
  internal/
    domain/recognition/
      entities/LedgerEntry.ts        # value object; amount via @brain/money Money (never raw number)
      value-objects/RecognitionEvent.ts
      services/LedgerEventId.ts       # deterministic sha256(brand_id‖order_id‖event_type‖source_pk‖version) — reuse node:crypto (same as identity-core)
      policies/RecognitionPolicy.ts   # order event → provisional_recognition; reversal type → signed event; pure, no I/O
      policies/RoundingPolicy.ts      # banker's rounding via @brain/money.roundToMinorBankers
    application/
      commands/RecognizeOrder.ts      # CQRS write: emits provisional_recognition row
      commands/PostReversal.ts        # emits signed rto_reversal/refund/... row to CURRENT period
      queries/GetRealizedGmvAsOf.ts   # calls realized_gmv_as_of(); NO ad-hoc SUM
    infrastructure/
      repositories/PgLedgerRepository.ts   # copy BronzeRepository pattern: set_config-then-INSERT-one-txn under brain_app; ON CONFLICT DO NOTHING + replay-suppression metric
    interfaces/
      consumers/OrderEventConsumer.ts # Bronze order event → RecognizeOrder command (idempotent; offset-after-write)
```

- **Money is ALWAYS `@brain/money` Money** — never raw `number`/`bigint` arithmetic in domain (DDD invariant). `amount_minor` enters/leaves as `bigint`.
- **Idempotency:** writer uses the deterministic `ledger_event_id` PK + dedup UNIQUE; `ON CONFLICT DO NOTHING`; re-run safe.
- **billing_posted_period:** set by the writer = `to_char(occurred_at, 'YYYY-MM')` (D-2 M1 binding).
- **`recognition_label`:** `provisional_recognition`→`'provisional'`; `finalization`→`'finalized'`; reversals→`'finalized'` (they restate finalized truth). `'settling'` reserved (settlement connector is a later slice).

---

## 5. Finalization job — `apps/stream-worker/src/jobs/revenue-finalization.ts`

EXISTING Argo-job type (sibling of `phone-guard-reeval.ts`). No new deployable, no new Argo-job *type* (STACK ADR-010 `STACK.md:26`).

- Per brand: select `provisional_recognition` rows where `occurred_at + (horizon_days || ' days')::interval < now()` (horizon chosen by payment method: COD→`cod_recognition_horizon_days`, prepaid→`prepaid_recognition_horizon_days` from `brand`), with **no existing `rto_reversal`/`cancellation`** for `(brand_id, order_id)` AND **no existing `finalization`**.
- Emits a `finalization` event per qualifying order → goes through the same `PostFinalization` write path (idempotent; dedup UNIQUE). Runs under `brain_app` with the per-brand GUC set (loops brands like `phone-guard-reeval`).
- Race safety (M-3): RTO pre-check + signed-sum net + dedup UNIQUE — three independent guards.

---

## 6. Test strategy (Slice 4) — all under `SET ROLE brain_app` (dev superuser `brain` MASKS RLS — MEMORY `dev-db-superuser-masks-rls.md`)

Live Postgres tests use the **non-superuser app role** pattern from `tools/isolation-fuzz/src/pg.test.ts:1-90` (superuser does DDL/seed; a `NOSUPERUSER NOBYPASSRLS` role runs assertions). Required cases:

1. **closed-sum / no-double-count (golden fixture):** provisional + finalization + reversal for an order → `realized_gmv_as_of` nets to the expected BIGINT; provisionals NOT counted; a naive `SUM(amount_minor)` (incl. provisional) is asserted to be *wrong* (proves the function is load-bearing).
2. **refund/RTO clawback:** a negative reversal row is written; the original sale/finalization row is byte-identical (untouched) — proves append-only.
3. **dual-date immutability:** a late (next-month) reversal posts `billing_posted_period = current month`, `economic_effective_at = reversal time`; the prior period's rows are unchanged; an attempted `UPDATE`/`DELETE` under `brain_app` raises a permission error (proves immutability-by-grant).
4. **no-float-money lint:** the lint fires on a float fixture (`amount_minor: number = 9.99` style) — reuse `tools/eslint-rules/fixtures/bad-float-money.ts` pattern; PLUS the migration `_minor`-is-BIGINT DO-block assertion runs green.
5. **single-currency guard:** inserting a row whose `currency_code` ≠ brand currency raises the trigger EXCEPTION.
6. **isolation negative-control:** under brand-A GUC, brand-B ledger rows = 0; with no GUC, 0 rows (two-arg fail-closed); removal-proof documented (mirror `pg.test.ts`).
7. **replay-idempotency (dedup):** re-emit the same Bronze batch → ledger `COUNT(*)` unchanged; `ledger_replay_suppressed_total` increments by the replay count.
8. **banker's-rounding:** `roundToMinorBankers` half-to-even unit tests (0.5→0, 1.5→2, etc.); the `rounding_adjustment_minor` delta is recorded, never truncated silently.
9. **horizon finalization:** a provisional past its horizon with no RTO → finalizes; one with an RTO → does NOT finalize (the job's pre-check); a prepaid uses 7d, COD uses 25d.

---

## 7. Slices (smallest-first, COMMIT PER SLICE — prior builders died on infra timeouts)

| Slice | Scope | Commit |
|---|---|---|
| **Slice 1** | Migration `0018` (brand cols + ledger table + RLS + dedup UNIQUE + dual-date cols + currency trigger + 3 assertions) + `realized_gmv_as_of` function | `feat: 0018 realized_revenue_ledger migration + as-of fn` |
| **Slice 2** | Recognition engine in `measurement` (order event → provisional; reversal → signed; idempotent writer; `@brain/money` only; `roundToMinorBankers` helper in `packages/money`) | `feat: recognition engine (provisional + signed reversals)` |
| **Slice 3** | Finalization job (`revenue-finalization.ts`) + reversal command paths (RTO/refund/chargeback/cancellation) + replay-suppression metric | `feat: horizon finalization job + reversal paths` |
| **Slice 4** | Full test suite (§6, all 9 cases) under `SET ROLE brain_app` | `test: closed-sum, immutability, isolation, dedup, rounding, horizon` |
| **DEPLOY** | Affected-only build of `core` + `stream-worker` images; existing ArgoCD apps (`infra/argocd/envs/{staging,prod}/core.yaml`, `stream-worker.yaml`) sync; health-probe auto-rollback (ArgoCD+Helm). **NO canary** — per-brand canary is Phase-4-deferred (STACK ADR-010 `STACK.md:26`); honoring the locked stack, not deviating. Register the Argo job manifest for `revenue-finalization` (existing job type). | `chore: deploy core+stream-worker (affected-only) + finalization job manifest` |

Folded into the DEPLOY slice, not a follow-up. Deploy-all is forbidden — affected-only.

---

## 8. Acceptance contract (REQUIRED pass-1 — every CTO must-fix folded in)

The builder MUST satisfy ALL of these on pass 1 (kills the rework bounce):

- [ ] **D-2 (CRITICAL):** `billing_posted_period CHAR(7)`; `brain_app` has SELECT+INSERT only (NO UPDATE/DELETE) — proven by the §3.5(2) grant assertion; writer sets period from `occurred_at`; no `billing_run` table created.
- [ ] **D-4 (CRITICAL):** UNIQUE `(brand_id, order_id, event_type, (occurred_at::date))`; `ON CONFLICT DO NOTHING` + replay-suppression metric.
- [ ] **D-3 (H-1):** `realized_gmv_as_of(brand_id, as_of)` named function with `event_type <> 'provisional_recognition'` filter baked in; NO ad-hoc SUM in app code.
- [ ] **D-1:** `cod_recognition_horizon_days` DEFAULT 25, `prepaid_recognition_horizon_days` DEFAULT 7 on `brand`; finalization job reads them; RTO pre-check before emit (M-3).
- [ ] **D-6 (M-1):** `brand.currency_code CHAR(3)`; BEFORE INSERT trigger rejects mismatched currency.
- [ ] **D-7:** banker's rounding via `roundToMinorBankers`; `rounding_adjustment_minor BIGINT` column; no silent truncation; no `amount_minor` division in M1.
- [ ] **no-float-SQL (M-2):** `amount_minor` + `rounding_adjustment_minor` are `BIGINT`; §3.5(3) DO-block assertion green; grep-clean for NUMERIC/float on money columns.
- [ ] **H-4:** migration-time NN-1 two-arg assertion (copied from 0017) + grant assertion both green.
- [ ] All `.ts` money is `@brain/money` Money / `bigint` — `no-float-money` lint green.
- [ ] All RLS tests run under a NON-superuser app role (dev `brain` masks RLS).
- [ ] Additive migration (I-E02); down = DROP; branch `feat/realized-revenue-ledger` off `master`; COMMIT PER SLICE.

---

## 9. Alternatives considered + rejected

1. **Per-event-type tables** (separate `refund`, `chargeback`, … tables). **Rejected:** re-introduces cross-table reconciliation and the double-count bug; doc-08 §0.4 #1 mandates one ledger. One ledger = one as-of truth.
2. **App-layer-only immutability + currency guard** (no grant restriction, no trigger). **Rejected:** a high-stakes SoR must be structurally immutable; any future writer could bypass an app guard. Grant-level append-only + BEFORE INSERT trigger are tamper-proof.
3. **Ad-hoc `SUM(amount_minor)` in the metric engine** instead of a named function. **Rejected (H-1):** one missing `recognition_label`/event_type filter = double the GMV on a stakeholder dashboard. The named function makes the filter unbypassable.
4. **Create `billing_run` + `fx_rate` now** for forward-compat. **Rejected:** speculative tables; billing meter + FX are explicit non-goals (`01-requirement.md:57-59`). Smallest/safest = don't build them; the `billing_posted_period`/`fx_rate_id` columns are the only forward-compat seam needed and they are additive-safe.
5. **`billing_posted_period DATE`** (per doc-08 §7.1 literal type). **Rejected:** a period is a month, not an instant; `CHAR(7)` 'YYYY-MM' is the correct operational substrate (CTO D-2). Tightening, journaled.

---

## 10. Over-engineering self-check — PASS

- No new service, table family, queue, deployable, Argo-job type, ADR, or store. ONE ledger, ONE money lib (+1 minimal helper), ONE RLS pattern, ONE named function, ONE trigger.
- `billing_run`/`fx_rate` NOT built (non-goals). No allocation/division in M1. No P80 cold-start. No canary (Phase-4 deferred). No `merge_rule`-style speculative config.
- Every column in the table is from doc-08 §7.1 — nothing invented beyond `rounding_adjustment_minor` (D-7-mandated) and the horizon/currency brand columns (D-1/D-6-mandated). PASS.

## 11. ADR check

**No new ADR.** Within ADR-001 (RLS), ADR-010 (deploy — honors the Phase-4 canary deferral), ADR-007 (no new secrets), the money invariant I-S07, I-E02 (additive). `0018` is the first ledger migration (none 0001–0017); additive; no stack layer change. Recorded in journal.

---

## 12. Tracks

| Track | Role | Scope |
|---|---|---|
| **Slices 1–4 + DEPLOY** | **@data-engineer** (single track) | Migration `0018`, recognition engine, finalization job, full test suite, affected-only deploy. The gold ledger is the data plane's. |
| metric-parity seam | **@intelligence-engineer** | **NONE — single track.** The metric engine + parity oracle that READ this ledger are the explicit NEXT slice (`01-requirement.md:55`); no metric-engine code is written here, so no parity seam warrants an intelligence-engineer track now. The named `realized_gmv_as_of` function IS the clean read seam the next slice consumes. |

---

## HANDOFF
```
HANDOFF
stage: 2 (architecture)
decision: ADVANCE
branch: feat/realized-revenue-ledger (base master)
bindings_resolved: [D-1, D-2, D-3, D-4, D-6, D-7, no-float-SQL, named-as-of-fn, dedup, immutability-by-grant]  (D-5 = Data-Engineer Sprint-0, non-blocking)
immutability_boundary: brain_app gets SELECT+INSERT only (NO UPDATE/DELETE grant) — structural append-only; M1 has no billing_run table so all periods are open; a late reversal posts a NEW row with billing_posted_period = to_char(occurred_at,'YYYY-MM') (current period), never the original sale's period; proven by a migration-time grant assertion
dedup_key: UNIQUE (brand_id, order_id, event_type, (occurred_at::date)) + PK (brand_id, ledger_event_id); ON CONFLICT DO NOTHING + ledger_replay_suppressed_total metric
as_of_read: realized_gmv_as_of(p_brand_id UUID, p_as_of DATE) RETURNS BIGINT — STABLE SECURITY INVOKER sql; SUM(amount_minor) WHERE economic_effective_at::date <= p_as_of AND event_type <> 'provisional_recognition'; map = finalization(+), rto_reversal/refund/chargeback/cancellation/concession(−), settlement_fee_reversal(−), marketplace_adjustment/payment_adjustment(±), provisional_recognition(EXCLUDED)
migration: 0018_realized_revenue_ledger.sql (+ brand cols: cod_recognition_horizon_days INT DEFAULT 25, prepaid_recognition_horizon_days INT DEFAULT 7, currency_code CHAR(3) DEFAULT 'INR'); ledger table per doc-08 §7.1 (amount_minor + rounding_adjustment_minor BIGINT, dual-date occurred_at/economic_effective_at/billing_posted_period CHAR(7)); RLS FORCE two-arg fail-closed; SELECT+INSERT grant; dedup UNIQUE; BEFORE INSERT currency trigger; realized_gmv_as_of fn; 3 migration-time assertions (NN-1 two-arg, append-only-grant, _minor-is-BIGINT); additive, down = DROP
slices: [S1: migration 0018 + brand cols + realized_gmv_as_of fn, S2: recognition engine (provisional + signed reversals + roundToMinorBankers helper), S3: horizon finalization job + reversal paths + replay metric, S4: tests (closed-sum/no-double-count, RTO clawback, dual-date immutability, no-float lint+DDL, single-currency, isolation negative-control, replay-dedup, banker's rounding, horizon), DEPLOY: affected-only core+stream-worker images + ArgoCD sync + finalization job manifest, NO canary]
tracks: { data-engineer: "migration 0018 + recognition engine + finalization job + full test suite + affected-only deploy (whole feature)", intelligence-engineer: "none — single track; metric engine + parity oracle that read this ledger are the NEXT slice; realized_gmv_as_of is the clean read seam" }
intended_state: { stage: 3, status: "build", owner: "data-engineer", note: "money substrate; COMMIT PER SLICE; immutability-by-grant + no-double-count named fn + dual-date + no-float BIGINT are the four load-bearing walls; all RLS tests under non-superuser brain_app (dev brain masks RLS)" }
notes: append-only is by GRANT not convention (SELECT+INSERT only, proven by migration assertion) · realized_gmv_as_of is the SOLE as-of path (no ad-hoc SUM) · dual-date: late reversal → new current-period row, closed period untouched · all money columns BIGINT (no-float lint covers .ts ONLY → DDL assertion closes the SQL gap) · single-currency enforced by BEFORE INSERT trigger (structural, not app-only) · do NOT create billing_run or fx_rate (non-goals; fx_rate_id always NULL in M1) · D-5 reconciliation tolerance is Data-Engineer Sprint-0, freeze before any external-reconciliation test · no new ADR (within ADR-001/007/010, I-S07, I-E02)
```
