# Requirement: Realized-revenue ledger (append-only, dual-date, COD-aware)

| Field | Value |
|-------|-------|
| **req_id** | `feat-realized-revenue-ledger` |
| **Title** | Realized-revenue ledger — append-only recognition/finalization/reversal with the dual-date rule |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T18:55:24Z |
| **Tier impact** | M1 data-plane critical path (identity → **ledger** → metric engine) |
| **Region impact** | India (COD recognition horizon) |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: money, multi_tenancy)*

---

## Raw text (from the Stakeholder)

> Build the **realized-revenue ledger** — the money substrate, next after the identity graph (`feat-identity-graph`, shipped). Turn identity-attributed order events into finalized, brand-scoped realized GMV. Wire the EXISTING scaffolds: `apps/core/src/modules/measurement`, `packages/money`. Per doc-08 §7 + the dual-date rule.
>
> DELIVER:
> 1. **One append-only `realized_revenue_ledger`** (event_type discriminator, NOT per-type tables): `provisional_recognition` (order placed) → `finalization` (delivered / COD horizon reached) → reversals: `rto_reversal`, `refund`, `chargeback`, `cancellation`, `settlement_fee_reversal`, `marketplace_adjustment`, `payment_adjustment`, `concession`. `amount_minor BIGINT` **signed** (reversals negative); the original sale row is NEVER edited — every economic change is a NEW row.
> 2. **Money discipline (the invariant):** `amount_minor BIGINT` + `currency_code CHAR(3)` ALWAYS paired; **NO floats for money, ever** (lint-enforced via `no-float-money`); all math through `packages/money`.
> 3. **Dual-date rule:** every row carries `occurred_at` (event-time) + `economic_effective_at` + `billing_posted_period`. Closed billing periods are IMMUTABLE — a late reversal restates *economic* truth (new row, current period) but NEVER rewrites a closed period.
> 4. **COD recognition horizon:** provisional → finalization at a configurable horizon (default ~25d COD / ~7d prepaid, brand-configurable); a finalization job emits the finalization event when the horizon passes without RTO/cancel.
> 5. **Per-brand isolation (the ONE invariant):** ledger is brand-scoped; RLS FORCE fail-closed; references customers by `brain_id` (identity), never PII; cross-brand read = 0 under `SET ROLE brain_app`.
> 6. **As-of realized-GMV read** — a function that returns realized GMV for a brand as-of a date = the signed sum of the ledger up to that point (the closed-sum property). Append-only + replayable + rebuildable.
> 7. **Automated tests:** closed-sum (provisional + finalization + reversal nets to the correct realized GMV); refund/RTO clawback (negative row, sale row untouched); dual-date (a late reversal does NOT mutate a closed period; restates current); no-float-money lint fires on a float fixture; isolation negative-control under `SET ROLE brain_app`; replay-idempotency; currency always paired; horizon finalization (a provisional past the horizon finalizes; one with an RTO does not).

---

## Problem statement

Identity gives us `brain_id`; Bronze gives us order events. But there is no *money* truth — no recognized/realized revenue. The realized-revenue ledger is the single append-only source of as-of economic truth (the layer the metric engine and the billing meter both read). Without it there is no reconciling number. India COD makes this non-trivial: revenue is provisional until delivery (RTO reverses it), so recognition must be horizon-based and reversible — while closed billing periods stay immutable.

## Target user

Internal/platform (the money substrate every revenue metric + the billing meter read). India DTC brand, M1.

## Success metric

For a brand, realized GMV as-of any date = the signed sum of the ledger and reconciles to the expected value on golden fixtures (provisional→finalize→reverse nets correctly); a late reversal restates economic truth without mutating a closed period; no float ever touches money; cross-brand read = 0 under `brain_app`; the ledger is append-only + replayable. All proven by automated tests.

## Constraints

- **Money invariant:** integer minor units + `currency_code`, always paired; NO floats (lint-enforced); all math via `packages/money`. Rounding/allocation rules explicit.
- **Append-only** — never edit/delete a ledger row; reversals are new signed rows; closed periods immutable (dual-date).
- Absolute brand/tenant isolation (the ONE invariant); RLS FORCE fail-closed two-arg; verify under `SET ROLE brain_app` (dev superuser masks RLS). No PII (reference by `brain_id`).
- Hard rule: no NEW deployable — wire `apps/core/measurement` + `packages/money` + the finalization job as an existing Argo-job type.
- Migrations additive (I-E02). Single-currency-per-brand for M1 (cross-currency FX is later).

## Non-goals

- The **metric engine + parity oracle + Analytics API + dashboard** (the NEXT slice — that's what puts the reconciling number on screen and CI-gates it).
- `attribution_credit_ledger` / attribution clawback (separate ledger, later).
- The **billing meter** (gmv_meter_snapshot, tier%/cap/min-fee, invoices) — later.
- CM2 / margin waterfall / True CM2 (later).
- Cross-currency FX conversion (M1 single-currency-per-brand).
- Razorpay settlement ingestion (the settlement connector is a later slice; M1 finalization is horizon-based, not settlement-driven — settlement events can be added later as additional event_types).

## Linked prior runs

- feat-identity-graph (brain_id — the ledger references customers by it)
- feat-data-plane-ingest-spine (Bronze order events — the recognition source)

## Notes

- Spec: doc-08 §7.1 `realized_revenue_ledger` (event_type CHECK list above; `amount_minor` signed; `economic_effective_at` + `billing_posted_period` dual-date). doc-08 money rule: `*_minor BIGINT` + `currency_code` paired, no floats (lint `no-float-money`).
- **Architect must bind:** the COD/prepaid horizon defaults (~25d/7d) + how they're brand-configurable; the **reconciliation tolerance** (doc flags this as TODO-with-owner = Data Engineer); the closed-sum assertion; the rounding/allocation rule; what "closed period" means operationally (billing_posted_period boundary) and the immutability enforcement.
- Builder lesson: tight scopes + COMMIT PER SLICE (prior builders died on infra timeouts). Single-track data-engineer (the gold ledger is the data plane's); verify isolation under `SET ROLE brain_app`.
- Source of recognition events: the identity-attributed Bronze order events. For M1, synthetic/fixture orders are fine (no live Shopify; validate-sync parked).
