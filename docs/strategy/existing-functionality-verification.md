# Brain — Existing Functionality Verification (live data, 2026-06-23)

Verification of the "~80% already shipped" claim against the **running local stack** (full Docker:
Postgres, StarRocks, Iceberg, Kafka, Neo4j, Redis) with the real "Bodd Active" brand
(`69589f15-a664-40fa-9f2e-d50362ae3cd8`). Evidence = row counts + a full end-to-end pipeline run.

## Verdict

The medallion data plane, customer intelligence, and recommendation loop **work on real data**.
Attribution **code is correct** (237 + 16 tests green; closed-sum parity exact) but was producing
**zero output** — starved by a chain of *upstream input/operational* gaps, not bugs. Proven by feeding
the missing inputs and watching the whole chain light up.

## What works (evidence)

| Capability | Evidence |
|---|---|
| Event capture | `silver_touchpoint` = 5631 touches, 618 anons, channels classified (referral 3330, paid_meta 1319, paid_google 550, direct 426) |
| Revenue ledger | `realized_revenue_ledger` = 1230 rows; `gold_revenue_ledger` = 1224 |
| Customer intelligence | `gold_customer_scores` = 733, `gold_customer_360` = 733 (RFM/churn/CLV) |
| Recommendations | `ai_config.recommendation` = 11, `recommendation_action` = 4 (closed loop) |
| Identity links | `identity_link` = 2364, `identity.customer` = 1490 |
| Attribution code | metric-engine 237/237, core attribution 16/16; **closed-sum parity exact** (below) |

## Gaps found (the reason attribution showed nothing)

### GAP-1 — Identity stitch never happens (anon ↔ known are disjoint islands)
- `connector_journey_stitch_map` = **0 rows**; `identity_merge_event` = **0**.
- `silver_touchpoint`: **0 of 5631** touches stitched to an order.
- `identity_link`: **743 anon brain_ids vs 747 known (email/phone) brain_ids, OVERLAP = 0**.
- **Root cause:** no event carries BOTH a `brain_anon_id` AND a customer identifier, so the anon
  browsing journey is never linked to the known customer who ordered.
- **Forward fix (this branch):** the pixel's client-side `identify()` emits an unsalted
  `hashed_customer_email` that matches the order's `pre_hashed_email` → the resolver bridges them.
  Historical data additionally needs a one-time stitch-map backfill from identity links.

### GAP-2 — Revenue-finalization pipeline has never run (and has no runner here)
- `realized_revenue_ledger` event types present: `provisional_recognition` (932),
  `cod_delivery_confirmed` (180), `cod_rto_clawback` (60), `rto_reversal` (47), `refund` (11).
  **`finalization` = 0.**
- `finalization` is the canonical "won revenue" event emitted by `PostFinalizationCommand` (a separate
  revenue-finalization job). That job has **no CLI/Argo runner in this repo** (only
  `apps/core/src/jobs/attribution-reconcile.ts` exists).
- The attribution credit pass (and several metric-engine realized-revenue reads) key on
  `event_type='finalization'`, so with zero finalization rows they match zero orders.

### GAP-3 — Attribution credit pass ignores COD-realized revenue (design, flag)
- `reconcile-attribution.ts` credit pass selects only `event_type='finalization'`. COD revenue is
  realized as `cod_delivery_confirmed`, never `finalization`. For a COD-heavy (India) brand, COD orders
  would **never attribute** even after the finalization job runs. Needs a product decision: should the
  credit basis be `finalization` ∪ `cod_delivery_confirmed`?

### Minor — `silver_order_line` thin (81 lines vs 930 orders); `gold_cac` = 2 rows.

## End-to-end proof (fed the missing inputs, per medallion: source-only injection)

Injected ONLY at the operational source (`connector_journey_stitch_map`) + the canonical
finalization event the job would emit, then let Silver→Gold rebuild deterministically:

1. 300 synthetic stitch rows → `connector_journey_stitch_map` (identifiable: all `created_at`=now).
2. `dbt run silver_touchpoint gold_attribution_paths` → **silver stitched 0 → 3055; gold_attribution_paths 0 → 300**.
3. 289 `finalization` rows (identifiable: `ledger_event_id LIKE 'VERIFY-FIN-%'`) for the stitched orders.
4. `attribution-reconcile` job → **credited 1156 = 289 orders × 4 models**; `attribution_credit_ledger` 0 → ~11.6k.
5. `dbt run gold_marketing_attribution` → **11633 rows**; per-channel attributed revenue populates
   (position_based: paid_meta ₹399,774.90, paid_google ₹152,746.12, referral ₹142,732.74, direct ₹139,587.89).
6. **Closed-sum parity EXACT:** every model (first/last/linear/position) Σ credited =
   **83,880,377** = Σ realized of the 289 finalized orders. The deterministic no-float parity oracle holds on real data.

> The injected rows are clearly identifiable synthetic *wiring-proof* data (NOT real attribution —
> the anon↔order mapping is positional, not a real signal). Remove with:
> `DELETE FROM billing.attribution_credit_ledger;`
> `DELETE FROM billing.realized_revenue_ledger WHERE ledger_event_id LIKE 'VERIFY-FIN-%';`
> `DELETE FROM connectors.connector_journey_stitch_map;` then rebuild the affected marts.

## Recommended fixes (priority order)

1. **GAP-2:** add a revenue-finalization job runner (wrap `PostFinalizationCommand`, mirror
   `attribution-reconcile.ts`) so provisional revenue actually finalizes.
2. **GAP-1:** ship the identity bridge end-to-end — verify the pixel `identify()` → resolver path
   creates anon↔known links, + a one-time stitch-map backfill for history.
3. **GAP-3:** decide + implement the COD attribution basis (`finalization` ∪ `cod_delivery_confirmed`).
4. Only AFTER 1–3 produce real stitched+finalized journeys does **data-driven (Markov) attribution**
   become meaningful — it reads the same `silver_touchpoint` corpus.
