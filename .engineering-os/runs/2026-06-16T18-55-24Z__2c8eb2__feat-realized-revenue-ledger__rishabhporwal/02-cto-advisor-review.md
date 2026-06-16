# CTO Advisor Review — feat-realized-revenue-ledger
**Stage:** 1 (intake, compressed with adversarial stress-testing)
**Decision:** ADVANCE
**Date:** 2026-06-16T18:55:24Z
**Reviewer:** Engineering Advisor (cto-advisor)
**Run folder:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`

---

## Lane Confirmation

**Lane:** `high_stakes`
**Trigger surfaces (deterministic scan passed in; confirmed and one addition):**
- `money` — confirmed: `amount_minor BIGINT` + `currency_code CHAR(3)`, signed rows, the entire no-float discipline
- `multi_tenancy` — confirmed: per-brand RLS FORCE fail-closed, cross-brand read = 0 under `brain_app`
- `audit_trail` — ADDED: the realized-revenue ledger is the system-of-record financial truth and directly feeds the billing meter; it is a THE-MOAT.md named surface ("realized-revenue ledger schema or finalization logic"); every row is immutable once written, making it audit-trail equivalent in materiality even before the billing meter reads it

**Rationale for addition:** THE-MOAT.md §"How the OS protects it" explicitly names the realized-revenue ledger as escalation-eligible. COMPLIANCE.md Controls table confirms: no DELETE grant on `realized_revenue_ledger` for the app role (INSERT+SELECT only). This is a higher-stakes audit surface than a standard data table.

---

## Requirement Soundness Assessment

The requirement is well-formed. It has a clear problem statement (no money truth exists post-identity-graph), a concrete target user (internal data-plane), a verifiable success metric (signed sum reconciles golden fixtures; late reversal does not mutate closed period; cross-brand read = 0), and an explicit non-goals list. It is correctly scoped to the data-plane layer only — the metric engine, billing meter, and attribution ledger are explicitly deferred.

The "make it less dumb first" pass yields nothing to cut: the dual-date rule, COD horizon, and append-only model are the minimum necessary to produce correct India COD realized revenue. There is no gold-plating in the spec.

---

## Adversarial Stress Findings (severity-ranked)

### CRITICAL

**C-1: Closed-period immutability boundary is not operationally defined**
Severity: CRITICAL — the boundary between what is "closed" and what is "open" is the key invariant of the dual-date rule. The requirement states it (correctly) in policy terms but does not bind the operational definition. Concretely: what sets `billing_posted_period`? When does a period "close"? Is closure triggered by invoice generation, by a billing-run job, by a time-based gate, or by an explicit operator action? Without this definition, the immutability enforcement has no substrate to enforce against. A late reversal row landed after a period closes must target the *current* open period in `billing_posted_period` — but that requires knowing the current open period. The Architect must bind this.

**Cite:** `01-requirement.md` line 25 ("Closed billing periods are IMMUTABLE") + METRICS.md §Rules line 51 ("billing_posted_period determines which open billing period a late adjustment posts to; closed/invoiced periods are never edited") — neither defines the operational closure trigger.

**C-2: Idempotency dedup key not fully specified**
Severity: CRITICAL for replay-correctness. The requirement calls for "replay-idempotency" as a test requirement but does not define the dedup key. I-ST04 binds idempotency on `(brand_id, event_id)` for the collector/event-bus layer. But the ledger layer is downstream: a `provisional_recognition` event for `order_id=X` re-emitted from Bronze must produce exactly one ledger row, not two. The dedup key must be specified before the migration is written. The natural candidate is `(brand_id, order_id, event_type)` but this breaks on legitimate re-recognitions (e.g. a split shipment where two `finalization` rows for the same order are valid). The Architect must bind the exact key.

**Cite:** `01-requirement.md` line 29 ("replay-idempotency" test requirement) + INVARIANTS.md I-ST04.

---

### HIGH

**H-1: Double-count risk on the as-of closed-sum read**
The closed-sum property (`realized_gmv = SUM(amount_minor) WHERE recognition_label='finalized' AND economic_effective_at <= as_of`) is stated in METRICS.md but the ledger spec allows both `provisional_recognition` rows and `finalization` rows to coexist for the same order. The as-of GMV function must sum only `finalization` (and reversal) rows — not `provisional_recognition` rows — or it double-counts. METRICS.md §`realized_revenue` definition correctly says `WHERE recognition_label='finalized'` but this must be enforced by the view/function definition, not convention. If a developer queries `SUM(amount_minor)` without the label filter they get double the GMV.

**Bind:** The as-of read function must be a named Postgres function (not an ad-hoc query) with the `recognition_label` filter hardcoded. The test requirement already covers this but the Architect must make it structurally impossible to bypass via a function wrapper, not documentation.

**Cite:** `packages/money/src/index.ts` — the arithmetic is correct at the library level; the risk is at the SQL aggregation layer where the `recognition_label` filter could be omitted.

**H-2: COD horizon defaults not bound — configurable but unspecified**
METRICS.md §ASSUMPTION (line 55) flags: "approximately 25 days for COD orders and 7 days for prepaid — exact defaults are an open decision requiring Data Engineer confirmation." The requirement correctly marks this as an Architect binding. But the finalization job cannot be coded without a concrete default. The configurable dimension also needs definition: is the horizon a per-brand column on the `brand` table? A per-brand-per-payment-method config? Does it cascade (brand default → category benchmark P80 on cold-start)? The Architect must close this to a DDL-level binding.

**Cite:** `01-requirement.md` line 26 ("default ~25d COD / ~7d prepaid, brand-configurable") + METRICS.md §ASSUMPTION.

**H-3: Reconciliation tolerance — TODO-with-owner not bound to a value**
METRICS.md §ASSUMPTION (line 57) calls out two tolerances: (1) parity oracle = exact integer equality (no tolerance); (2) reconciliation (Brain ledger vs external Shopify order data) = ±2–3% by W4, >±5% = stop-and-fix. The requirement correctly flags this as a Data Engineer TODO. But this is unresolved Sprint-0 work (METRICS.md says "Sprint 0 freeze — only that Sprint 0 freeze remains open"). It must be explicitly bound before the ledger goes to integration testing, because the reconciliation test will need a tolerance value. This is the one open binding that is not the Architect's — it belongs to the Data Engineer in Sprint 0.

**Cite:** `01-requirement.md` line 70 ("reconciliation tolerance… TODO-with-owner = Data Engineer") + METRICS.md §ASSUMPTION line 57.

**H-4: RLS verification gap — dev superuser masks enforcement**
The memory note from the Canon (`dev-db-superuser-masks-rls.md`) is live: dev connects as superuser `brain`; RLS is only truly enforced under prod `brain_app`. The test requirement mandates "isolation negative-control under `SET ROLE brain_app`" which is correct. But the Architect must make this a migration-level assertion, not a test-only check. The pattern is established in migration 0017: the `DO $$` block at line 277 asserts RLS policy form at migration time. The ledger migration must include a similar assertion that the `brain_app` role lacks DELETE/UPDATE on the ledger table and that the RLS policy uses the two-arg `current_setting` form.

**Cite:** `db/migrations/0017_identity_graph.sql` lines 277–314 (the NN-1 assertion pattern) + COMPLIANCE.md Controls table ("no DELETE grant on `realized_revenue_ledger`").

---

### MEDIUM

**M-1: Single-currency-per-brand guard — not enforced at the schema level**
The requirement correctly states "single-currency-per-brand for M1." But the schema as drafted (per 01-requirement.md) does not specify a per-brand currency constraint. Without a CHECK or a brand-level `currency_code` column, nothing structurally prevents two `provisional_recognition` rows for the same brand from having different `currency_code` values (e.g. INR and AED), which would make the `SUM(amount_minor)` silently wrong. `packages/money/src/index.ts` line 102–108 (`assertSameCurrency`) handles this in TypeScript arithmetic — but that only fires if you add two Money objects together; it does not prevent heterogeneous rows in the DB.

**Bind:** The migration must either (a) add a `brand_currency_code CHAR(3)` column to the `brand` table and add a FK+CHECK on the ledger, or (b) add a per-brand DB constraint ensuring all ledger rows for a brand share one `currency_code`. Option (a) is cleaner and is consistent with the M1 single-currency constraint. The `assertSameCurrency` in `packages/money` covers the TypeScript metric-engine path but not the raw SQL aggregation path.

**Cite:** `packages/money/src/index.ts` line 102 (`assertSameCurrency`).

**M-2: No-float lint coverage on SQL column definitions**
The `no-float-money` ESLint rule (`tools/eslint-rules/no-float-money.mjs`) covers TypeScript variable declarations and type signatures. It does NOT cover SQL migration files. A migration that writes `amount_minor NUMERIC` (instead of `BIGINT`) would pass ESLint and violate I-S07. The fixture `tools/eslint-rules/fixtures/bad-float-money.ts` confirms the TS coverage is live. For the ledger migration, the Architect must include a migration-level CHECK or explicit DDL review gate for the `amount_minor BIGINT` column type. This is a risk unique to SQL migrations, not caught by the existing lint gate.

**Cite:** `tools/eslint-rules/no-float-money.mjs` line 1–133 (covers TS only) + `eslint.config.mjs` line 112 (wired as `error` for `*.ts`/`*.tsx` only).

**M-3: RTO/cancel timing race on provisional rows**
The COD horizon finalization job emits a `finalization` event when the horizon passes without RTO/cancel. But there is a timing race: if an RTO arrives in the same processing window as the horizon job fires, both a `finalization` and an `rto_reversal` row could be written. The net is correct (finalization + reversal = 0 realized), but the order matters for the `recognition_label` state machine. The Architect must specify whether the finalization job checks for an existing RTO before emitting, or whether it emits regardless and relies on the signed-sum property to absorb the reversal.

---

## Architect Decision Bindings

The following must be bound by the Architect before any implementation begins:

**D-1: COD/prepaid horizon defaults + brand-configurability DDL**
Default: 25 calendar days for COD orders, 7 calendar days for prepaid. Brand-configurable via a new `brand` table column: `cod_recognition_horizon_days INT NOT NULL DEFAULT 25` and `prepaid_recognition_horizon_days INT NOT NULL DEFAULT 7`. The finalization job reads these columns per brand. Cold-start: no P80 benchmark computation in M1; the platform defaults apply until the brand overrides. FX-rate pinning at recognition event time (not at finalization time) consistent with METRICS.md multi-currency pattern.

**D-2: Closed-period immutability boundary — operational definition**
`billing_posted_period` is a `CHAR(7)` column in the format `YYYY-MM` (e.g. `2026-06`). A period is "open" if no `billing_run` record exists for that `(brand_id, billing_period)`. A period "closes" when the billing meter emits the invoice for that period (a future slice). For M1, periods are never explicitly closed (no billing meter yet) — all periods are "open." The immutability invariant is enforced structurally by the app-role grant (INSERT+SELECT only; no UPDATE/DELETE) and by a migration-time assertion (mirroring 0017 pattern). A late reversal must set `billing_posted_period` to the current open period (the period of the reversal event's `occurred_at`), NOT the period of the original sale — this is the dual-date rule's operational consequence.

**D-3: Closed-sum assertion + as-of read function**
The as-of realized GMV read must be a named Postgres function `realized_gmv_as_of(p_brand_id UUID, p_as_of DATE)` that returns `BIGINT` (the signed sum). The function body MUST filter `recognition_label IN ('finalization','rto_reversal','refund','chargeback','cancellation','settlement_fee_reversal','marketplace_adjustment','payment_adjustment','concession')` and `economic_effective_at <= p_as_of`. It must NOT sum `provisional_recognition` rows. The function is the sole as-of read path — no ad-hoc `SUM(amount_minor)` queries are permitted in application code.

**D-4: Replay idempotency dedup key**
The ledger dedup key is `(brand_id, order_id, event_type, occurred_at::date)`. Rationale: `occurred_at::date` distinguishes a legitimate second `finalization` (split shipment, different day) from a replay. Implement as a UNIQUE constraint on the ledger table. For events where multiple rows on the same day are legitimate (rare), the writer uses ON CONFLICT DO NOTHING and logs a replay-suppression metric. The test requirement "replay-idempotency" must be implemented as: re-emit the same Bronze event batch → ledger row count unchanged.

**D-5: Reconciliation tolerance — Data Engineer Sprint-0 freeze**
This binding belongs to the Data Engineer, not the Architect. The tolerance value must be written to a `constraints.reconciliation_tolerance_pct` config before integration tests are run. METRICS.md §ASSUMPTION provides the reference: ±2–3% by W4, >±5% = stop-and-fix. The Data Engineer must freeze the exact value by Sprint-0 completion and commit it as a named constant in the test suite. This is the ONLY open binding that does not block the Architect's design phase.

**D-6: Single-currency-per-brand guard**
Add `currency_code CHAR(3) NOT NULL DEFAULT 'INR'` to the `brand` table (additive migration, safe). Add a FK reference from `realized_revenue_ledger.currency_code` to a new `allowed_brand_currency` table (or a simpler CHECK constraint referencing the brand row). For M1, enforce: `currency_code = (SELECT currency_code FROM brand WHERE brand_id = NEW.brand_id)` via a BEFORE INSERT trigger or application-layer guard. This prevents silent cross-currency sums.

**D-7: Rounding and allocation rule**
All money arithmetic uses `packages/money` functions only. No division on `amount_minor` that could produce a fractional result is permitted. For M1 there is no allocation (no per-channel credit split in this slice — that is the `attribution_credit_ledger`). If a settlement_fee or marketplace_adjustment has a fractional minor-unit value (e.g. a 1.5 paise fee), round using banker's rounding (round-half-to-even) and log the rounding delta to a `rounding_adjustment_minor` column on the ledger row. This must be explicit — not silent truncation.

---

## Confirmed "No New Deployable"

This requirement wires existing scaffolds only:
- `apps/core/src/modules/measurement/index.ts` — currently empty (exports `{}`); the ledger module is a new bounded context within the existing `core` monolith deployable
- `packages/money` — the arithmetic substrate; no changes to the package API; the ledger uses `money()`, `add()`, `subtract()` as-is
- The finalization job — implemented as an existing Argo-job type in the current `DeployAdapter` (STACK.md ADR-010); no new deployable

Confirmed: no new service, no new DB cluster, no new message bus topic class beyond the existing Redpanda patterns.

**Primary builder:** data-engineer (the gold ledger is the data plane's; the TypeScript metric-engine team reads from it in the next slice).

---

## Cost-Routing Confirmation

All ledger operations are tier-0 deterministic: migrations, INSERT of signed rows, the `realized_gmv_as_of()` function, and the finalization job. No model call is involved in the ledger layer. The finalization job is a deterministic time-horizon check over a SQL query. Tier-0. No cost-routing audit required for this surface; the metric engine that reads the ledger (next slice) will carry its own audit.

---

## Open Risks Summary (for Architect)

| Risk | Status |
|---|---|
| Closed-period immutability boundary (D-2) | Must bind before DDL |
| Dedup key on ledger rows (D-4) | Must bind before DDL |
| Single-currency guard at DB level (D-6) | Must bind before DDL |
| Rounding rule explicit (D-7) | Must bind before DDL |
| Reconciliation tolerance value (D-5) | Data Engineer Sprint-0; does not block Architect |
| COD/prepaid horizon configurable DDL (D-1) | Must bind before finalization job spec |
| As-of closed-sum read function (D-3) | Must be a named function, not ad-hoc SQL |
| RTO/cancel timing race on finalization job (M-3) | Architect must specify job semantics |

---

## Journal Entry

```markdown
## 2026-06-16T18:55:24Z — Engineering Advisor (cto-advisor) — feat-realized-revenue-ledger
**Stage:** 1 · **Action:** ADVANCE (compressed, adversarial folded in) · **Personas:** none (compressed pass) · **Decision:** ADVANCE → architect
**Rationale:** Requirement is well-formed, non-negotiables are stated, lane is correct high_stakes with money+multi_tenancy+audit_trail surfaces. No new deployable confirmed. 2 CRITICAL (closed-period immutability boundary unresolved; idempotency dedup key unspecified), 2 HIGH (double-count risk on as-of read; COD horizon unbound), 3 MEDIUM (single-currency schema gap; no-float-money lint covers TS not SQL; RTO/finalization race). All bindable by Architect. Reconciliation tolerance is the one Data Engineer Sprint-0 dependency. The money substrate (no-float-money lint + packages/money) is verified live and wired correctly. RLS pattern from 0017 migration is the template.
**Next:** architect (stage 2)
```
