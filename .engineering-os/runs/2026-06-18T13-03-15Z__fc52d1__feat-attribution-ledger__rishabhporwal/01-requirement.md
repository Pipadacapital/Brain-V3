# Requirement: Phase 5 — Attribution (attribution_credit_ledger + channel ROAS)

| Field | Value |
|-------|-------|
| **req_id** | `feat-attribution-ledger` |
| **Title** | Multi-touch attribution credit ledger over silver.touchpoint + realized revenue (position-based with clawback), attribution_confidence, the closed-sum parity oracle, and channel attributed-revenue/ROAS UI |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (money, data plane, multi_tenancy, ledger) |
| **Roadmap** | D14 **Phase 5 — Attribution** (now UNBLOCKED: Phase 4 journey + Phase 2 revenue truth shipped). Owned by the `attribution` module (has the Phase-4 touchpoint layer). |
| **Binding spec** | `.engineering-os/knowledge-base/METRICS.md` rows: `attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`. **Build to that spec.** |

## Why now
Phase 4 produced `silver.touchpoint` (first/last-touch journeys). Phase 2 produced the realized-revenue
ledger. The Meta/Google connectors produced `ad_spend_ledger`. Phase 5 joins them into the unit-economics
payoff: attributed revenue per channel → real channel ROAS/CAC. Every number is engine-computed (Tier-0,
deterministic) — never a prompt or dbt macro (I-E03/I-E04).

## Current state (verified)
- `silver.touchpoint` LIVE (StarRocks brain_silver, first/last-touch + UTM/channel; metric-engine `withSilverBrand`
  sole read seam). `realized_revenue_ledger` (Postgres 0018). `ad_spend_ledger` (0029). `silver.order_state` (Silver).
- `attribution` module has the touchpoint layer; `attribution_credit_ledger` does NOT exist yet (METRICS.md references
  `gold.attribution_credit_ledger` + `gold.attribution_confidence_mart`).
- `blended_roas` exists (spend vs TOTAL realized revenue) — Phase 5 makes it PER-CHANNEL via attributed revenue.

## Deliverables (build to the METRICS.md spec)
1. **`attribution_credit_ledger` (append-only, signed):** the TS **metric engine is the WRITER** (reads silver.touchpoint
   + the order's realized_revenue, computes per-touch credit, appends rows). Per METRICS.md `attribution_credit`:
   `weight_fraction DECIMAL(9,8)` per touch from the **position-based model (40% first / 40% last / 20% middle split;
   default, brand-configurable within a model set: first-touch, last-touch, linear, position-based)`, persisted at credit
   time; `credited_revenue_minor = weight_fraction × realized_revenue_minor` (BIGINT signed). The architect binds storage
   (Postgres Gold table like realized_revenue_ledger — RLS FORCE, deterministic IDs — vs StarRocks brain_gold; reconcile
   the `gold.` naming).
2. **Clawback (the hard part):** on RTO/refund/chargeback, append **mirrored negative rows** with `reversed_of_credit_id`
   using the **SAME saved `weight_fraction`** — credit is NEVER re-apportioned. Invariant: `SUM(credit + clawback)` for a
   fully-RTO'd order = 0. Deterministic reversal IDs; idempotent.
3. **`attribution_confidence` first-class** (the `gold.attribution_confidence_mart` per METRICS.md) — bind to the spec;
   feeds `effective_confidence = min(cost_confidence, attribution_confidence)`. Don't invent floats.
4. **The closed-sum PARITY ORACLE (CI-blocking):** per `attribution_reconciliation_rate` —
   `Σ channel_contribution_minor + unattributed_minor = realized_gmv_minor` for the period, enforced by a CI-blocking
   test; the unattributed residual is always computed + rendered. Fixtures MUST cover: full-RTO (attributed→0),
   partial refund (proportional clawback to saved weights), multi-touch (weights sum to 1.0), cookieless residual.
5. **`attribution_reconciliation_rate` metric** (attributed_gmv / realized_gmv) in the metric engine.
6. **UI (MANDATORY — stakeholder-visible):** attributed revenue **by channel/campaign** (with the model selector),
   the **reconciliation residual** shown alongside (unattributed), and **channel ROAS** = attributed_revenue / ad_spend
   (blending `ad_spend_ledger`) — the real per-channel unit economics. metric-engine sole read path; honest empty + the
   "synthetic (dev)" label where journey data is thin; "Powered by the Silver tier".

## Constraints
- **Money = BIGINT minor units (signed) + currency_code; no float** (I-S07). `weight_fraction DECIMAL(9,8)` exact;
  weights per order sum to 1.0 (NUMERIC precision gate). Engine-computed only (Tier-0, deterministic) — NEVER a prompt/dbt
  macro (I-E03/I-E04). The metric engine is the SOLE read path (I-ST01); UI never queries StarRocks/the ledger directly.
- Append-only ledger: never mutate a credit row; reversals are new signed rows with deterministic IDs (idempotent replay
  → no new rows). Per-brand isolation (RLS FORCE under brain_app — superuser bypass = INERT; verify NON-INERT; the Silver
  read stays the app-seam). Additive migrations only; no new deployable (I-E05).
- **The parity oracle is the acceptance gate:** `Σ channel_contribution + unattributed = realized_revenue` must hold
  (CI-blocking) — every number traces to `metric_version` + snapshot.
- Dev-honesty: real journey data is thin (23 real touchpoints) → attribution coverage is mostly synthetic in dev; label it
  honestly (never present synthetic attribution as real).

## Non-goals (follow-on)
- Incrementality / MMM / data-driven (ML) attribution — deterministic position-based model set only (D-5).
- CAC/CM2 full build (they READ this ledger — Phase 5 produces it; the cm2/cac rows in METRICS.md are later).
- View-through windows; cross-device. Multi-currency blending in ROAS (same-currency only, like blended_roas).

## Build tracks (the architect will bind)
@data-engineer (the attribution_credit_ledger storage + additive migration + the channel_contribution/confidence
mart + replay-idempotency) ∥ @backend-developer (the metric engine WRITER: position-based credit + clawback + the
parity oracle + attribution_confidence + attribution_reconciliation_rate, all Tier-0 deterministic, the SoR read seam) ∥
@frontend-web-developer (attributed-revenue-by-channel + residual + channel-ROAS UI + model selector). Verify the
closed-sum parity oracle (CI-blocking) + fully-RTO closed-sum=0 + isolation NON-INERT + replay idempotency. Reuse the
Silver seam, the realized_revenue/ad_spend ledgers, the analytics UI.
