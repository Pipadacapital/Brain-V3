# Brain — The AI Growth Operating System for Commerce Brands
### Strategy Blueprint & Engineering Plan

> Produced by a 29-agent dynamic advisory workflow: 5 grounding analysts (read the real repo), 6 competitive-intel analysts (web research on 12 competitors), a 15-persona advisory board (6 councils), 8 principal strategists, 2 capstone authors, and 2 adversarial reviewers. **Every recommendation is grounded in marts/tables/modules that actually exist in this repo** — claims that were not are flagged in the Open Risks appendix.

**Run:** `wf_bde95738-b11` · 29 agents · ~4.1M subagent tokens · grounded in 58 catalogued real capabilities.

---

## Contents

- 1. Executive Summary, North Star & Three-Year Vision
- 2. Competitor Analysis
- 3. User Personas & Business-Question Catalog
- 4. Dashboard Requirements (9 dashboards)
- 5. Insight, Recommendation & Opportunity Engines
- 6. AI Copilot & Decision Engine
- 7. Segmentation, Predictive Models & Journey Intelligence
- 8. Monetization, Pricing & Revenue Strategy
- 9. Engineering / DB / Medallion / Identity / Pipeline / UI Impact
- 10. Gap Analysis & Product Roadmap
- Appendix A — Open Risks (adversarial critique)
- Appendix B — Competitor Intelligence (data)
- Appendix C — Advisory Board (15 personas)
- Appendix D — Grounded Capability Inventory

---

# 1. Executive Summary, North Star & Three-Year Vision

## EXECUTIVE SUMMARY (decision-grade, one page)

Brain has built the single most honest data foundation in commerce intelligence and has shipped **almost none of it as paid, activated value**. Both halves of that sentence are verified in the repo, not asserted: the foundation is real (immutable Iceberg Bronze `brain_bronze.collector_events`; a deterministic money ledger `gold_revenue_ledger` with `toleranceMinor=0`; a single-source `METRIC_REGISTRY` of 24 metric IDs as the *sole* Gold reader via `withSilverBrand`; `%`-of-realized-GMV billing in `gmv_meter_snapshot`/`billing_plan`), and the activation gap is structural — `reconcile-attribution.ts:19` literally states reconcile is *"NOT auto-triggered by the finalization job"* (so `gold_marketing_attribution`/`gold_attribution_paths` are ~0 rows on a fresh tenant), every recommendation detector is `subject:'brand'` (none at channel/campaign/SKU grain), the CAPI write-back is `would_send_dev` / *"NEVER sends"* (`main.ts:525`), and billing falls back to a single flat `DEFAULT_RATE_BPS` with no payment rail and no automated month-close.

**The strategic error to refuse** (unanimous across all 5 advisory councils and 15 personas): racing Triple Whale/Klaviyo toward autonomous agents and trained ML on top of an unclosed foundation — Brain has zero trained models (`ml.model_registry` holds one deterministic RFM placeholder; `serveCustomerScore` is a Gold *read* cosplaying as inference), an online feature store nothing reads, and a ~0-row credit ledger. Doing so inherits every incumbent's "buggy/black-box/over-attributing" liability **with none of their distribution**.

**The bet:** Brain wins not by being a better Triple Whale, but by being the **system of revenue truth** — the only commerce OS whose every number reconciles to the merchant's Shopify payout *and* Razorpay/COD settlement to the rupee, net of RTO, refunds, and COGS, with a drillable confidence grade. Trust is the conversion event and the fee-justifying basis. We make truth *visible* (reconciliation receipt), *populated* (auto-fire reconcile), *acted-upon* (one closed recommendation→outcome loop on the COD/RTO + CM2 beachhead where Brain is the *only* option), and *collectable* (auto-seal + payment rail + tiered plan). Predictions and autonomy are *earned later* by the outcome-labeled dataset that loop produces — never bought on credit.

**Sequence (do this, in order, before any ML):** (1) auto-trigger `reconcileAttribution` on `realized_revenue_ledger` finalization + backfill → kills the empty-chart violation of Brain's own law; (2) ship the **Reconciliation Receipt** over `gold_revenue_ledger` + `realized_gmv_composition_*` → the un-fakeable demo; (3) productize **confidence + freshness** as a first-class trust badge → the white-space no rival occupies; (4) close **one** action loop (abandoned-cart recovery via `silver_checkout_signal`, or RTO-hold via `silver_shipment` + the `rto_risk` detector) → first measured lift; (5) close the **monetization loop** (auto-seal `sealBillingPeriod` via Argo cron, Razorpay charge against the GST invoice, extend `billing_plan` into Free/Core/Growth/AI/Enterprise tiers gated through the existing `entitlements.ts`). Lead go-to-market from the **India COD/RTO + CM2-profit beachhead** — the uncontested category no Western incumbent can model.

---

## BRAIN NORTH STAR

**The one metric: Reconciled GMV Under Decision (RGUD)** — the total realized, penny-reconciled GMV (from `gold_revenue_ledger`, sealed in `gmv_meter_snapshot`) belonging to brands who have *acted on at least one Brain recommendation with a measured outcome in the trailing 30 days* (proven via `recommendation_action` 0082 + `recommendation_outcome` 0045).

**Why this and not the obvious alternatives:**
- **Not "active brands" / "MAU"** — vanity; a brand staring at a dashboard it doesn't trust or act on is pre-churn. Every retention-native persona (Lifetimely, Peel, CS Leader) confirmed renewal is driven by a *human making a decision on the tool*, never by login count.
- **Not "realized GMV measured"** — Brain can already measure GMV it has no right to bill, and measurement-without-action is the Peel/Daasity trap (descriptive, cancelled in budget reviews).
- **RGUD is the only metric that compounds all three of Brain's growth vectors simultaneously and is impossible to fake:** it can only rise if (a) the number is *trusted* (reconciled, so the brand believes it), (b) the number is *acted on* (a recommendation was approved and an outcome measured — proving the insight→action→outcome loop closed), and (c) the brand's *GMV grows* (the basis Brain bills `%` on). It is literally the intersection of Brain's purpose ("Capture Truth → Build Trust → Enable Decisions") and Brain's business model (`%`-of-realized-GMV). When RGUD grows, ARR grows *by construction* and so does the proprietary outcome-labeled dataset that is the only honest license to train ML. It is the single number a CPO can hold every team accountable to without it ever rewarding the wrong behavior.

---

## THREE-YEAR VISION

### Year 1 — TRUST + INSIGHT (make the moat visible, populated, and collectable)
**Theme:** ship what is already built but inert. Win on truth you can *prove* before predictions you can't yet stand behind.

- **Reconciliation Receipt** (Founder/Exec dashboards) — Brain-realized vs Shopify/Razorpay payout, delta explained line-by-line (refunds, RTO clawbacks via `silver_shipment.terminal_class`, COD non-delivery, fees), drill-to-source per `gold_revenue_ledger.event_type`. Pure read over existing marts + `realized_gmv_composition_for_period()`. *This is the entire sales demo and the basis that justifies the fee.*
- **Auto-trigger `reconcileAttribution`** on finalization (new consumer-group on the existing `{env}.collector.event.v1` lane) + one-shot backfill → `gold_marketing_attribution`/`gold_attribution_paths` populate, activating the already-built `attribution_credit` / `attribution_reconciliation_rate` / `attribution_confidence` registry metrics and `computeChannelRoas`/`computeCampaignRoas` with zero new modeling. Honors "no empty charts."
- **Confidence + freshness as a first-class trust badge** across every tile (wire existing `attribution_confidence` A/C/D, `cost_confidence`, `effective_confidence`, `FeatureStaleError`, data-foundation-health). The category white-space; the direct antidote to Sidekick hallucination (~95%) and Triple Whale's silent 15-25% discrepancy.
- **Insight Engine** — deterministic anomaly/trend scan comparing each registry metric to its own trailing baseline from the *already-landed* snapshot marts (`snap_order_state`, `feature_customer_daily`); "$ impact" promoted to a first-class formula-bound field. The "what changed at 9am Monday" answer Sidekick hallucinates.
- **COD/RTO + CM2 profit beachhead** as headline nav (not buried under "analytics") — re-grain `gold_cac` to channel×week; wire CM2 (`cost_input` 0055) to `silver_order_line` grain. The uncontested wedge.
- **Close the monetization loop:** auto-seal `sealBillingPeriod` (Argo `CronWorkflow`), add `payment_status` to `invoice` + Razorpay charge (reuse the Gokwik/Shiprocket OAuth seam), extend `billing_plan` into Free/Core/Growth tiers gated through `entitlements.ts`. **Land free on the receipt; charge `%` at Core.**
- **Year-1 outcome (rough):** first paying cohort; **+15–30pp trial→paid** from the receipt + populated attribution; ARR goes from structurally-$0-capable to a real, collectable book. *North-star target: RGUD becomes measurable and non-zero for the first time.*

### Year 2 — RECOMMENDATION + PREDICTION (close the loop, earn the right to a model)
**Theme:** turn truth into a 9am-Monday decision, then let measured outcomes license the first real model.

- **Re-grain detectors** from `subject:'brand'` to channel/campaign/product/customer (columns already exist in `gold_marketing_attribution` + `silver_marketing_spend` + `silver_product`); add `channel_budget_reallocation`, `campaign_cm2_negative`, `product_margin_leak`, order-grain pre-ship `cod_rto_hold`. One-click **approve** loop (Copilot, never autopilot) writing to `recommendation_action`.
- **Opportunity Engine** — convert already-quantified-but-inert money into ranked actions: abandoned-cart recovery (`silver_checkout_signal.abandonedValueMinor`), high-LTV lapsing win-back (per-brand inter-purchase interval), CM2-aware cross-sell. **Recovered GMV flows through the very ledger Brain bills on** — the recovery feature grows its own fee base.
- **Outbound audience-activation sink** (publish margin-aware, RTO-aware, identity-deduped segments to Klaviyo lists / Meta Custom Audiences via `decision_log`) — Brain is the brain, Klaviyo the mouth; raises switching cost (rip out Brain → audiences go dark).
- **Fix the retention/prediction substrate honestly:** add order-sequence timestamps to `feature_customer_daily`; build the *real* `gold_retention_curve` (N0/N1/N2, not the avg-orders aggregate currently mislabeled); **rename `ltv` → ARPU** (it is `realized ÷ customers`, cohort-naive — a $42 honest-ARPU loses a demo to Lifetimely's $115 forecast).
- **First trained models — eval-gated, only now:** predictive LTV (BG/NBD + Gamma-Gamma) and churn/next-purchase on `feature_customer_daily`, registered in `ml.model_registry`, gated to *beat the deterministic baseline*, served with a **forecast-vs-realized overlay** (a trust artifact no competitor ships). **AI add-on** tier monetized by metering the `recommendation_action`/`prediction_log` ledgers → NRR engine.
- **Flip CAPI to live** (consent-gated EMQ optimization) — a write-back primitive that already exists, parked in dev; the measurable CPA lever (Elevar's whole business).
- **Year-2 outcome (rough):** **NRR 115–130%** from GMV growth + AI-action usage + multi-brand seats; per-brand **3–8% COD margin recovery** and **5–15% CPA reduction**, both attributable against the ledger → referenceable case studies that underwrite premium pricing.

### Year 3 — AUTONOMOUS DECISIONING (graded autonomy on an auditable, reversible base)
**Theme:** the agentic narrative on *Brain's* terms — auditable, reversible, human-graduated — the one thing Moby's black-box autopilot structurally cannot be.

- **Graded autonomy ladder:** Suggested → Approved (human, one-click) → Automated (per-brand, per-detector `autonomy_policy`, ships *last*, gated on accumulated outcome evidence). Execution via Temporal durable workflows with **compensation/saga reversal** — every action (suggested/approved/executed/reversed) appends to `decision_log`. Reversibility is a first-class requirement, not a feature.
- **Deterministic guardrails in code, never the model:** max % budget moved/period, min confidence grade (Trusted-only for automated), spend floors/ceilings, 60s kill switch (progressive-delivery flag); stale data auto-downgrades automated→suggested. The model *narrates and ranks*; it never decides to execute and never emits a number.
- **Incrementality / geo-holdout** on the immutable Bronze (the upmarket wedge vs Northbeam) — measurement *and* truth from one substrate, written to `decision_log`. **No Markov/Shapley** until incrementality validates allocation (else inherit the GA4-disagreeing-black-box trap).
- **Non-hallucinating Ask Brain** at scale — the existing `ask-brain.ts` grounding contract (model binds a registry ID, the metric-engine computes the number, provenance persisted) extended to proactive briefings; cost-tier routed (deterministic ≫ small ≫ frontier, ~1:100:10k).
- **Year-3 outcome:** Brain is the **autonomous-yet-auditable growth OS** — the category position no single competitor holds (Northbeam=slow/rigorous, Triple Whale=fast/discrepant, Klaviyo=gross/channel-locked). Expansion to Enterprise (multi-brand, residency, compliance shield) and a defensible data moat: a proprietary outcome-labeled dataset of *what actually grew profit*, impossible to backfill.

---

## THE WEDGE vs COMPETITORS (one line each, why Brain becomes indispensable)

- **Triple Whale / Klaviyo / Shopify-native** report gross, self-attributed, or hallucinated numbers; **Brain reconciles to the payout to the rupee** — the 15-25% discrepancy / inflated-attribution / ~95%-hallucination wound, cured.
- **Northbeam / Rockerbox** are rigorous but slow, expensive ($1.5k–$5M floors), and analyst-dependent; **Brain is real-time, self-serve, and deterministic-first** — measurement on the same replayable Bronze, no warehouse to operate.
- **Lifetimely / Peel** are descriptive and Shopify-locked; **Brain closes the action loop** (recommendation→outcome→activation) and is identity-resolved + multi-channel.
- **The uncopyable moat — India COD/RTO + settlement-aware net profit:** NO Western incumbent models it. `%`-of-*realized* GMV is both Brain's most defensible pricing and its most honest — it bills on delivered-and-paid cash, perfectly aligned with the merchant's truth.

**Why indispensable:** once a brand's audiences are computed by Brain, its month-close is reconciled by Brain, its budget decisions are graded against Brain's penny-accurate ledger, and its margin is protected by Brain's RTO holds — ripping Brain out turns the lights off across measurement, decisioning, *and* activation. That is the system of record, not a dashboard. The whole strategy reduces to one disciplined refusal: **prove truth before selling predictions, and let the proof pay for the predictions.**

---

# 2. Competitor Analysis

*Competitor Analysis: Where Brain Wins, Where It's Exposed, and the 5 Plays*

## Competitor Analysis — Brain vs. the Commerce-Intelligence Field

The category has split into four archetypes, all converging on the same "AI growth OS for commerce" claim Brain targets. Brain competes with **none of them today** (zero paying brands, no payment rail in `billing_plan`/`gmv_meter_snapshot`), but it holds one structurally uncopyable asset — penny-accurate, COD/RTO-aware revenue truth — that every incumbent is *hated* for getting wrong. The strategic error to avoid is fighting these players where they are strong (agentic action, attribution breadth) instead of where Brain is the only option (settlement-aware net-profit truth).

---

### Per-Competitor Teardown

#### Performance-attribution incumbents

**Triple Whale** — *The category-defining threat (HIGH).*
- **Loves:** ease-of-use, real-time blended dashboards (MER/POAS), Triple Pixel match rates, Moby agentic narrative; 60k brands / $82B GMV, G2 4.4.
- **Hates:** **15–25% attribution discrepancy vs Shopify**, "buggy/unreliable" attribution, 2024 price hikes +30–50% mid-contract, support collapse, "overwhelming" for lean teams, non-Shopify is second-class.
- **Where it FAILS:** no immutable replayable ledger; click-based credit is allocation, not causal; numbers aren't traceable to source; no confidence/freshness surfaced.
- **Brain's wedge:** Brain's `gold_revenue_ledger` (toleranceMinor=0, signed clawbacks), Iceberg `brain_bronze.collector_events`, and the `metric-engine` registry (21 IDs) reconcile to the penny — the exact 15–25% wound. **But Brain's `gold_marketing_attribution`/`gold_attribution_paths` are ~0 rows** because `reconcile-attribution.ts` is only triggered via `attribution-reconcile.ts` (Argo/BFF), not on finalization — so the head-to-head attribution demo is *empty*, violating Brain's own "no empty charts" law.

**Northbeam** — *Upmarket causal-measurement benchmark (MODERATE).*
- **Loves:** server-side ingestion (iOS-resilient), weekly-retrained MMM+, holdout/incrementality rigor, platform-agnostic.
- **Hates:** steep learning curve (needs a hire), 29-day onboarding, absent post-sale CS, slow cadence, ~3 months upfront, $1.5k/mo floor, Magento2 breakage.
- **Where it FAILS:** no real-time, no SMB tier, thin action layer, opaque credit derivation despite ML positioning.
- **Brain's wedge:** Brain can run a deterministic-assignment holdout (`experimentation-holdouts` seam, unwired) on the *same immutable Bronze* that produces its ledger — measurement + truth from one substrate. **Caveat:** Brain has only 4 deterministic positional models (`attribution-models.ts`: first/last/linear/position) — that is bookkeeping, not incrementality. Do not market "attribution intelligence" against Northbeam without ONE incrementality primitive.

#### Retention / lifecycle players

**Lifetimely** — *Highest-overlap on the LTV/profit narrative (HIGH).*
- **Loves:** profit/LTV insights, best-in-class cohorts, responsive support; **4.9/5 over ~493 reviews, 3–5yr tenure**; predictive 30/60/90-day & 12-mo LTV; "AI Profit Agent."
- **Hates:** not real-time (hours-stale), Shopify lock-in (Amazon = +$75 bolt-on), manual COGS setup friction.
- **Where it FAILS:** imports CAC (no journeys), black-box predictive LTV, single-platform, no identity graph, no action loop.
- **Brain's wedge:** Brain's `gold_cac` + streaming Bronze→StarRocks path gives **live LTV:CAC by acquisition cohort** Lifetimely cannot (it has no CAC truth). **Exposure:** Brain's "LTV" is `realized ÷ customers` (cohort-naive ARPU) in `computeExecutiveMetrics` — a $42 honest-ARPU loses a demo to Lifetimely's $115 forecast. Either rename it ARPU or ship a forecast on `feature_customer_daily`.

**Peel Insights** — *Premium descriptive-retention niche (MODERATE).*
- **Loves:** 150+ metrics, 30+ cohort KPIs, subscription depth, high-touch CSMs; 5.0/5 Shopify.
- **Hates:** $499/mo floor, "pay more for identical features as volume grows," raw data-dump exports, connector gaps.
- **Where it FAILS:** **no predictive/anomaly/NL AI, no action layer** — stops at the chart.
- **Brain's wedge:** Brain's `recommendation` detectors + `decision_log` + `recommendation_action` ledger (0082) are the prescriptive layer Peel structurally lacks; don't chase its 150-metric breadth (the trait Peel is hated for).

#### CRM / channel / CDP / signal layers

**Klaviyo** — *Owns the customer relationship; moving up to "autonomous CRM" (HIGH).*
- **Loves:** deep Shopify integration, segmentation/flows, predictive CLV/churn baked-in, Marketing/Customer Agents + Composer.
- **Hates:** cost escalation, 2025 active-profile billing shock, **inflated self-attributed revenue**, weak support.
- **Where it FAILS:** **reports GROSS revenue — no COGS/refunds/RTO/ad-spend**; last-touch only; no CAC/ROAS; CDP is a bolt-on.
- **Brain's wedge:** Be the **net-margin scorecard Klaviyo grades its homework against** — `gold_revenue_ledger` + `silver_shipment` (RTO clawbacks) + CM2 (`cost_input` 0055) compute true net contribution per flow. **Exposure:** Brain has a CAPI passback orchestrator (`capi-passback.service.ts`, dev-boundaried) but **no outbound audience sink into Klaviyo/SMS** — insights die at the dashboard edge.

**Postscript** — *Single-channel SMS specialist (LOW).* SMS-only, Shopify-only, NA-only; over-attributes; no profit/CAC/data foundation. → **Connector + conversion-feedback target, not a competitor.**

**Twilio Segment** — *Incumbent CDP gravity (HIGH).* 700+ integrations, best DX, CustomerAI Predictions. Hated for **MTU pricing** (counts anonymous visitors). Fails on commerce revenue-truth (generic event router, no settlement/RTO awareness, predictions not revenue-grounded). → Brain's `%-of-realized-GMV` billing + commerce-specific truth is the wedge; can sit downstream of Segment.

**RudderStack** — *Closest architectural analog (MODERATE-HIGH).* Warehouse-native, no-MTU pricing, Segment-compatible, RudderAI + Snowpark predictions. Fails by **requiring you to operate a warehouse** and being engineer-only with generic (non-commerce) predictions. → Brain is turnkey commerce intelligence owning the full Bronze→Decision stack.

**Elevar** — *Shopify signal-quality beachhead (MEDIUM).* 6,500 merchants, 99% CAPI delivery, profit-to-bidder feature, transparent pricing. Hated for **setup complexity (#1 complaint), surprise overages, Shopify-only**. Fails on attribution modeling, AI, decision layer. → **Position ABOVE Elevar** (ingest its server-side events, reconcile, decide) — don't fight for the pixel slot.

**Rockerbox** — *MTA+MMM+incrementality benchmark, now DoubleVerify-owned (MEDIUM-HIGH at top end).* Only platform unifying three methods. Hated for **$5M+ spend floor, full-time-dev setup, credit opacity** (ironic given transparency claim). → Attack the under-$5M segment + the transparency gap with Brain's metric registry drill-to-source.

#### Data-platform & native

**Daasity** — *Warehouse-native modular data platform (MODERATE).* Omnichannel SSOT, 60–300 connectors, Nielsen/SPINS benchmarking. Hated for **weeks-to-months setup, analyst dependency, shallow AI**. → Brain = "Daasity's rigor without the data team or the wait, and it actually decides."

**Shopify Analytics / Sidekick / Magic** — *Free, pre-installed, price-to-zero gravity (MASSIVE distribution threat).* Sidekick Pulse does proactive anomaly alerts. Hated for **~95% hallucination rate** (invents specs, product codes, tax facts), no web analytics, no cross-channel, no data ownership. → Brain's "**no hallucinated numbers**" guarantee (registry-sourced, never model-generated) is the direct antidote.

---

### Positioning Table

| Dimension | Triple Whale | Northbeam | Lifetimely | Klaviyo | Segment/Rudder | Elevar | Shopify native | **Brain** |
|---|---|---|---|---|---|---|---|---|
| Revenue = penny-reconciled truth | ✗ (15–25% off) | partial | gross | ✗ gross | ✗ | ✗ | ✗ hallucinates | **✓ `gold_revenue_ledger`, tol=0** |
| COD/RTO/settlement-aware net | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓ `silver_shipment`+`logistics-status`** |
| Net margin after COGS (CM2) | ✗ | ✗ | partial | ✗ | ✗ | bidder-only | ✗ | **✓ `cost_input`/CM2** |
| Confidence + freshness on every number | ✗ | ✗ | ✗ | ✗ | ✗ | "always 100%" | ✗ | **✓ substrate exists, unwired to UI** |
| Causal incrementality | ✗ | ✓ MMM+ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (seam exists) |
| Populated attribution day-1 | ✓ | ✓ | n/a | ✓ | n/a | ✓ | ✗ | **✗ ~0 rows (reconcile not auto-fired)** |
| Action/execution loop | ✓ Moby | weak | advisory | ✓ Composer | activation | bidder | Pulse alerts | recommend-only + ledger |
| Trained ML models | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | **✗ deterministic only** |
| Outbound audience activation | ✓ | partial | ✗ | ✓ | ✓ | ✓ CAPI | ✗ | **✗ (CAPI dev-only, no Klaviyo sink)** |
| Platform breadth (Woo/Magento) | weak | ✓ | ✗ | weak | ✓ | ✗ | ✗ | promised (credential-blocked) |
| Pricing trust | ✗ hikes | ✗ upfront | banded | ✗ shock | ✗ MTU | overages | free | **✓ %-of-realized-GMV (no rail yet)** |

**Brain's one-line wedge:** *"The only commerce OS whose every number reconciles to your Shopify payout AND your Razorpay/COD settlement to the rupee — net of RTO, refunds, and COGS — with a confidence grade you can drill to source."* No incumbent can copy this without rebuilding its foundation.

---

### The 5 Biggest Opportunities for Brain

#### 1. The Penny-Reconciliation Receipt — make the moat *visible*
- **Brand value:** Sees "Shopify reports X, Brain's verified ledger shows Y, here's the delta line-by-line (refunds, RTO clawbacks, COD non-delivery, fees)." Directly fires Triple Whale (15–25% off) and exposes Klaviyo's inflated gross.
- **Brain value:** Converts invisible plumbing into *the* sales demo; un-fakeable, category-of-one; underwrites the `%-of-GMV` billing basis (a brand won't pay a fee on a basis it can't audit).
- **Architecture fit:** Reads existing `gold_revenue_ledger` + `realized_gmv_composition_*` seam + `metric-engine` registry. No new infra — a surfaced view.
- **Changes required:** New BFF route + reconciliation UI; a reconciliation oracle proving `billing.realized_revenue_ledger` matches Shopify/Razorpay payouts; per-brand `reconciliation_rate` + drift. Honestly close the seam where order/customer/spend Silver still read PG read-shims before claiming "lakehouse-sourced."
- **Impact:** Trust is the conversion event. Recovering/explaining even 5% of misattributed GMV pays the fee many times over → the single highest trial-to-paid lever. **Est. +15–30pp trial-to-paid conversion** on the first cohort.

#### 2. Lead Go-To-Market from the COD/RTO + CM2 Profit Beachhead — fight where you're the *only* option
- **Brand value:** Indian/COD-heavy brands lose 20–40% of COD orders to RTO; their "revenue" and "ROAS" are fiction. Brain shows true net revenue and CAC-net-of-RTO. Pairs `cod_rto_rate`/`cod_mix` + `silver_shipment.terminal_class` + `gokwik.rto_predict` risk + the `rto_risk` detector into a pre-ship flag/hold action via `recommendation_action` (0082).
- **Brain value:** Uncontested vertical+geographic wedge — NO Western incumbent (Triple Whale, Northbeam, Lifetimely, Peel, Klaviyo, Segment, Rockerbox) models COD/RTO/settlement. Zero attribution-credibility baggage. `%-of-realized-GMV` is *more* honest here (bills on delivered-and-paid, not gross orders).
- **Architecture fit:** All assets exist (`@brain/logistics-status`, `silver_checkout_signal`, CM2 via `cost_input`). Needs the CM2 reader pushed from brand-grain to **channel × campaign** using `silver_marketing_spend.campaign_id`.
- **Changes required:** Productize an RTO/COD profit-protection surface as headline nav (not buried under "analytics"); re-grain `gold_cac` and the `scale_opportunity`/`margin_erosion` detectors to channel × week.
- **Impact:** Value-based pricing on demonstrable margin recovered — competitors can't price here because they can't measure it. **Est. 3–8% net-margin recovery** per COD-heavy brand on flagged orders; an entire defensible ARR segment.

#### 3. Close the Attribution Loop — auto-fire reconcile so the flagship is never empty
- **Brand value:** Day-1 real multi-touch channel/campaign credit (`channel_path`, first/last touch, `position_based`) reconciled to verified revenue — the opposite of Triple Whale's "buggy" and Klaviyo's "inflated."
- **Brain value:** Activates 3 already-built registry metrics (`attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`) + `computeChannelRoas`/`computeCampaignRoas` from `gold_marketing_attribution`/`gold_attribution_paths` — turns ~0-row dormant code into demoable product with zero new modeling; honors the "no empty charts" invariant.
- **Architecture fit:** `reconcile-attribution.ts` exists and is tested; today only fired via `attribution-reconcile.ts` (Argo/BFF).
- **Changes required:** Trigger `reconcileAttribution` on `realized_revenue_ledger` finalization/reversal + a new-tenant backfill so marts populate in the first session. Surface the frozen A/C/D confidence grade on every ROAS figure. **Do NOT** add a 5th model or Markov/Shapley.
- **Impact:** Attribution is the #1 reason brands pay $129–$1,500+/mo. **Est. this is the table-stakes unlock for any paid tier** — without it there is no paid attribution conversion.

#### 4. Productize Confidence + Freshness as a First-Class Trust UI — own the white-space
- **Brand value:** Never act on a stale/low-confidence number unknowingly; defend every KPI to a CFO with its grade and as-of time. Directly attacks the universal incumbent complaint (opaque, over-confident, GA4-disagreeing numbers; Sidekick hallucinations).
- **Brain value:** The clearest category white-space — EVERY competitor presents numbers without surfaced confidence. Cheap to build; substrate exists (`attribution_confidence`, `cost_confidence`, `effective_confidence`, `FeatureStaleError` SLO, `data-foundation-health`, readiness `entitlements`).
- **Architecture fit:** Wire existing grades into a single "trust badge" primitive with drill-to-source across every tile.
- **Changes required:** UI component + BFF freshness/DQ state plumbing. Be honest about coverage gaps (e.g., the `brain_anon_id` journey-coverage hole) — "attribution covers 41% of revenue" earns *more* trust than a 100% claim.
- **Impact:** Trust is the conversion lever in every competitor's hated column. **Est. enterprise-procurement unlock** (moves Brain from SMB tool to a $40M brand's system-of-record); reduces post-first-wrong-number churn.

#### 5. Close ONE Recommendation→Outcome Loop + the Outbound Audience Sink — become a decision partner, not a dashboard
- **Brand value:** A measured before/after win ("Brain told me to flag/cut X, I did, here's the rupees saved"), plus pushing a Brain-computed margin-aware, RTO-aware, identity-deduped segment into the tool the brand already runs (Klaviyo lists / Meta Custom Audiences). The "now what" Peel/Daasity/Shopify never deliver.
- **Brain value:** Generates the proprietary outcome-labeled dataset that is the *only* honest license to train a model later; raises switching cost (rip out Brain and audiences go dark). Closes `insight → action → outcome → learning` via existing `recommendation_outcome` (0045) + `recommendation_action` (0082) + `decision_log`.
- **Architecture fit:** Detectors + ledgers exist; the gap is the human-facing loop and the outbound reverse-ETL connector (the `outbound-channels`/`integration-connectors` seams exist). The CAPI orchestrator is dev-boundaried — flip to live sends with EMQ optimization for a measurable CPA lever.
- **Changes required:** A "Money Found" first-run activation screen; one detector (`rto_risk` or `margin_erosion`) wired end-to-end with visible before/after; an audience-activation sink written through `decision_log` for auditability.
- **Impact:** Documented outcomes justify premium + expansion pricing and are the testimonial engine. **Est. the single biggest 90-day retention driver** — recommend-only tools get cancelled in budget reviews; measured-lift tools renew.

---

### What Brain Must AVOID (council-unanimous)
- **Don't out-Triple-Whale Triple Whale on agents/Autopilot** — Brain has zero trained models (`ml.model_registry` holds only a deterministic RFM scorer; `serveCustomerScore` is a Gold *read* cosplaying as inference), an online feature store nothing reads (no `RedisOnlineStore.get()` caller), and recommend-only governance. Autonomous bid changes on a ~0-row credit ledger is a P0 trust-destroyer.
- **Don't build Markov/Shapley/ML attribution** to look sophisticated — with no incrementality to validate against, you inherit the exact "GA4-disagreeing black box" reputation you attack.
- **Don't train any ML model** until the deterministic action→outcome loop produces labeled data and the eval gate actually gates a learned metric.
- **Don't market Woo/Magento/universal-pixel breadth as live** while credential-blocked — overclaiming breadth you can't deploy is what loses a Shopify Plus tech-eval. Win Shopify Plus *definitively* as the layer ABOVE the existing stack first.
- **Don't lead with Neo4j identity** — the authoritative resolver is PostgreSQL union-find (migration 0017); Neo4j is default-OFF and never read. Fix the doc drift (`silver_customers.sql` still claims Neo4j mints `brain_id`) before a buyer's analyst greps the repo.
- **Don't ship more marts** — `gold_revenue_analytics` is already orphaned (no reader); breadth without a paying buyer is negative work.

**Bottom line:** Brain has the most architecturally honest product in the category and the only uncopyable moat (settlement-aware, penny-reconciled, confidence-gradable revenue truth). The entire risk is spending that moat on the one fight it cannot win (agentic action on an unclosed foundation) instead of making truth *visible, populated, and actioned* on the COD/RTO + CM2 beachhead where it is the only option. Sequence: reconcile in front of a real brand → surface found-money → close one outcome loop → charge a share of the GMV you proved.

---

# 3. User Personas & Business-Question Catalog

*Brain User Personas + Canonical Business-Question Catalog (mart-grounded)*

## Brain — User Persona Analysis + Business-Question Catalog

**Purpose of this doc:** map every buyer/user to the *real* marts and metric-engine functions that serve them, so product can stop shipping breadth and start shipping the 3-4 surfaces that close trials. Everything below cites code that exists today (`packages/metric-engine/src/*`, `db/dbt/models/marts/*`, `apps/core/src/modules/*`). Where a question has **no clean reader today**, it is flagged — those flags are the build backlog.

A recurring truth from the inventory and all 5 advisory councils: Brain's strongest, *uncontested* assets (COD/RTO truth via `silver_shipment` + `cod_rto_rates.ts`; net-margin via `contribution-margin.ts` CM2; penny-reconciling `gold_revenue_ledger`) sit under-marketed, while the surfaces being positioned as flagship (multi-touch attribution: `gold_marketing_attribution`, `gold_attribution_paths`) are **structurally complete but ~0 rows** because `reconcile-attribution.ts` is not auto-triggered on order finalization. Persona JTBD below is written to point each user at the asset Brain can actually win on.

---

## PART 1 — USER PERSONAS

### 1. Founder / CEO (lean DTC, $2M–$15M, no analyst)
- **Daily workflow:** opens one screen for 60 seconds — "are we growing, am I making money, what's broken." No time for 28 dashboards.
- **Key decisions:** how much to spend next month; which channel/product to double down on; is the business actually profitable after COGS/RTO.
- **Pain points:** every tool (Triple Whale, Klaviyo) shows a *different* revenue number, none reconcile to the Shopify/Razorpay payout; "revenue" is gross, not cash.
- **KPIs:** realized revenue, net margin, blended ROAS, cash collected.
- **JTBD Brain must own:** *"Give me one number I can trust that reconciles to my payout — and tell me if I'm actually profitable."*
- **Real marts:** `gold_executive_metrics` (via `executive-metrics.ts`), `gold_revenue_ledger` (via `realized-revenue.ts`), `contribution-margin.ts` (CM2), `cod-rto-rates.ts`. **Gap:** no reconciliation-to-payout surface exists — this is the #1 council-recommended build (a "Brain vs Shopify/Razorpay delta" view over `gold_revenue_ledger` + `realized_gmv_composition`).

### 2. CMO / VP Growth (mid-market, $15M–$50M, owns the marketing P&L)
- **Daily workflow:** weekly budget reallocation across Meta/Google; defends spend to the CFO.
- **Key decisions:** channel budget split; which campaigns to kill; CAC targets by channel.
- **Pain points:** ROAS disagrees with the ad platform; can't prove incrementality; CAC is a blended monthly average, useless for a weekly decision.
- **KPIs:** blended ROAS, CAC by channel, CM2-positive vs CM2-negative spend, new-customer count.
- **JTBD Brain must own:** *"Show me profit per channel after COGS+RTO, not vanity ROAS — at the grain I actually spend."*
- **Real marts:** `gold_cac` (via `cac.ts`, month-grain — **too coarse**), `blended-roas.ts`, `attribution-channel-roas.ts` / `attribution-campaign-roas.ts` (read `gold_marketing_attribution` — **~0 rows today**), `contribution-margin.ts`. **Gap:** CM2 is not yet joined to channel/campaign; CAC grain is monthly not channel×week.

### 3. Performance Marketer (the daily budget operator)
- **Daily workflow:** lives in Meta/Google Ads Manager all day; checks ROAS hourly; pauses/scales campaigns.
- **Key decisions:** pause this campaign / scale this one / shift budget — at campaign grain, daily.
- **Pain points:** Brain's recommendations fire at `subject='brand'` grain (all 4 detectors), useless for a campaign decision; attribution chart is empty on a fresh tenant.
- **KPIs:** ROAS, CPA, campaign-level spend, RTO rate on COD orders.
- **JTBD Brain must own:** *"Tell me which specific campaign to pause/scale today, and whether COD orders from it actually deliver."*
- **Real marts:** `silver_marketing_spend` (platform, campaign_id, stat_date — grain exists), `attribution-campaign-roas.ts`, `cod-rto-prediction.ts` (gokwik.rto_predict signal). **Gap:** detectors are brand-grain; must push to channel×campaign using columns already in `gold_marketing_attribution` + `silver_marketing_spend`.

### 4. Ecommerce Manager (operations of the storefront)
- **Daily workflow:** monitors orders, conversion funnel, abandoned carts, product performance.
- **Key decisions:** which product to push; where the funnel leaks; recover abandoned carts.
- **Pain points:** funnel is measured (`storefront-funnel.ts`) but stops there — no segmentation, no recovery action; abandoned-cart value is *quantified and then ignored* (`storefront-abandoned-cart.ts` exposes `abandonedValueMinor` with no recovery loop).
- **KPIs:** conversion rate by step, AOV, abandoned-cart recoverable GMV, top products.
- **JTBD Brain must own:** *"Show me where the funnel leaks and let me recover the carts worth recovering."*
- **Real marts:** `storefront-funnel.ts` (sessions→product.viewed→cart→checkout→purchase), `storefront-abandoned-cart.ts` (over `silver_checkout_signal`), `top-products.ts` (`silver_product`). **Gap:** no funnel segmentation by source/device/landing-path; no outbound recovery sink (no Klaviyo/SMS audience export).

### 5. Retention / Lifecycle Manager
- **Daily workflow:** builds win-back/replenishment flows; watches repeat rate and churn.
- **Key decisions:** when to trigger win-back; which segment to target; what acquisition path produces high-LTV customers.
- **Pain points:** Brain's "LTV" is `realized ÷ customers` (cohort-naive ARPU, `executive-metrics.ts`), not a forecast; "cohort retention" (`computeCohortRetention`) returns *avg lifetime orders*, **not a period-over-period N0/N1/N2 retention curve** — the code comment admits "per-month activity deferred to a richer cohort mart." There is no inter-purchase-interval feature.
- **KPIs:** repeat rate, second-order rate, time-to-second-order, predicted LTV, churn risk.
- **JTBD Brain must own:** *"Tell me who's about to lapse (by MY brand's reorder cadence), who's worth winning back, and push that audience to my CRM."*
- **Real marts:** `gold_cohorts` (acquisition aggregates only), `gold_customer_scores` (deterministic RFM + churn *band*, not ML), `feature_customer_daily` (PIT substrate — but no order-sequence timestamps). **Gaps (largest in the product):** (a) no true retention-curve mart; (b) no inter-purchase-interval / per-brand churn definition; (c) "LTV" label is misapplied to ARPU — rename or forecast.

### 6. Operations / Logistics Manager (India/COD-heavy — Brain's beachhead)
- **Daily workflow:** monitors RTO, COD delivery, courier performance, settlement reconciliation.
- **Key decisions:** which COD orders to flag/hold/verify pre-ship; which courier/pincode bleeds RTO.
- **Pain points:** **no Western competitor models this at all** — RTO eats 20-40% of COD margin and is invisible to Triple Whale/Klaviyo/Peel.
- **KPIs:** RTO rate, COD mix, delivered vs RTO terminal class, settlement gap.
- **JTBD Brain must own (the uncontested wedge):** *"Protect my margin from RTO — flag risky COD orders before they ship and show me net-of-RTO revenue."*
- **Real marts:** `silver_shipment` / `silver_shipment_event` (terminal_class via `@brain/logistics-status`), `cod-rto-rates.ts`, `cod-mix.ts`, `cod-rto-prediction.ts` (gokwik.rto_predict), `settlement-summary.ts`, and the `rto_risk` detector. **Gap:** `rto_risk` is brand-grain and recommend-only; needs a pre-ship order-level action written to `recommendation_action` (0082).

### 7. Customer Success Leader (Brain-internal + the buyer's renewal driver)
- **Daily workflow:** onboards new brands, watches activation, prevents churn.
- **Key decisions:** is this brand getting to first value; which recommendation can I get them to act on.
- **Pain points:** Brain's "data foundation first" principle risks "no value for the first two weeks"; not one recorded instance of a merchant acting on a recommendation and seeing a measured outcome.
- **KPIs:** time-to-first-trusted-value, recommendation action rate, outcome-measured wins, renewal.
- **JTBD Brain must own:** *"Get the brand one 'found-money' moment in session one, then close one recommendation→outcome loop."*
- **Real marts:** `data-foundation-health` BFF route, entitlements (`entitlements.ts`), `recommendation_outcome` (0045) + `recommendation_action` (0082). **Gap:** no packaged first-run "Money Found" screen; the action→outcome loop exists in schema but has never closed with a real user.

### 8. Marketing Analyst (mid-market, the technical evaluator)
- **Daily workflow:** builds custom reports, audits vendor numbers, defends data to leadership.
- **Key decisions:** do I trust this tool's numbers; can I drill to source; does it survive a tech eval.
- **Pain points:** competitors are black boxes (Northbeam "Meta drove 38%" with no derivation). Brain's `METRIC_REGISTRY` (single definition, parity-checked, `toleranceMinor=0`) is the antidote — but confidence grades (`attribution-confidence.ts`, `cost-confidence.ts`) are computed and **not surfaced in the UI**.
- **KPIs:** data freshness, confidence/reconciliation rate, metric consistency.
- **JTBD Brain must own:** *"Every number drills to a replayable Bronze event with a confidence grade and an as-of time."*
- **Real marts:** `METRIC_REGISTRY` (`registry.ts`), `attribution-reconciliation.ts`, `cost-confidence.ts`, `effective_confidence`. **Gap:** confidence + freshness not wired as a first-class UI badge; doc drift (silver_customers header still claims Neo4j mints brain_id when PG union-find is authoritative — fix before any tech eval).

---

## PART 2 — CANONICAL BUSINESS-QUESTION CATALOG (mapped to the REAL mart)

Each question is mapped to the metric-engine reader + underlying mart. ✅ = answerable today. ⚠️ = mart exists but data-starved or wrong grain. ❌ = no reader, must build.

### A. "Why did revenue change?"
| Question | Reader → Mart | Status |
|---|---|---|
| What's my realized (cash-true) revenue this period? | `realized-revenue.ts` → `gold_revenue_ledger` | ✅ |
| Provisional vs realized (recognition gap)? | `provisional-revenue.ts` + `recognition-breakdown.ts` → `gold_revenue_ledger` | ✅ |
| Revenue by month × lifecycle state? | `gold_revenue_analytics` | ⚠️ **orphaned — no reader wired**; either delete or surface |
| Does Brain's revenue reconcile to my Shopify/Razorpay payout? | `gold_revenue_ledger` + `realized_gmv_composition_as_of()` | ❌ **no reconciliation surface — top build** |
| Why is revenue ≠ orders (refunds/RTO/COD clawbacks)? | `recognition-breakdown.ts` + `silver_shipment` terminal_class | ✅ (data) / ❌ (no unified "delta-explained" view) |

### B. "Why is CAC up / which acquisition is efficient?"
| Question | Reader → Mart | Status |
|---|---|---|
| What's my CAC this month? | `cac.ts` → `gold_cac` | ⚠️ month-grain only — re-grain to channel×week off `silver_marketing_spend` |
| CAC by channel by week? | `silver_marketing_spend` (campaign_id, stat_date) | ❌ grain exists in data, not surfaced |
| What's my blended ROAS? | `blended-roas.ts` → `gold_revenue_ledger` + spend | ✅ |
| Which acquisition path produces high-LTV customers? | join `silver_order_line` (first product) × `silver_touchpoint` (first channel) × `gold_cohorts` | ❌ **LTV-Drivers mart not built — high-value, all inputs exist** |

### C. "Why did ROAS drop / where to spend next dollar?"
| Question | Reader → Mart | Status |
|---|---|---|
| ROAS by channel? | `attribution-channel-roas.ts` → `gold_marketing_attribution` | ⚠️ **~0 rows — reconcile not auto-triggered** |
| ROAS by campaign? | `attribution-campaign-roas.ts` → `gold_marketing_attribution` | ⚠️ same |
| Profit (CM2) per channel, not just ROAS? | `contribution-margin.ts` + channel attribution | ❌ CM2 not joined to channel |
| Is this channel incremental or just correlated? | — | ❌ **no holdout/incrementality** (`experimentation-holdouts` skill unbound) |
| Which attribution model credits this channel how? | `attribution-models.ts` (4 models, all looped in `reconcile-attribution.ts`) | ✅ (math) / ⚠️ (data-starved) |

### D. "Why are customers churning / not coming back?"
| Question | Reader → Mart | Status |
|---|---|---|
| What % of Jan cohort came back in Feb/Mar/Apr? | `computeCohortRetention` → `gold_cohorts` | ❌ **returns avg orders, NOT a retention curve — build `gold_retention_curve`** |
| What's my repeat rate? | `executive-metrics.ts` repeat fold → `gold_customer_360` | ✅ |
| When should I trigger win-back (median days to reorder)? | — | ❌ **no inter-purchase-interval feature** (needs order-sequence timestamps in `feature_customer_daily`) |
| Who is high churn-risk? | `customer-score.ts` → `gold_customer_scores` | ✅ deterministic RFM band (not ML; honest) |
| What's a customer worth (predicted LTV)? | `executive-metrics.ts` ltv | ⚠️ **cohort-naive ARPU mislabeled "LTV" — rename or forecast** |

### E. "Which products / customers / segments matter?"
| Question | Reader → Mart | Status |
|---|---|---|
| Top products by revenue/units? | `top-products.ts` → `silver_product` | ✅ |
| Customer 360 (LTV, orders, lifecycle)? | `customer-360.ts` → `gold_customer_360` | ✅ |
| Value-tier segments? | `gold_customer_segments` | ⚠️ no dedicated reader wired |
| Which customers to suppress (high-RTO COD)? | `cod-rto-prediction.ts` + `gold_customer_scores` | ✅ (data) / ❌ (no audience export) |

### F. "Where does the funnel leak / what carts to recover?"
| Question | Reader → Mart | Status |
|---|---|---|
| Storefront conversion funnel by step? | `storefront-funnel.ts` → `silver_touchpoint` | ✅ (but session denom undercounted — only ~23/94 carry brain_anon_id) |
| Funnel leak by source/device/landing? | `silver_touchpoint` (utm, page_type, landing_path) | ❌ **not segmented — build** |
| How much recoverable GMV in abandoned carts? | `storefront-abandoned-cart.ts` → `silver_checkout_signal` | ✅ measured / ❌ **no recovery action loop** |
| Checkout funnel (payment step)? | `checkout-funnel.ts` → `silver_checkout_signal` | ✅ |

### G. "What action should I take / did it work?" (the decision layer)
| Question | Reader → Mart | Status |
|---|---|---|
| What does Brain recommend? | 4 detectors → `recommendation` + `decision_log` (0044) | ⚠️ all `subject='brand'` — too coarse for channel/product action |
| Did the action I took work? | `recommendation_outcome` (0045) + `recommendation_action` (0082) | ⚠️ schema exists, loop never closed with a real user |
| Pre-ship: flag this risky COD order? | `rto_risk` detector + `cod-rto-prediction.ts` | ❌ brand-grain, no order-level pre-ship action |

### H. "Can I trust this number?" (cross-cutting — the Analyst's question on every tile)
| Question | Reader → Mart | Status |
|---|---|---|
| What's the confidence grade of this figure? | `attribution-confidence.ts`, `cost-confidence.ts`, `effective_confidence` | ✅ computed / ❌ **not surfaced in UI** |
| How fresh is the data? | `data-foundation-health` route, `FeatureStaleError` SLO | ✅ exists / ❌ not a first-class tile badge |
| What % of revenue does attribution cover? | `attribution-reconciliation.ts` (reconciliation_rate) | ✅ — use coverage honesty as the sales weapon |

---

## PART 3 — THE FOUR INITIATIVES THE CATALOG DEMANDS (ranked by leverage)

Every advisory council converged on the same ordering. Each initiative below answers brand-growth / Brain-growth / architecture-fit / changes / impact.

### Initiative 1 — Auto-trigger `reconcile-attribution.ts` + backfill (light up the empty marts)
- **Brand growth:** day-1 brands see real multi-touch ROAS by channel/campaign reconciled to revenue, not an empty chart — directly attacks Triple Whale's 15-25% discrepancy.
- **Brain growth:** activates 3 already-built registry metrics + `attribution-channel/campaign-roas.ts`; the #1 reason brands pay $129-379/mo becomes demoable. Honors Brain's own "no empty charts" law.
- **Architecture fit:** wire a consumer on `realized_revenue_ledger` finalization/reversal events (the `live-ledger-bridge` topology already exists) to call existing `reconcileAttribution`; add a one-time backfill job (Argo).
- **Changes:** event trigger + backfill; no new marts. Flip `gold_marketing_attribution`/`gold_attribution_paths` from ~0 rows to populated.
- **Impact:** converts the single biggest demo-killer; plausibly **+15-30% trial-to-paid** on attribution-led deals (the headline buy reason).

### Initiative 2 — Reconciliation Receipt + line-level CM2 (make the invisible moat visible)
- **Brand growth:** "Brain vs Shopify/Razorpay to the rupee, with the delta explained" + true net margin per order/channel after COGS/RTO — the number no competitor can produce.
- **Brain growth:** un-fakeable wedge; underwrites the %-of-GMV billing basis (a brand won't pay a fee on a basis it can't audit). Moves the buyer to the CFO.
- **Architecture fit:** new BFF view over `gold_revenue_ledger` + `realized_gmv_composition_as_of()` + `silver_shipment` terminal_class; wire `cost_input`/CM2 to `silver_order_line` grain.
- **Changes:** one reconciliation query + UI; extend `contribution-margin.ts` to line grain.
- **Impact:** trust is the conversion event; recovering/explaining even 5% of misattributed GMV pays the fee many times over. Estimated **+10-20% close rate** on CFO-led evals.

### Initiative 3 — Lead GTM from the RTO/COD beachhead (the only-option category)
- **Brand growth:** flag risky COD orders pre-ship; show net-of-RTO revenue and CAC. India D2C bleeds 20-40% of COD orders to RTO — survival, not a feature.
- **Brain growth:** uncontested wedge; price on demonstrable margin recovered (value-based, competitors can't even measure it). %-of-realized-GMV is *more* honest here (bills on delivered+paid cash).
- **Architecture fit:** all assets exist (`silver_shipment`, `cod-rto-rates.ts`, `cod-rto-prediction.ts`, `rto_risk` detector); push `rto_risk` to order grain, write pre-ship action to `recommendation_action` (0082).
- **Changes:** order-grain detector + pre-ship action surface; package as headline nav.
- **Impact:** even a few points of RTO reduction on a COD-heavy brand = large margin; **value-based pricing tier** unavailable to any Western incumbent.

### Initiative 4 — Confidence + Freshness as a first-class UI primitive
- **Brand growth:** never act on a stale/low-confidence number unknowingly — the white-space no rival occupies (vs Sidekick hallucinations, Triple Whale silent discrepancies).
- **Brain growth:** productizes the deterministic substrate (`attribution-confidence.ts`, `cost-confidence.ts`, `FeatureStaleError`) into an ownable category — "confidence before decisions."
- **Architecture fit:** substrate already computes grades; build one "trust badge" component (grade + as-of + drill-to-source) consumed across every BFF metric tile.
- **Changes:** UI primitive + thread confidence/freshness through existing BFF responses. Cheap, high differentiation.
- **Impact:** the trust lever that converts skeptical, black-box-burned buyers and reduces churn after the first wrong-looking number.

**Explicitly avoid (unanimous council):** training any ML model, agentic autopilot, Neo4j dual-write, Markov/Shapley attribution, and new gold marts — until the deterministic recommendation→action→measured-outcome loop closes with real brands and produces the outcome-labeled dataset that is the only honest license to train. `serveCustomerScore` must stop being called "inference" — it reads a deterministic Gold row.

---

# 4. Dashboard Requirements

*Brain Dashboard Requirements: 9 Decision-Grade Dashboards Grounded in Real Marts*

## Brain Dashboard Requirements — 9 Dashboards

**Grounding contract.** Every KPI below is a real `METRIC_REGISTRY` id (v1) from `packages/metric-engine/src/registry.ts` (21 ids verified: realized_revenue, provisional_revenue, ad_spend, blended_roas, cod_rto_rate, cod_mix, checkout_funnel, order_status_mix, journey_first_touch_mix, journey_stitch_rate, journey_timeline, attribution_credit, attribution_reconciliation_rate, attribution_confidence, cost_confidence, effective_confidence, aov, cac, ltv, repeat_rate, top_products, cohort_retention). Every widget names the real `gold_*`/`silver_*` mart powering it. The registry is the **sole Gold reader** via `withSilverBrand` (BRAND_PREDICATE injected) — the web UI never queries StarRocks directly; it goes through `apps/core` BFF (`bff.routes.ts`, ~85 routes). All money is BIGINT minor units + `currency_code`; ratios (AOV/LTV/CAC/RTO%/repeat/retention) are derived **at read** (ADR-004), never precomputed in dbt.

**Three cross-cutting rules enforced on every dashboard (from CLAUDE.md + advisory consensus):**
1. **No empty-chart state.** Every widget declares a populated fallback. Two marts are honestly data-starved today — `gold_marketing_attribution` and `gold_attribution_paths` are ~0 rows because `reconcileAttribution` (`apps/core/.../reconcile-attribution.ts`) is manual/Argo, not auto-triggered on finalization. **Prerequisite for the Attribution dashboard to ship without violating the no-empty rule: auto-trigger reconcile on `realized_revenue_ledger` finalization + a one-shot backfill.** Until then, attribution widgets render `withConfidence: Insufficient` and a "what's needed" CTA, never a blank chart.
2. **Confidence + freshness as a first-class badge on every tile.** Wire `attribution_confidence` (A/C/D = 1.000/0.700/0.400), `cost_confidence`, `effective_confidence`, and a data-foundation-health/freshness `as_of` from `/api/v1/dashboard/data-foundation-health`. This is the white-space no competitor occupies (Triple Whale 15-25% silent discrepancy; Sidekick hallucination).
3. **Drill-to-source on every number** (registry id → mart → row). Numbers never come from a model.

---

## 1. Founder Dashboard (`/dashboard`)
The "fire-my-other-tools" screen. Lead with the one un-fakeable thing: penny-reconciled, COD/RTO-aware truth.

| KPI (registry id) | Widget | Chart type | Mart + columns |
|---|---|---|---|
| `realized_revenue` | **Reconciliation Receipt** (headline) | Side-by-side bars + delta waterfall | `gold_revenue_ledger` (amount_minor signed, event_type, fee_minor, recognition_label, currency_code) vs platform payout |
| `cod_rto_rate`, `cod_mix` | RTO margin-leak gauge | Gauge + trend sparkline | `silver_shipment` (terminal_class rto/delivered, is_terminal), `gold_executive_metrics` (rto_orders, delivered_orders) |
| `blended_roas` | Blended ROAS tile | Single stat + 30d spark | `gold_revenue_ledger` (realized) ÷ `silver_marketing_spend` (spend_minor) |
| `aov`, `repeat_rate` | AOV / Repeat stat pair | Two stats | `gold_executive_metrics` (realized_value_minor, total_orders), `gold_customer_360` (lifetime_orders≥2 fold) |

- **Embedded insight:** "Shopify/Razorpay reported X; Brain's verified ledger shows Y; Δ = refunds + RTO clawbacks + COD non-delivery + fees" — drill each line to `gold_revenue_ledger.event_type`.
- **Recommended actions:** surface top firing detector from `recommendation` (registry.ts detectors: rto_risk, realization_gap, margin_erosion, scale_opportunity) as a one-click "Approve" writing to `ai_config.recommendation_action` (migration 0082) + `decision_log` (0044).
- **(a) Brand growth:** founder trusts ONE number, sees true net (after RTO/COGS) → fires the tool lying by 20%. **(b) Brain growth:** the reconciliation receipt is the sales demo and the basis that justifies %-of-realized-GMV billing (`gmv_meter_snapshot`, `billing_plan.rate_bps`). **(c) Fit:** pure read over `gold_revenue_ledger` + `silver_shipment`, no new infra. **(d) Changes:** new "reconciliation receipt" BFF query + payout-import seam (Shopify/Razorpay). **(e) Impact:** reconciliation explaining even 3-5% misattributed GMV self-justifies the fee; the single highest trial-to-paid lever.

---

## 2. Executive Dashboard (`/dashboard` exec view)
For the person signing the check — CFO-grade, margin-true, not performance-marketer turf.

| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `realized_revenue` vs `provisional_revenue` | Recognized-vs-provisional | Stacked area | `gold_revenue_ledger` (event_type, recognition_label, amount_minor) |
| `cac` | CAC by acquisition month | Bar (month grain) | `gold_cac` (new_customers, acquisition_spend_minor, acquisition_month, currency_code) |
| `ltv` (**relabel to "Realized value/customer (ARPU)"**) | Value-per-customer | Stat + cohort split | `gold_executive_metrics` (realized_value_minor / distinct_customers) |
| CM2 (sole-emitter `contribution-margin.ts`) | Contribution margin after COGS | KPI + channel breakdown | `silver_order_line` (unit_price_minor, line_discount_minor) + `cost_input` (0055) + `gold_revenue_ledger` + `silver_marketing_spend` |
| `cost_confidence`, `effective_confidence` | Trust badge | Badge | confidence grades from registry |

- **Embedded insight:** "Net contribution after COGS/shipping/RTO/refunds — channels CM2-negative are flagged." This is what Klaviyo (gross), Triple Whale (gross), Peel (descriptive) structurally cannot show.
- **Action:** `margin_erosion` detector → "Review CM2-negative spend."
- **Honesty fix (advisory):** the `ltv` registry id is cohort-naive realized÷customers; **rename in UI to ARPU** to avoid losing a head-to-head vs Lifetimely's forecasted LTV.
- **(a)** brand reallocates from CM2-negative channels → profit lift. **(b)** moves the buyer to finance (higher-authority budget). **(c)** CM2 reader exists (`contribution-margin.ts`); just needs line-grain cost wiring. **(d)** wire `cost_input` to `silver_order_line` grain. **(e)** profit-true reallocation is the cleanest renewal/expansion ROI story.

---

## 3. Marketing Dashboard (`/analytics/spend`, `/analytics/revenue`)
Re-grain to where the budget owner actually decides: **channel × campaign × week**, not brand × month.

| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `ad_spend` | Spend by platform/campaign | Stacked bar (weekly) | `silver_marketing_spend` (platform meta/google_ads, campaign_id, spend_minor, stat_date, impressions, clicks) |
| `blended_roas` | ROAS trend | Line | `gold_revenue_ledger` ÷ `silver_marketing_spend` |
| `cac` (re-grained) | CAC by channel × week | Heatmap/bar | `gold_cac` re-grained off `silver_marketing_spend.campaign_id/stat_date` |
| CM2-by-channel | Profit-per-spend-unit | Diverging bar (pos/neg) | CM2 + channel from `gold_marketing_attribution.channel` |

- **Embedded insight:** "Stop optimizing to vanity ROAS — these campaigns are CM2-negative."
- **Action:** new **budget-reallocation detector** ("shift $X Google→Meta"), confidence-gated, writing to `recommendation_action`. Approve-loop (Copilot), never autopilot.
- **(a)** decisions land at the lever pulled (campaign budget) at the cadence decided (weekly). **(b)** ties Brain to spend efficiency → fee looks like a rounding error → expansion. **(c)** re-grain of existing `gold_cac` + `silver_marketing_spend`; same detector pattern. **(d)** add channel/campaign grain to `gold_cac`; new detector. **(e)** workflow-embedded decision-grain tooling is the seat that survives budget cuts.

---

## 4. Customer Dashboard (`/identity/customer-360`, `/analytics/customer`)
Two real surfaces — keep distinct: identity control-plane `getCustomer360` (PG `customer`/`identity_link`/`identity_merge_event`) vs analytics `getCustomer360Summary` (`gold_customer_360`).

| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `ltv`/ARPU, `repeat_rate` | Customer LTV + lifecycle | Stat row | `gold_customer_360` (lifetime_orders, lifetime_value_minor, delivered/rto/cancelled/refunded_orders) |
| `gold_customer_scores` (RFM, **not registry**) | RFM + churn band | 3×3 RFM matrix + churn donut | `gold_customer_scores` (recency_score, frequency_score, monetary_score 1-5, churn_risk low/med/high) |
| segments | Value-tier segments | Treemap | `gold_customer_segments` (segment, customer_count, segment_value_minor) |
| identity | Merge history + linked ids | Timeline | PG `identity_link` (hash prefix 12-char), `identity_merge_event` (deterministic merge_id) |

- **Embedded insight:** "RFM is deterministic rule-based (not ML) — explainable, auditable." Show *why* two profiles merged (PG union-find, migration 0017) — Segment Unify / Rudder Profiles can't.
- **Action:** **outbound audience-activation sink** — publish a Brain segment ("high-RFM + low-RTO-risk + lapsing") to Klaviyo lists / Meta Custom Audiences via `decision_log` + `recommendation_action`. This closes the insight→action loop.
- **(a)** brand acts on a margin-true, RTO-aware, identity-deduped segment inside the CRM it already runs. **(b)** raises switching cost (rip out Brain → audiences go dark); positions Brain as the brain, Klaviyo as the mouth. **(c)** uses `gold_customer_360`/`gold_customer_scores` + identity graph; reverse-ETL is net-new. **(d)** build the outbound audience connector (CAPI passback exists; messaging-plane sink does not). **(e)** activation converts "nice dashboard" → renewed contract + per-activation expansion.

---

## 5. Retention Dashboard (`/analytics/cohorts` — **needs a new mart first**)
**Critical honesty gap (advisory, verified):** `gold_cohorts` is an acquisition-cohort *aggregate* (cohort_size, lifetime_orders, cohort_value) and `computeCohortRetention` returns **avg lifetime orders**, NOT an N0/N1/N2 repurchase curve (code comment admits "per-month activity deferred to a richer cohort mart"). Do **not** ship this under a "retention" label until the curve exists.

| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `cohort_retention` (as real curve) | Retention triangle | N0/N1/N2 heatmap triangle | **NEW `gold_retention_curve`** (brand_id, cohort_month, period_index, retained÷cohort_size) built from `silver_order_state` order timestamps |
| inter-purchase clock | Median days-to-2nd-order | Histogram + per-brand line | **NEW** order-sequence feature on `feature_customer_daily` (median/p75 days-to-next-order) |
| `repeat_rate` | 2nd-order rate | Stat | `gold_customer_360` (lifetime_orders≥2) |
| cohort value | Cohort LTV ramp | Line per cohort | `gold_cohorts` (cohort_value_minor, cohort_size) |

- **No-empty rule:** grey out cohort cells below N customers, show per-cell maturity/confidence — a trust differentiator Peel/Lifetimely skip.
- **Action:** per-brand empirical churn ("median reorder 47d; customer at 70d is lapsing") → win-back trigger to audience sink. Do **not** use a global 30/60/90 window.
- **(a)** answers "do customers come back, and when" — drives replenishment/win-back timing. **(b)** the retention triangle is the most-screenshotted demo artifact; prerequisite that makes LTV + lifecycle tiers sellable. **(c)** new mart from already-landed `silver_order_state` timestamps; sibling of `feature_customer_daily`. **(d)** build `gold_retention_curve` + inter-purchase feature. **(e)** correctly-timed flows lift repeat-rate → attributable renewal/expansion. **Do NOT layer ML LTV/churn until this lands** — a model on lifetime_orders + days_since_last alone just memorizes recency.

---

## 6. Product Dashboard (`/analytics/orders`, merchandising)
| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `top_products` | Top SKUs by revenue/units | Ranked bar | `silver_product` (product_key, units_sold, gross_revenue_minor, discount_minor) |
| `order_status_mix` | Order lifecycle mix | Stacked bar | `gold_revenue_analytics` (lifecycle_state, order_count) — **note: this mart is orphaned, no reader; wire it here** |
| line economics | Margin per product | Table | `silver_order_line` (unit_price_minor, line_total_minor, line_discount_minor) + `cost_input` |
| **LTV Drivers** | Best-acquisition-path | Ranked lift table | join `silver_order_line` (first product) × `silver_touchpoint` (first channel) × `gold_cohorts` (cohort value) |

- **Embedded insight (advisory):** "Customers whose first product is X via paid_Google are worth 2.3×" — the single most-acted-on retention report; the join exists in pieces, nobody assembled it.
- **Action:** flag deep-discount / high-RTO SKUs (`silver_shipment.terminal_class` joined to `silver_order_line.product_id`).
- **(a)** reallocates acquisition spend toward high-LTV product/channel paths. **(b)** lights up orphaned `gold_revenue_analytics`; LTV-Drivers differentiates from Lifetimely (real journeys, not imported CAC). **(c)** all source marts exist; needs one new join mart. **(d)** build LTV-Drivers Gold mart; wire `gold_revenue_analytics` reader. **(e)** immediate "moved $X spend, LTV rose" outcome anchors renewal.

---

## 7. Funnel Dashboard (`/analytics/funnel`, `/analytics/abandoned-cart`)
| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `checkout_funnel` | Storefront funnel | Funnel chart | `silver_touchpoint` via `computeStorefrontFunnel` (sessions→product.viewed→cart.item_added→checkout.started→purchased) |
| segmented funnel | Drop-off by source/device | Small-multiples funnel | `silver_touchpoint` (utm.*, page_type, landing_path) |
| recoverable GMV | Abandoned-cart at-risk | Stat + trend | `silver_checkout_signal` (signal_type, total_price_minor, has_address; shopflo.checkout_abandoned) |
| RTO risk pre-purchase | High-RTO-risk carts | Gauge | `silver_checkout_signal` (risk_flag high/med/low; gokwik.rto_predict) |

- **No-empty / coverage caveat (verified):** only touches WITH `brain_anon_id` sessionize (~23/94 in dev); NULL-anon dropped. **Gate the funnel UI with a coverage/confidence indicator** so an undercounted denominator never produces false "improvements." First-party/server-side pixel (Phase H CNAME host) is the prerequisite.
- **Action (highest-leverage closeable loop):** **abandoned-cart recovery** — turn recoverable-GMV-at-risk into a consent-gated audience/trigger to an outbound channel, attributed back to `gold_revenue_ledger`. Pair the biggest-leak funnel step with a one-click A/B test (`experimentation-holdouts`).
- **(a)** recovers revenue currently only measured, not captured (Klaviyo/Postscript value, but margin-aware). **(b)** recovered-cart GMV flows through the very ledger Brain bills on → Brain's recovery feature increases its own fee base; proves "action + measured lift." **(c)** `silver_checkout_signal` already quantifies the money; needs outbound sink + attribution write-back. **(d)** wire recovery trigger + lift measurement. **(e)** the cleanest first end-to-end action loop; lift measurable against the ledger.

---

## 8. Attribution Dashboard (`/analytics/attribution`) — **gated on reconcile auto-trigger**
**Blocker (verified):** `gold_marketing_attribution` and `gold_attribution_paths` are ~0 rows. Ship-gate = auto-fire `reconcileAttribution` on finalization + backfill, else this dashboard violates the no-empty law on day one.

| KPI | Widget | Chart | Mart + columns |
|---|---|---|---|
| `attribution_credit` | Channel/campaign credit | Stacked bar | `gold_marketing_attribution` (channel, campaign_id, credited_revenue_minor, row_kind) |
| `journey_first_touch_mix` | First-touch channel mix | Donut | `silver_touchpoint` via `computeFirstTouchMix` |
| `journey_stitch_rate` | Stitch coverage | Stat + honesty bar | `silver_touchpoint` (stitched_order_id null=unstitched) |
| `attribution_reconciliation_rate` | Credited vs realized | Gauge | `gold_marketing_attribution` vs `gold_revenue_ledger` |
| paths | Channel-path spine | Sankey | `gold_attribution_paths` (channel_path, first/last_touch_channel, touch_count) |
| `attribution_confidence` | Per-row A/C/D grade | Badge column | `gold_marketing_attribution.confidence_grade` |

- **Embedded insight (advisory honesty):** "This is deterministic **allocation** (4 models: first/last/linear/position_based), not causal **measurement**. Confidence grades STITCH quality, not causality. Coverage = 41% of revenue; 59% unmatched." Show the **4-model spread side-by-side** (reconcile already loops all 4) — Rockerbox claims transparency but doesn't deliver this.
- **Action:** budget-reallocation rec sourced from populated credit ledger; **incrementality/geo-holdout primitive** on the immutable Bronze (the upmarket wedge vs Northbeam) written to `decision_log`.
- **(a)** real multi-touch credit reconciled to verified revenue (vs Triple Whale's 15-25% gap). **(b)** activates 3 already-built registry metrics + channel/campaign ROAS computers from dormant to demoable. **(c)** code-complete marts; only the trigger is missing. **(d)** auto-trigger + backfill; later add holdout. **(e)** attribution is the #1 reason brands pay $129-1,500/mo — but **do NOT build Markov/Shapley** (no causal validation = inherit the GA4-disagreeing-black-box trap). Incrementality first, fancier allocation never.

---

## 9. AI / Decisions Dashboard (`/recommendations`, `/ml`, `/ask`)
Deterministic-first is the **product**, not an apology — the antidote to Sidekick hallucination + inflated attribution.

| KPI / object | Widget | Chart | Mart + columns |
|---|---|---|---|
| recommendations | Firing detectors | Card list + confidence gate | `recommendation` + `decision_log` (0044); detectors rto_risk/realization_gap/margin_erosion/scale_opportunity |
| outcomes | Rec → action → measured lift | Before/after bars | `recommendation_outcome` (0045) + `ai_config.recommendation_action` (0082) |
| models | Registry + lifecycle | Table | `ml.model_registry` (stage, framework, version) — seeded customer_churn_rfm v0-deterministic |
| serving | Score served | Stat | `ml.prediction_log` (partitioned); `serveCustomerScore` reads `gold_customer_scores` |
| Ask Brain | NL query | Chat + cited answers | registry-grounded only (registry id → value, never model-generated numbers) |

- **Embedded insight:** every recommendation carries confidence (Trusted/Estimated/Insufficient via `confidence-gate.ts`) + drill-to-source.
- **Action:** **close one rec→action→outcome→learning loop** end-to-end (start rto_risk or margin_erosion): merchant approves, action logs to `recommendation_action`, outcome measured, before/after shown — feed measured outcomes as labels into `feature_customer_daily`. This generates the **only honest license to train a model later.**
- **Ask Brain guardrail:** model orchestrates registry calls and narrates; it never invents a figure — wins the "why not free Sidekick" objection.
- **(a)** recommendations become acted-upon decisions with measured lift (the "so what / now what" Peel/Daasity/Shopify never deliver). **(b)** outcome-labeled dataset is the prerequisite for any paid predictive feature; lets Brain price on demonstrated lift, not promised dashboards. **(c)** detectors + `decision_log` + `recommendation_outcome` + ledgers all exist; the gap is the human-facing loop, not schema. **(d)** auto-run detectors on schedule; build approve→measure UI; one consumer must finally call `RedisOnlineStore.get()` (online store is write-only today). **(e)** measured saved-rupee per merchant is the expansion lever + testimonial engine. **Do NOT ship a churn/LTV ML model first** — no eval harness gates a learned metric (eval gate exempts deterministic), and a black-box model now forfeits the trust differentiator.

---

## Build sequence (advisory-unanimous priority)
1. **Reconciliation Receipt** (Founder/Exec) — visible truth moat, no new infra.
2. **Auto-trigger `reconcileAttribution`** — unblocks Attribution + lights up 3 registry metrics, honors no-empty law.
3. **Confidence/freshness badge** primitive across all 9 — cheap, ownable category ("confidence before decisions").
4. **One closed action loop** — abandoned-cart recovery (Funnel) OR one rec→outcome (AI) — first proof of value + first GMV-base lift.
5. **`gold_retention_curve` + inter-purchase feature** — fixes the mislabeled-retention foundation before any LTV/lifecycle tier.
6. CM2-by-channel + re-grained CAC (Exec/Marketing); LTV-Drivers + wire orphaned `gold_revenue_analytics` (Product).

**Explicitly do NOT, before the above ship:** train ML models; build Markov/Shapley attribution; build autonomous autopilot write-back; add new gold marts beyond `gold_retention_curve` + LTV-Drivers; turn on Neo4j (PG union-find is the authoritative identity graph — own that story and fix the `silver_customers.sql` doc drift that still claims Neo4j mints brain_id).

---

# 5. Insight, Recommendation & Opportunity Engines

*Brain Decision Intelligence: Insight, Recommendation & Opportunity Engines (deterministic-first, grounded in real marts)*

## TL;DR (the skeptical version)

Brain already has the only honest, penny-reconciling decision spine in the category, and three-quarters of these "engines" are an **extension of code that exists** — not a greenfield build. The real `Detector` interface (`apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts`), the money-weighted `priority` ordinal (0–1000), the `confidence-gate.ts` ceiling/hold logic, the `recommendation` + `decision_log` (0044) + `recommendation_outcome` (0045) + `recommendation_action` ledger (0082), and the deterministic SQL signal functions (`rto_risk_signal_for_brand`, `realization_signal_for_brand`, `cm2_signal_for_brand`) are all live and tested.

What is missing is **not** ML. It is: (1) detectors at the **wrong grain** (all `subject='brand'`; none at channel/campaign/product/customer), (2) a **trend/anomaly time-axis** (every detector reads a single point-in-time signal — no baseline, no severity from deviation), (3) **$-impact as a first-class, formula-bound field** (today `priority` is a 0–1000 ordinal; the ₹ figure only lives in `evidence`), and (4) the **opportunity surfaces that already quantify lost money but do nothing** — `silver_checkout_signal.abandonedValueMinor` and the data-starved `gold_marketing_attribution`.

The unanimous council verdict applies directly: **do not build trained models; make the deterministic loop close and quantify, at the grain where money moves.** Everything below is deterministic-first over real marts, with an explainability contract that drills to source, and a single shared `$ impact` formula so Insight → Recommendation → Opportunity are one engine viewed three ways.

---

## Shared foundation: one scoring + explainability contract across all three engines

All three engines emit the same core record so the UI, the `decision_log`, and outcome measurement are uniform. This generalizes the existing `DetectorRecommendation` shape.

```
Finding {
  finding_id            -- deterministic: sha256(brand_id‖detector‖subject_type‖subject_key‖period)
  brand_id, subject_type ('brand'|'channel'|'campaign'|'product'|'customer'|'cohort'), subject_key
  engine                ('insight'|'recommendation'|'opportunity')
  detector              -- registered detector id
  kind                  ('anomaly'|'trend'|'risk'|'opportunity')
  severity              -- 0..1, from deviation magnitude vs baseline (see formula)
  priority              -- existing 0..1000 ordinal = severity × $impact rank (money-weighted)
  impact_minor          -- BIGINT minor units + currency_code  ← FIRST-CLASS, formula-bound
  impact_basis          -- enum naming the exact formula used (auditable)
  confidence            -- 'Trusted'|'Estimated'|'Insufficient' AFTER applyConfidenceGate()
  held, held_reason     -- from confidence-gate.ts
  explanation           -- the contract below
}
```

**Explainability contract (mandatory on every finding — the anti-Sidekick/anti-Northbeam wedge):**
1. `what` — the metric and its value (always a `METRIC_REGISTRY` id from `packages/metric-engine/src/registry.ts`, never a model output).
2. `baseline` — the comparison value + window (e.g. trailing-28d median) and the source mart row.
3. `why` — the deterministic rule that fired (threshold + observed deviation), in plain language.
4. `evidence` — exact figures with `drill_to_source`: mart name + grain key (e.g. `gold_revenue_ledger` rows for this `subject_key`).
5. `confidence + freshness` — the gated confidence grade and the `as_of`/watermark of the underlying mart, wired from `data-foundation-health` + `effective_confidence`.
6. `impact_basis` — the named `$ impact` formula and its inputs (so the ₹ number is reproducible by hand).

**Rule (enforced):** numbers come only from the metric registry / Gold marts via `withSilverBrand`; the only thing the engine "decides" is which deterministic rule fired and how to rank it. This keeps cost on the `deterministic ≫ ML` tier (`cost-routing-paradigms`) and keeps every figure auditable — the exact trust gap Triple Whale (15–25% Shopify discrepancy) and Klaviyo (gross self-attribution) cannot close.

---

## How `$ impact` is computed (deterministic formulas per detector — no estimates dressed as facts)

`impact_minor` is **always a recoverable/at-risk figure already present in a mart**, never a forecast multiplier. `impact_basis` names the formula:

| impact_basis | Formula (all minor units) | Source mart |
|---|---|---|
| `rto_gmv_at_risk` | `rto_gmv_minor` over window | `silver_shipment` (terminal_class='rto') → `rto_risk_signal_for_brand` |
| `unsettled_provisional` | `provisional_minor − realized_minor` | `gold_revenue_ledger` → `realization_signal_for_brand` |
| `cm2_loss` | `−CM2` when CM2<0 (loss); else `0` | `cm2_signal_for_brand` (cost_input 0055/0056) |
| `cm2_scale_headroom` | `(margin − threshold) × marketing_minor` | `cm2_signal_for_brand` + `silver_marketing_spend` |
| `abandoned_recoverable` | `Σ abandonedValueMinor` (no later order for that brain_id) | `silver_checkout_signal` (shopflo.checkout_abandoned) |
| `channel_cm2_negative` | `−CM2_channel` for channels where credited-revenue − spend − COGS < 0 | `gold_marketing_attribution` × `silver_marketing_spend` |
| `winback_value_at_risk` | `lifetime_value_minor` of customers past per-brand p75 inter-purchase interval | `gold_customer_360` + `gold_customer_scores` |
| `lost_repeat_revenue` | `(brand_repeat_rate − cohort_repeat_rate) × cohort_size × cohort_AOV` | `gold_cohorts` + `gold_executive_metrics` |

**Severity** (drives the Insight engine, additive to the existing money ordinal):
`severity = clamp(|observed − baseline| / max(baseline, floor), 0, 1)`, where baseline = trailing-window median from the **history/snapshot marts that already exist** — `snap_order_state`, `snap_attribution_credit`, `feature_customer_daily`. **This is the one genuinely new primitive**: today every detector reads a single signal row; the Insight engine needs a baseline, and Brain already lands daily snapshots to compute it without a model.

---

## ENGINE 1 — INSIGHT ENGINE (anomaly / trend / risk / opportunity, scored)

**What it is:** a scheduled deterministic scan that compares each subject's current registry metric to its own trailing baseline (from the snapshot marts), classifies the deviation as anomaly/trend/risk/opportunity, and scores severity × $impact × confidence.

- **(a) Brand growth:** the brand sees "your RTO rate on COD jumped from 22% (28d median) to 34% this week — ₹4.1L at risk" with drill-to-source — the 9am-Monday "what changed" answer that free Shopify Sidekick *hallucinates* and Triple Whale presents without confidence. Anomalies on spend, realized revenue, RTO, checkout-conversion, and CM2 catch silent leaks before month-end.
- **(b) Brain growth:** activates the snapshot marts (`snap_order_state`, `feature_customer_daily`) that are currently write-only history; makes "confidence + freshness as first-class" a *visible* product (the white-space no competitor occupies); generates the daily-active surface that predicts renewal.
- **(c) Architecture fit:** new bounded context `apps/core/src/modules/insight/` mirroring the recommendation module's DDD layout. Reads Gold/snapshot marts **only via the metric-engine `withSilverBrand` seam** (no direct StarRocks from the BFF). Runs as an Argo `CronWorkflow` (the same `pipeline-orchestration` seam the recommendation detectors already use). Writes to `decision_log` (create-before-display).
- **(d) Changes required:**
  1. Add a `baselineSignal()` method to the `Detector` interface that reads the snapshot mart for the trailing window (additive — existing detectors return null baseline → no anomaly classification, fully backward-compatible).
  2. New severity scorer (pure function, unit-tested like the existing detectors).
  3. New `gold_metric_daily` mart **only if** snapshot marts lack a needed grain — prefer reusing `snap_order_state`/`feature_customer_daily` first (avoid the "stop adding marts" anti-pattern; `gold_revenue_analytics` is already orphaned).
  4. `/api/v1/insights` BFF route + an Insights feed UI (every build ships UI).
- **(e) Impact range:** insight feeds with anomaly alerting are the documented activation lever (Sidekick Pulse is shipping it for $0; Lifetimely's "AI Profit Agent" sells on it). Realistic effect: **+15–30% trial→paid conversion** by collapsing time-to-first-"aha", and a **2–4× lift in weekly-active sessions** (the strongest retention predictor in this category). Low new-build cost (reuses detector + snapshot substrate).

---

## ENGINE 2 — RECOMMENDATION ENGINE (what / why / do-what / expected-impact / confidence)

**What it is:** the existing engine, re-grained and quantified. It already produces what/why/do-what (`payload.title/summary/recommended_action/evidence`) and confidence-gates them. The two real gaps the council hammered: **grain** (all `subject='brand'`) and **$-impact as a ranked, formula-bound field** (today it's a 0–1000 ordinal).

- **(a) Brand growth:** recommendations land where money actually moves — "**Pause campaign `X`: CM2-negative at −₹62k/28d** (gross ROAS 2.1 looks fine, but after COGS + RTO it loses money)" or "**Hold these 14 high-RTO-risk COD orders for address verification — ₹38k at risk**". This is the profit-truth-by-channel that Klaviyo (no COGS), Triple Whale (gross), and Peel (descriptive) structurally cannot compute.
- **(b) Brain growth:** moves Brain from descriptive (Peel/Daasity tier) into the action loop where stickiness + expansion live; closes recommend→approve→action→outcome using the *already-built* `recommendation_action` ledger (0082) and `measure-recommendation-outcomes.ts`; generates the outcome-labeled dataset that is the **only honest license to train a model later**.
- **(c) Architecture fit:** *no new architecture* — add detector entries to `DETECTORS` in `registry.ts` and push their `subject` to channel/campaign/product/customer. The `fetchSignal` for new detectors reads `gold_marketing_attribution` (channel/campaign_id) and `silver_marketing_spend` (already has campaign_id, spend_minor, stat_date) and `silver_product` (units_sold, gross_revenue, discount). Confidence-gate and outcome measurement are reused verbatim.
- **(d) Changes required:**
  1. New detectors: `channel_budget_reallocation`, `campaign_cm2_negative` (both `subject='channel'`/`'campaign'`), `product_margin_leak` (`subject='product'`). Each is a pure function + a SQL signal fn mirroring `cm2_signal_for_brand`.
  2. **Promote `impact_minor` to a first-class detector output** (formula-bound per the table above) and make `priority = f(severity, impact_minor)` so ranking is money-weighted *and* deviation-weighted — currently `priority` alone carries ordering and the ₹ value hides in `evidence`.
  3. **One-click "approve action"** Copilot loop: approving writes a drafted action to `recommendation_action` (0082) with human approval — **not** autonomous (avoid the Moby-Autopilot trap on a deterministic stack; auditable > autonomous).
  4. **Prerequisite:** auto-trigger `reconcileAttribution` on `realized_revenue_ledger` finalization so `gold_marketing_attribution` is **not ~0 rows** — channel/campaign detectors cannot fire on empty marts (honor "no empty charts").
- **(e) Impact range:** channel/campaign-grain recs tied to CM2 are the seat that survives budget reviews. Reallocating spend from CM2-negative to CM2-positive channels is direct profit lift the brand attributes to Brain: **+5–15% blended contribution margin** for a brand with material CM2-negative spend, and an **expansion vector** (priced on demonstrated lift, not seats). RTO-hold recs recover **3–8% of COD GMV** for COD-heavy (India) brands — the uncontested beachhead no Western incumbent touches.

---

## ENGINE 3 — OPPORTUNITY ENGINE (lost revenue, abandoned/high-value customers, upsell/cross-sell/retention/campaign/product with $ impact)

**What it is:** the engine that converts already-quantified-but-inert money into ranked, actionable opportunities. The council's single sharpest "build this first": `silver_checkout_signal.abandonedValueMinor` *already computes recoverable GMV at risk and does nothing with it* — the inverse of Brain's own "no empty charts" law.

| Opportunity detector | Source marts | $ impact (impact_basis) |
|---|---|---|
| **Abandoned-cart recovery** | `silver_checkout_signal` (shopflo.checkout_abandoned: abandonedValueMinor, has_address, discountApplied) | `abandoned_recoverable` — Σ abandoned value with no later order for that brain_id |
| **High-value lapsing customers (retention)** | `gold_customer_360` + `gold_customer_scores` (RFM/churn band) + per-brand inter-purchase interval | `winback_value_at_risk` — LTV of customers past brand's own p75 reorder interval |
| **Cross-sell / upsell** | `silver_product` + `silver_order_line` (market-basket co-occurrence, deterministic) | incremental AOV of co-purchased SKUs the customer hasn't bought |
| **Product margin leak / discount drag** | `silver_product` (discount_minor vs gross_revenue_minor) | margin recovered by trimming over-discounted SKUs |
| **Channel scale opportunity** | existing `scale_opportunity` detector (cm2_signal) | `cm2_scale_headroom` |
| **Lost repeat revenue (cohort)** | `gold_cohorts` + `gold_executive_metrics` repeat_rate | `lost_repeat_revenue` — gap vs best cohort |

- **(a) Brand growth:** recovers money already measured but un-captured — abandoned carts (Klaviyo/Postscript monetize exactly this), high-LTV customers about to churn (timed to the brand's *own* reorder cadence, not a generic 90-day rule), and CM2-aware cross-sell. The opportunity list is ranked by `impact_minor`, so the brand acts on the biggest ₹ first.
- **(b) Brain growth:** **recovered-cart GMV flows through the very `gold_revenue_ledger` Brain bills %-of-GMV on** — Brain's recovery feature literally grows the base its fee is charged against (cleanest net-revenue-retention story in the category). Closes the first true action→outcome loop on data that already exists; the outbound **audience-activation sink** (publish a Brain segment to Klaviyo/Meta Custom Audiences via the `outbound-channels`/`integration-connectors` seams, logged to `decision_log`) makes Brain the brain and Klaviyo the mouth — indispensable to a brand already paying Klaviyo.
- **(c) Architecture fit:** opportunity detectors register in the **same** `DETECTORS` registry (`kind='opportunity'`), read the marts above via `withSilverBrand`, and write to `recommendation` + `recommendation_action`. The market-basket cross-sell is a deterministic co-occurrence query over `silver_order_line` — no ML. Activation is a new connector path, not a new sending system (be the audience source, not the channel).
- **(d) Changes required:**
  1. Opportunity detector functions + SQL signal fns (abandoned-recovery, lapsing-LTV, market-basket).
  2. **Inter-purchase-interval feature** added to `feature_customer_daily` (or a sibling) from `silver_order_state` order timestamps — the prerequisite for per-brand churn definition and win-back timing (today `feature_customer_daily` has `days_since_last_order` but no order-sequence interval).
  3. Outbound audience sink connector (Klaviyo list / Meta Custom Audience), consent-gated, audited.
  4. `/api/v1/opportunities` + Opportunity UI ranked by `impact_minor` with recovery-attributed-back-to-ledger.
- **(e) Impact range:** abandoned-cart recovery alone typically converts **5–12% of at-risk GMV** (industry-standard recovery flow rates) — directly additive to billed GMV. High-value win-back on correctly-timed cohorts lifts **repeat-rate 2–5pts**. Combined, the opportunity engine is the most defensible **expansion + renewal** driver because every recovered rupee is attributable to Brain against the deterministic ledger.

---

## Build sequence (skeptical, dependency-ordered — do not parallelize the foundation)

1. **Auto-trigger `reconcileAttribution`** on finalization + backfill → kills the ~0-row attribution problem (prerequisite for channel/campaign recs; honors "no empty charts").
2. **Promote `impact_minor` to first-class** + the shared `Finding`/explainability contract (cheap, unblocks all three engines' ranking + UI).
3. **Opportunity Engine — abandoned-cart recovery first** (data already quantified in `silver_checkout_signal`, flows through the billing ledger, lift is measurable) → the fastest end-to-end action→outcome proof.
4. **Recommendation Engine re-grain** to channel/campaign/product + one-click approve loop.
5. **Insight Engine** baseline/anomaly layer over snapshot marts (needs the contract + grain from steps 2–4).

**Explicitly avoid** (per the councils): no trained ML model until the deterministic action→outcome loop produces labeled outcomes; no autonomous Autopilot write-back; no 5th/6th attribution model (incrementality before fancier allocation); no new gold marts where snapshot marts suffice; do not flip `ledger_source` to Iceberg-default until the dbt-StarRocks incremental-CTAS bug is resolved.

---

## Files this touches (real paths)

- `apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts` — add detectors, re-grain `subject`, promote `impact_minor`.
- `apps/core/src/modules/recommendation/internal/domain/confidence-gate.ts` — reused verbatim across all three engines.
- `apps/core/src/modules/recommendation/internal/application/{generate-recommendations,measure-recommendation-outcomes,record-recommendation-action}.ts` — extend for opportunity/insight engines + approve loop.
- New: `apps/core/src/modules/insight/` (DDD-mirrored), `apps/core/src/modules/opportunity/`.
- `packages/metric-engine/src/registry.ts` + `withSilverBrand` readers — sole Gold-read seam for all signals.
- Marts read: `silver_checkout_signal`, `gold_marketing_attribution`, `silver_marketing_spend`, `silver_product`, `silver_order_line`, `gold_customer_360`, `gold_customer_scores`, `gold_cohorts`, `gold_revenue_ledger`, `silver_shipment`; baselines from `snap_order_state`, `feature_customer_daily`.
- Ledgers: `recommendation` + `decision_log` (0044), `recommendation_outcome` (0045), `recommendation_action` (0082).
- Signal SQL: `rto_risk_signal_for_brand`, `realization_signal_for_brand`, `cm2_signal_for_brand` (0056) + new channel/campaign/product/abandoned/lapsing signal fns.
- Orchestration: Argo `CronWorkflow` (pipeline-orchestration seam).


---

# 6. AI Copilot & Decision Engine

*Brain AI Copilot & Decision Engine — A Grounded Build Plan on the Existing Stack*

## TL;DR (the load-bearing facts before any plan)

Brain has **already built the hard, expensive half** of an AI Copilot — and almost nobody on the roadmap is acknowledging it:

- `apps/core/src/modules/ai/internal/ask-brain.ts` is a **complete honest-RAG-over-registry seam**: a question goes to `@brain/ai-gateway-client` (the model gateway), the model picks a `(metric_id, version, params)` binding **and never emits SQL or a number**, the `packages/metric-engine` sole read path computes the certified figure, `getMetricTrust` stamps the **frozen** confidence grade, and `PgAiProvenanceRepository` persists a redacted, reproducible (`snapshot_id`) audit row. The raw question is held in memory only and discarded.
- `apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts` is a **complete deterministic Decision Engine spine**: 4 detectors (`rto_risk`, `realization_gap`, `margin_erosion`, `scale_opportunity`) over SQL signal fns, with dedup/expire (`generate-recommendations.ts`), confidence gating (`confidence-gate.ts`), an append-only `decision_log` (migration `0044`, partitioned `0076`), a human-action ledger `ai_config.recommendation_action` (migration `0082`, SELECT+INSERT only, RLS-forced), and outcome measurement (`0045`, `measure-recommendation-outcomes.ts`).
- The **only write-back that exists** is `apps/core/src/modules/notification/internal/capi-passback.orchestrator.ts` — consent-gated, but **dev-boundaried (`would_send_dev`, no live sends)**.

So this is **not a greenfield "build an AI agent" project**. It is two activation jobs: (1) turn the single-question `askBrain` into a **proactive, multi-period Copilot** (briefings + what-changed/why/what-to-do/what-if), and (2) turn the **recommend-only** detector engine into a **suggested→approved→automated** Decision Engine with real (reversible, audited) write-back. The unanimous advisory verdict applies: **do not train ML, do not build autopilot first.** Activate the deterministic trust assets, close the action loop, and let measured outcomes earn the right to a model later.

---

## Initiative 1 — AI Copilot (proactive briefings + exec summaries)

The Copilot is the **temporal, narrative evolution of `askBrain`**. `askBrain` answers one question now; the Copilot answers *"what changed since last period, why, what to do, and what if"* on a schedule and on demand — using the **identical grounding contract** (registry binding → metric-engine number → frozen confidence → provenance).

### 1a. Grounding contract (non-negotiable, reuses what exists)
- **Numbers come ONLY from the metric registry / metric-engine**, never the model. Extend the existing `computeBinding` dispatch in `ask-brain.ts` (already wired for `realized_revenue`, `provisional_revenue`, `ad_spend`, `blended_roas`, `cod_rto_rate`, `cac`; `aov/ltv/repeat_rate/top_products/cohort_retention` are registered-but-`FIGURE_NONE`). The Copilot consumes these certified figures; the model only **narrates and ranks**, never computes.
- **RAG corpus = the marts + the registry, not free text.** Retrieval is over: (i) `packages/metric-engine/src/registry.ts` definitions (the 21 metric IDs, their `readSeam`, `recognitionLabels`), and (ii) period-over-period certified figures from `gold_executive_metrics`, `gold_cac`, `gold_revenue_ledger`, `gold_customer_360`, `gold_cohorts`, plus the detector signals (`rto_risk_signal_for_brand`, `realization_signal_for_brand`, `cm2_signal_for_brand`). Bind this with the `engineering-os:rag-retrieval` and `engineering-os:metric-engine` patterns; embeddings (`pgvector`) are only needed for the "explain in prose / link to the right dashboard" layer, **not** for any number.
- **What-changed/why = deterministic delta engine, not a model hallucination.** Build a `period-delta` service that diffs two snapshot-pinned registry reads (the `snapshot_id` mechanism in `snapshot.ts` already pins `as_of`). The model receives `{metric, prior_value, current_value, delta, attributed_detector_signals}` and writes the sentence. "Why" is sourced from the detector evidence (`DetectorRecommendation.payload.evidence`), so the causal claim is always traceable.
- **What-if = bounded scenario math over the registry, deterministic-first.** A "shift ₹X from Meta→Google" what-if recomputes `blended_roas`/`gold_cac`/CM2 under the perturbation using the same engine functions. No model number; the model only explains the recomputed scenario.

### 1b. Briefing cadence + delivery
- **Daily / weekly / monthly briefings** generated by an Argo `CronWorkflow` (`engineering-os:pipeline-orchestration`) calling a new `generate-briefing.ts` use-case per brand, RLS-scoped. Persist each briefing as an immutable provenance-linked artifact (extend the `ai_provenance` table pattern — one briefing = N bindings + the narrative + the snapshot).
- **Delivery**: in-app on the existing `/ask` surface (rename/expand `apps/web/app/(dashboard)/ask/`) and outbound via the existing `engineering-os:outbound-channels` (WhatsApp/email) seam that the CAPI work already touches — consent-gated, idempotent send.
- **Streaming UX** via `engineering-os:ai-streaming-ui` so the exec summary renders token-by-token with the **trust banner + provenance** the `ask-result` components already render (`AskTrustBanner`, `AskProvenance`).

### 1c. Cost-tier routing (mandatory, per `engineering-os:cost-routing-paradigms`)
The ~1:100:1k:10k cost ladder must be enforced on the briefing path:
- **Tier 0 (deterministic, ~free)**: the delta engine, the binding resolution re-validation, the what-if math, the ranking by `priority`. **This produces every number and every threshold decision.**
- **Tier 1 (small model)**: routine daily briefing narration ("revenue up 4%, RTO flat") — cheap, high-volume, low-stakes prose.
- **Tier 2 (frontier model)**: only the monthly exec summary and ambiguous NL questions route to the frontier tier via `@brain/ai-gateway-client`. Use **prompt caching** (the registry + brand context is a stable prefix → cache it; see `engineering-os:claude-api`).
- Add a per-PR effort-tier declaration on the briefing path and an `engineering-os:ai-observability-tracing` (OTel `gen_ai.*`) span on every model call for token/cost attribution per brand.

### Answers to the five required questions — Copilot
- **(a) Brand growth**: collapses "time looking for data" (Peel's whole pitch) into a pushed daily answer; the exec gets *what changed + what to do* without an analyst — directly attacking Daasity/Northbeam onboarding pain and Lifetimely's hours-stale refresh with a real-time, registry-certified narrative.
- **(b) Brain growth**: turns the dormant `askBrain` seam + idle gold marts into a **daily-active surface** (the single strongest retention predictor in this category); a non-hallucinating copilot is the only credible answer to the "why pay when Shopify Sidekick is free" objection (Sidekick is being publicly torched for ~95% hallucination).
- **(c) Architecture fit**: pure reuse — `@brain/ai-gateway-client` (gateway), `ask-brain.ts` (grounding), `metric-engine` (numbers), `snapshot.ts` (reproducibility), `ai_provenance` (audit), Argo cron (cadence), outbound-channels (delivery). One new use-case (`generate-briefing.ts`) + one delta service.
- **(d) Changes required**: (i) `period-delta` service; (ii) `generate-briefing.ts` + briefing persistence table; (iii) wire `aov/ltv/repeat_rate/top_products/cohort_retention` figures so briefings aren't `FIGURE_NONE`; (iv) cost-tier router config in the gateway; (v) `gen_ai.*` tracing; (vi) outbound delivery + briefing UI.
- **(e) Impact (rough)**: daily-active dashboard usage is the dominant 90-day-retention lever; lifting trial→paid conversion and 6-month retention by **5–15 pts** on a %-of-GMV book is the realistic range. At even 50 brands averaging ₹2–5L MRR equivalent in fee basis, that is a **mid-six-figure ARR protection/expansion** effect — but the honest caveat is this is a **retention/stickiness lever, not a new-logo lever** on its own.

---

## Initiative 2 — Decision Engine (suggested → approved → automated)

Promote the **recommend-only** detector engine to a graded autonomy ladder. The architecture for this is **already 80% present** — `decision_log` (audit), `recommendation_action` (human action ledger), `recommendation_outcome` (system measurement), and the CAPI orchestrator (a write-back primitive). The missing pieces are: **graded autonomy, guardrails, a durable execution/reversal workflow, and a second write-back target.**

### 2a. The three states (map to existing schema)
- **Suggested** = today's `generateRecommendations` output (`status='open'`). No change.
- **Approved** = a human clicks "approve" → append `action='accepted'` to `ai_config.recommendation_action` (the `record-recommendation-action.ts` path already supports this; the note explicitly says acceptance is recorded in the ledger, not by mutating the status CHECK). **This is Copilot mode** — human-in-the-loop, one-click.
- **Automated** = a per-brand, per-detector **autonomy policy** (new `ai_config.autonomy_policy` table, RLS-forced) lets a brand pre-authorize a detector to execute within guardrails. **This is Autopilot mode** — and it ships *last*, gated on accumulated outcome evidence.

### 2b. Action execution + reversal (the genuinely new build)
- **Durable, reversible execution** via `engineering-os:workflow-engine-temporal`: each approved action is a Temporal workflow (deterministic workflow + side-effecting activity) with a **compensation/saga** for reversal. Reversibility is a first-class requirement (Brain core rule: "small, reversible, auditable changes").
- **Write-back targets, in order of buildability**:
  1. **Audience/segment activation** (lowest blast radius, highest council consensus): publish a Brain-computed segment (e.g. high-RTO-risk COD customers from `silver_shipment` + `gokwik.rto_predict`, or predicted-lapsing from `gold_customer_360`) to a **Klaviyo list / Meta Custom Audience** via the `engineering-os:integration-connectors` + `outbound-channels` seams. Reversal = remove from list (clean compensation).
  2. **CAPI conversion-feedback go-live**: flip `capi-passback.orchestrator.ts` from `would_send_dev` to live, consent-gated. This is a *signal* write-back that lowers Meta CPA (Elevar/Sonar's whole business) — reversal = the orchestrator already has retroactive deletion.
  3. **Ad budget shift** (highest blast radius, ships last, Autopilot-gated): a `budget_shift` action driven by CM2-by-channel (`contribution-margin.ts` + `silver_marketing_spend`) writing to the Meta/Google connector. Reversal = restore prior budget snapshot.
- **Every action — suggested, approved, executed, reversed — appends to `decision_log` + `recommendation_action`.** The audit trail is the product (and the auditable-vs-black-box wedge against Moby's autopilot).

### 2c. Guardrails (per `engineering-os:agentic-safety` + `agentic-safety`/`ai-llm-security` for any NL-driven action)
- **Hard caps in deterministic code, not the model**: max % budget moved per period, min confidence grade (`Trusted` only for automated; `Estimated` requires human), spend floors/ceilings, and a per-brand kill switch (`engineering-os:progressive-delivery` 60s flag).
- **The model never decides to execute.** The detector (deterministic) decides *what* to recommend; the human or the pre-authorized policy decides *whether* to execute; the guardrail (deterministic) decides *if it's allowed*. The model only narrates. This keeps the entire action path within the deterministic-first doctrine and out of the "excessive agency" OWASP-Agentic risk.
- **Confidence + freshness gate**: an action cannot execute on stale data — reuse `getMetricTrust` / the `FeatureStaleError` SLO so a low-freshness signal **downgrades automated→suggested** automatically.

### 2d. The learning loop (the only honest license to train ML later)
`measure-recommendation-outcomes.ts` already re-fetches each rec's headline metric (then-at-raise vs now). Close the loop: **feed measured outcomes (action → lift) back as labels** into `feature_customer_daily` / a new outcome-labeled dataset. This generates the **proprietary outcome dataset** that is the *only* defensible reason to eventually register a real model in `ml.model_registry` (which today holds only the deterministic `customer_churn_rfm v0` placeholder). **No model training until this dataset exists.**

### Answers to the five required questions — Decision Engine
- **(a) Brand growth**: moves Brain from "here's a number" to "here's the action, click yes, and here's the measured lift" — the 9am-Monday job every operator persona said they actually buy. Segment activation recovers margin (RTO suppression, lapsing win-back) Klaviyo structurally can't compute; CAPI go-live lowers CPA 10–20% (Elevar's documented range); budget-shift cuts CM2-negative spend.
- **(b) Brain growth**: action + measured outcome lets Brain **price on demonstrated lift** and raises switching cost (rip out Brain and your audiences/automations go dark) — the strongest net-revenue-retention/expansion vector in the analysis. It is also the structural answer to "you're a worse Triple Whale": auditable, reversible, human-approved actions are a *defensible* position Moby's black-box autopilot cannot match.
- **(c) Architecture fit**: extends `recommendation` module (detectors, `decision_log`, `recommendation_action`, `recommendation_outcome`) + the CAPI orchestrator; adds Temporal for durable/reversible execution and connector write-back via existing `integration-connectors`/`outbound-channels` seams. The autonomy policy is one new RLS table mirroring `0082`'s pattern.
- **(d) Changes required**: (i) `ai_config.autonomy_policy` table + RLS; (ii) Temporal workflows + compensation activities per action type; (iii) segment-activation connector (Klaviyo/Meta audience push); (iv) flip CAPI to live; (v) guardrail engine (deterministic caps + kill switch via progressive-delivery flags); (vi) outcome→label feedback into `feature_customer_daily`; (vii) push detector grain from `subject='brand'` down to `channel × campaign` (the council's repeated demand — the columns exist in `gold_marketing_attribution` + `silver_marketing_spend`).
- **(e) Impact (rough)**: this is the **expansion + retention engine**. A closed action→outcome loop on even one detector (start with `rto_risk` suppression or abandoned-cart recovery — recoverable GMV is already quantified in `silver_checkout_signal` and flows through the `gold_revenue_ledger` Brain bills on) yields a **directly attributable margin/GMV recovery** the brand can see. Realistic per-brand impact: **2–8% margin protection on COD-heavy brands** (RTO is 20–40% of COD orders) and **5–15% CPA reduction** via CAPI EMQ — both translating to measurable fee-basis growth and a referenceable case study that underwrites premium pricing.

---

## Sequencing (skeptical, council-aligned)

**Do NOT** start with ML training, autopilot budget changes, or a 5th attribution model. **Do** sequence:

1. **Wire the `FIGURE_NONE` metrics + ship the daily/weekly Copilot briefing** on the existing `askBrain` grounding (lowest risk, highest visibility, honors "no empty charts / no hallucinated numbers").
2. **Close ONE action→outcome loop** (segment activation: RTO suppression *or* abandoned-cart recovery) with Temporal reversal + full audit — prove "action + measured lift" on data that already exists.
3. **Flip CAPI to live** (a write-back primitive that already exists, dev-boundaried) for measurable CPA reduction.
4. **Push detector grain to channel × campaign** + add the budget-shift recommendation (suggested/approved only).
5. **Only then** consider Automated mode (per-detector autonomy policy) and — once the outcome-labeled dataset exists — the first real model in `ml.model_registry`.

**The blocking dependency the council flagged twice**: the attribution marts (`gold_marketing_attribution`, `gold_attribution_paths`) are at ~0 rows because `reconcileAttribution` is not auto-triggered on finalization. Any Copilot narrative or Decision-Engine action touching channel ROAS will fire on emptiness. **Auto-trigger reconcile on `realized_revenue_ledger` finalization first**, or the channel-grain initiatives reproduce the exact empty-chart/buggy-attribution trust collapse Brain is positioned to fix.

## What to explicitly avoid (grounded in the inventory)
- No model-generated numbers anywhere — the `ask-brain.ts` contract (model binds, engine computes) is the law; extend it, never bypass it.
- No autonomous ad-platform write-back on a deterministic placeholder + ~0-row attribution — that inherits Triple Whale's "buggy/over-attributing" liability with worse blast radius.
- No Neo4j dual-write for "identity" in the Copilot — Postgres union-find (`migration 0017`) is the SoR; Neo4j is default-OFF and read by nothing.
- No new gold marts before the action loop closes (`gold_revenue_analytics` is already orphaned with no reader).


---

# 7. Segmentation, Predictive Models & Journey Intelligence

*Segmentation, Predictive Models & Customer Journey Intelligence — deterministic-first build plan on Brain's existing marts*

## Verdict up front

Brain already owns the substrate for all three deliverables but ships **none of them as a usable product**: segmentation today is a single value-tier `CASE` in `gold_customer_segments`; "scoring" is a rule-based RFM/churn band in `gold_customer_scores`; the ML platform (`ml.model_registry` / `ml.prediction_log`) holds exactly one `framework='deterministic'` seeded model (`customer_churn_rfm v0-deterministic`) that the eval gate explicitly exempts (`runEvalGate` returns early when `framework==='deterministic'`, `promote-model.ts:133`); and `serveCustomerScore` reads a precomputed Gold row and logs it as a "prediction" — it is not inference. Journey intelligence (`silver_touchpoint`, `silver_sessions`, `computeFirstTouchMix/computeStitchHitRate/computeTouchpointTimeline`) is real but stops at descriptive timelines with no drop-off diagnosis and a structurally undercounted denominator (only touches carrying `brain_anon_id` sessionize).

**The single hardest blocker for the whole pillar:** `feature_customer_daily` carries `lifetime_orders`, `days_since_last_order`, `customer_age_days` — but **no order-sequence timestamps**, so Brain cannot today compute inter-purchase interval, next-purchase date, or a true retention curve. Every predictive model and dynamic segment below depends on fixing that feature substrate first. Build order is non-negotiable: **(0) feature substrate → (1) deterministic dynamic segments → (2) journey drop-off → (3) ML on top, gated by eval, only after the deterministic loop produces outcome labels.**

This honors `cost-routing-paradigms` (deterministic ≫ ML, ~1:100) and CLAUDE.md ("deterministic first", "no empty charts", "confidence before decisions").

---

## Initiative 0 — Fix the feature substrate (prerequisite for everything)

Extend `feature_customer_daily` (`db/dbt/models/marts/feature_customer_daily.sql`, schema `brain_feature`) with the order-sequence features the current snapshot lacks, sourced from `silver_order_state` timestamps (already landed) rather than the latest-state-only `silver_customers`.

- **New columns** (additive, point-in-time-correct, keep the daily SCD grain `brand_id+brain_id+snapshot_date`): `order_2_at`, `median_days_to_next_order`, `p75_days_to_next_order`, `days_since_first_order`, `last_order_value_minor`, `discount_share_bps` (from `silver_order_line` line discounts), `distinct_first_channel` (join `silver_touchpoint.stitched_brain_id` first-touch). These are the BG/NBD/Gamma-Gamma and churn-label substrate.
- **Brand growth:** unlocks correctly-timed win-back (per-brand reorder cadence) instead of a global 90-day rule that mis-times every flow.
- **Brain growth:** turns `ml.model_registry`/`prediction_log` from a labeled skeleton into a usable training/serving base; kills the training/serving skew risk between the dbt feature layer and the divergent TS `CUSTOMER_FEATURES` (`packages/feature-store/src/index.ts`).
- **Architecture fit:** pure additive dbt extension in `brain_feature`; `ref('silver_order_state')` already exists; same incremental upsert pattern.
- **Changes:** ~1 dbt model edit + `_feature_history.yml` contract update + a new `silver_order_sequence` intermediate (window over `silver_order_state` by `occurred_at`). No new infra.
- **Impact:** prerequisite — no isolated revenue, but it is the gate on ~$0→sellable for the retention/predictive tier. ~1 week.

---

## Initiative 1 — Dynamic segmentation engine (deterministic, registry-backed)

Today `gold_customer_segments` is a single value-tier bucket and `gold_customer_scores` gives R/F/M tiers (1–5) + churn band. Compose these into the **named segments the deliverable asks for** plus user-defined dynamic segments.

- **Build a new mart `gold_customer_segment_membership`** (grain `brand_id+brain_id`, one row per customer with boolean/array membership), derived deterministically from `gold_customer_scores` (R/F/M, churn_risk) + the new Initiative-0 features:
  - **VIP** = `monetary_score>=4 AND frequency_score>=4`
  - **Loyal/Repeat** = `lifetime_orders>=3` (repeat = `>=2`, already the `repeat_rate` fold)
  - **Churn-risk** = `churn_risk IN ('high','medium')` defined per-brand vs `median_days_to_next_order` (Initiative 0), not a global band
  - **High-intent** = recent `cart.item_added`/`checkout.started` from `silver_touchpoint` without a converted order (join `silver_sessions.converted` flag)
  - **Discount-seeker** = `discount_share_bps` above brand median (from `silver_order_line`)
- **Dynamic segments**: a small predicate DSL evaluated server-side over the same mart columns, persisted in `ai_config` (RLS-isolated), so a brand defines "VIP + low-RTO-risk + lapsing" without engineering. Reuse the `BRAND_PREDICATE`/`withSilverBrand` seam (`packages/metric-engine`) — the engine stays the sole Gold reader (I-ST01).
- **Register segment definitions in the metric registry** (`packages/metric-engine/src/registry.ts`, 21 IDs today) as `segment_membership` with `toleranceMinor=0` and a `confidence/freshness` stamp, so segment counts are CI-parity-checked like every KPI.
- **Brand growth:** turns dashboards into targetable audiences (VIP win-back, discount-seeker margin protection, high-intent recovery).
- **Brain growth:** segmentation is the input every competitor monetizes (Klaviyo segments, Peel RFM audiences); doing it on **margin-aware, RTO-aware, identity-resolved** data (PG union-find, migration 0017) is something Klaviyo/Peel structurally cannot, because they segment on gross per-email profiles.
- **Architecture fit:** additive dbt mart + metric-engine reader + `ai_config` definition table; no new store.
- **Changes:** 1 new mart, 1 metric-engine module, 1 `ai_config` table + migration, BFF route under `/api/v1/analytics/*`, a Segments UI page (every build ships UI).
- **Impact:** the activation surface for retention/conversion campaigns; directly raises daily-active use (the strongest renewal predictor). ~2 weeks. Becomes the **audience source** for the Decision engine.

---

## Initiative 2 — Customer Journey Intelligence: drop-off & conversion diagnosis

`silver_touchpoint` (per-touch, with utm/click-ids/page_type/landing_path/`stitched_order_id`), `silver_sessions` (session rollup with `converted`/`bounce`), and `computeStorefrontFunnel` exist but only measure — no segmented drop-off, no leak diagnosis. The denominator is structurally undercounted (NULL-anon touches dropped; dev ~23/94 carried `brain_anon_id`).

- **Segmented funnel + biggest-leak flag** on `computeStorefrontFunnel`: split sessions→`product.viewed`→`cart.item_added`→`checkout.started`→purchased by source/channel (already in `silver_touchpoint`), device, and `landing_path/page_type`; auto-flag the largest-drop step per segment.
- **New mart `gold_journey_dropoff`** (grain `brand_id+segment+funnel_step`): deterministic step-reach + drop rate, surfaced with a **coverage/confidence badge** (`% of sessions with brain_anon_id`) so a CRO never optimizes against a denominator that silently disagrees with Shopify — operationalizes "confidence before decisions".
- **True retention curve** (closes the mislabeled-cohort gap): build `gold_retention_curve` (grain `brand_id+cohort_month+period_index` = % of cohort ordering in period N ÷ `cohort_size`) from `silver_order_state` timestamps, with per-cell cohort-size greying. `gold_cohorts` today is an acquisition aggregate; `computeCohortRetention` returns avg lifetime orders, not N0/N1/N2 — rename the current registry `cohort_retention` honestly and back it with the real triangle.
- **Brand growth:** answers "where and for whom does conversion break" and "do customers come back, and when" — the two questions the descriptive funnel/cohort surfaces can't.
- **Brain growth:** the retention triangle is the most screenshotted retention-sales artifact; the confidence-greyed version is white-space no rival occupies.
- **Architecture fit:** extends existing `journey-mix.ts` + funnel readers; new additive marts on `silver_touchpoint`/`silver_order_state`. No new infra.
- **Changes:** 2 new marts, funnel reader extension, registry honesty fix, 2 UI surfaces (`/analytics/funnel` segmentation, `/analytics/journey` retention triangle). Depends on first-party pixel coverage (Phase H CNAME host already laid) to raise the denominator — gate the UI on the coverage badge until then.
- **Impact:** the daily-driver CRO/growth surface; feeds funnel-step detectors (below). ~2–3 weeks.

---

## Initiative 3 — Predictive models (ONLY after the deterministic loop yields labels)

Brain has zero trained models and no Python training service. The eval gate (`EVAL_GATE_METRIC_FLOORS auc>=0.5`, baseline 0.6) is real but exempts deterministic models, so nothing is gated today. **Do not ship a black-box model now** — it forfeits the trust differentiator and has no labeled outcomes to beat. Sequence:

**3a. Deterministic baselines as the shipped models (now).** Register the existing RFM/churn (`gold_customer_scores`) and a deterministic **next-purchase-due** model (`last_order_at + median_days_to_next_order` from Initiative 0) and a deterministic **conversion-propensity** signal (recent cart/checkout touches without conversion, from journey) as registry rows. Serve via the existing `serveCustomerScore` path + `prediction_log`. These are explainable, parity-checked, and the honest baseline every ML model must beat.

**3b. Close the deterministic decision loop to GENERATE labels.** Wire detectors (`rto_risk`, `realization_gap`, `margin_erosion`, `scale_opportunity` in `recommendation/registry.ts`) → approve → `ai_config.recommendation_action` (0082) → `recommendation_outcome` (0045) → feed measured outcomes back as labels into `feature_customer_daily`. This is the **only honest license to train**.

**3c. First trained models (after labels exist):** predictive 90-day & 12-month **LTV** (BG/NBD + Gamma-Gamma) and **churn**/**next-purchase** propensity, trained on `feature_customer_daily`, registered in `ml.model_registry`, **gated by the eval harness** (must beat the 3a deterministic baseline's metrics, not just `auc>=0.6`), served via `prediction_log` with a **forecast-vs-realized overlay** (a trust artifact no competitor ships). Conversion scoring on the journey features. Use `engineering-os:ml-lifecycle` (MLflow registry + serving) + `feature-store-feast` to unify the two divergent feature definitions before any model ships.

- **Brand growth:** predicted LTV lets a brand decide acquisition spend today instead of waiting 12 months; the current cohort-naive "LTV" (realized ÷ customers) is ARPU and **must be relabeled or it loses head-to-head to Lifetimely's $115 forecast while Brain shows $42 and looks broken**.
- **Brain growth:** gives the ML platform its first non-deterministic resident; predicted-LTV is the gateway feature merchants pay $79–$299/mo for; eval-gated promotion + forecast-vs-realized is the explainable-AI wedge against Sidekick hallucination and Triple Whale over-attribution.
- **Architecture fit:** `model_registry`/`prediction_log`/eval gate already exist; needs a Python training service (`python-services` skill, sklearn/lifetimes) on the Spark/Argo batch seam — additive, not a redesign.
- **Changes:** training service, feature unification, registry rows, eval-baseline wiring, overlay UI on `/ml` + `/analytics/customer-360`. **Relabel `ltv` and `cohort_retention` honestly now (1-line).**
- **Impact:** unlocks the retention/predictive paid tier; but high-risk if rushed before 3b — quantified value is **0 until the deterministic loop proves outcomes**, then meaningful tier expansion. ~4–6 weeks for 3c after 3a/3b.

---

## How each feeds the Opportunity / Decision engines

- **Segments (1)** are the audience input the Decision engine acts on: a dynamic segment ("VIP + low-RTO-risk + lapsing") becomes a `recommendation` subject, written through `recommendation_action` (0082) + `decision_log` for full audit, then pushed to an outbound sink (Klaviyo list / Meta Custom Audience) — closing insight→action that every competitor leaves open.
- **Journey drop-off (2)** spawns **funnel-step / product-grain detectors** (new entries in `recommendation/registry.ts`) — moving recs off brand-grain ("margins eroding") to where decisions happen ("this Meta-mobile checkout step drops 60%"). Pair each with an A/B test via `experimentation-holdouts` so every rec is self-proving against `gold_revenue_ledger`.
- **Predictive scores (3)** are confidence-gated detector inputs (`confidence-gate.ts`: Trusted/Estimated/Insufficient), never raw model numbers in a KPI tile (KPIs only from the registry — `kpi-dashboard-design`). Predicted churn/LTV prioritize which segment the Opportunity engine surfaces first.

---

## Skeptic's guardrails (what NOT to do)

- Do not relabel-then-ship the ML tier as the headline — ship deterministic segments + journey drop-off + the **forecast-vs-realized** honesty first; trust is the conversion event.
- Do not train on `feature_customer_daily` until Initiative 0 adds order-sequence timing — a model on `lifetime_orders + days_since_last` only memorizes recency.
- Do not keep two feature definitions (dbt `feature_customer_daily` vs TS `CUSTOMER_FEATURES`) once a model ships — unify or inherit training/serving skew.
- Do not present `gold_cohorts` avg-orders as "retention" or realized-÷-customers as "LTV" — both are mislabeled today and both lose the demo by looking broken, not honest.

## Rough effort & sequencing
Init 0 (~1wk) → Init 1 (~2wk) + Init 2 (~2–3wk, partly parallel) → Init 3a/3b (~1–2wk, overlap) → Init 3c (~4–6wk). Critical path ~10–12 weeks to a trained, eval-gated predictive tier on a deterministic, auditable, outcome-labeled foundation.


---

# 8. Monetization, Pricing & Revenue Strategy

*Brain Monetization, Pricing & Revenue Strategy: From a %-of-GMV Meter That Can't Charge Anyone to a Value-Metered, Trust-Tiered ARR Engine*

## Executive summary (the brutal starting position)

Brain's monetization engine is **architecturally excellent and commercially inert**. What actually exists in code:

- `gmv_meter_snapshot` (migration `0040`) — immutable, append-only-by-GRANT sealed realized-GMV per (brand_id, billing_period).
- `billing_plan.rate_bps` (migration `0041`) — **ONE rate per brand**, single column, `CHECK (0..10000)`. No tiers, no seats, no feature gates. App falls back to `DEFAULT_RATE_BPS = 100` (1.00%) with honest `rate.source='default'` (`get-inspectable-bill.ts:27`).
- GST invoicing + credit notes (`0042`/`0046`), gapless numbering via SECURITY DEFINER `issue_invoice()`.
- `entitlements.ts` — progressive unlock, but gated on **data readiness, not plan**. This is *not* monetization entitlement.

Three structural facts kill ARR today:
1. **No payment rail.** `issue_invoice()` produces a GST invoice; there is no `payment_status` column on `invoice`, no Razorpay/Stripe charge, no dunning. Brain can bill but cannot collect a rupee.
2. **Manual month-close.** `sealBillingPeriod` (`seal-billing-period.ts`) has exactly one caller: the `POST /api/v1/billing/periods/seal` button. No Argo/cron. Revenue close is a human clicking.
3. **One pricing dimension.** A flat %-of-GMV rate cannot express Free→Enterprise tiers, AI add-ons, or seat expansion — so there is no upsell surface and no NRR mechanism.

The grounded reality says Brain has *more* meterable value-metrics than any competitor (events into Iceberg Bronze, realized GMV in `gold_revenue_ledger`, brands/orgs, AI actions in `ai_config.recommendation_action` ledger `0082`, prediction calls in `ml.prediction_log` `0083`) — but it meters and charges on **none of them except one manual GMV roll-up**. This document turns the existing meter into a tiered, value-metered, collectable ARR engine **without redesigning the architecture** — every initiative reuses marts/tables that already exist.

---

## Part 1 — The value-metrics Brain can already meter (the pricing substrate)

Pricing must be tied to a metric Brain can **prove and meter immutably**. Brain already has four, each backed by real tables:

| Value-metric | Source of truth (real) | Meter status today | Pricing role |
|---|---|---|---|
| **Realized GMV** | `gmv_meter_snapshot` (0040) ← `realized_gmv_for_period()` over `billing.realized_revenue_ledger` | Built, **manual** | Primary usage charge (the % rate) |
| **Brands / orgs** | Org→Brand isolation boundary; one `billing_plan` row per brand | Implicit (1 row/brand) | Seat/expansion axis (multi-brand) |
| **Events ingested** | Iceberg `brain_bronze.collector_events`, single Kafka lane `{env}.collector.event.v1` | Countable, **not metered** | Free-tier gate + abuse ceiling |
| **AI actions / decisions** | `ai_config.recommendation_action` (0082), `recommendation_outcome` (0045), `ml.prediction_log` (0083) | Logged, **not metered/billed** | AI add-on usage charge (the NRR engine) |

**Decision: GMV is the base meter; AI actions are the expansion meter.** This is the single most important pricing choice. The %-of-GMV base aligns Brain's revenue to *verified delivered revenue* (uniquely honest in COD/RTO India — you bill on `realized_gmv_for_period` which already floors at 0 and excludes provisional/RTO-clawed-back rows, per `seal-billing-period.ts:87`). AI actions are the variable upsell that drives net-revenue-retention because they grow with usage, not just GMV.

---

## Part 2 — The tiered plan structure (Free / Core / Growth / AI / Enterprise)

The current `billing_plan` table holds only `rate_bps`. It must become the plan anchor. The packaging maps **tier → which existing centers/marts are unlocked + the meter applied**.

### Tier ladder with concrete price points (INR-first, India D2C reality)

| Tier | Monthly platform fee | GMV rate (`rate_bps`) | What unlocks (real marts/centers) | AI actions included |
|---|---|---|---|---|
| **Free** | ₹0 | n/a (no billing) | Revenue truth read-only: `gold_executive_metrics`, `gold_revenue_ledger`, the **reconciliation receipt** (Shopify/Razorpay vs Brain). Capped at events/orders ceiling on Bronze. | 0 |
| **Core** | ₹4,000 (~$49) | 50 bps (0.50%) | + `gold_cac`, `silver_checkout_signal` COD/RTO surface (`cod_rto_rate`, `cod_mix`), `silver_shipment` terminal_class. The **RTO/COD profit-protection** beachhead. | 25 / mo |
| **Growth** | ₹16,000 (~$199) | 75 bps (0.75%) | + attribution (`gold_marketing_attribution`, `gold_attribution_paths`, channel/campaign ROAS), CM2 (`contribution-margin.ts` + `cost_input` 0055), funnel (`computeStorefrontFunnel`), retention curve, cohorts. | 150 / mo |
| **AI** (add-on, stacks on Growth) | ₹40,000 (~$490) | same as base tier | + closed action loop (recommendation→approve→`recommendation_action`→outcome), predictive LTV (when `ml.model_registry` has a trained resident), audience activation sink, **non-hallucinating Ask Brain** grounded in METRIC_REGISTRY | 1,000 / mo, then metered |
| **Enterprise** | Custom (₹1.5L+ / ~$2k+) | Negotiated, often **lower bps** at high GMV | + multi-brand/org rollups, data residency (`region-and-locale` seam), compliance shield (PII vault, FORCE-RLS, WORM audit), SSO, API export, dedicated reconciliation SLA | Unlimited / pooled |

**Why these price points:** They sit *below* Triple Whale Growth (~$129) at Core but match Lifetimely ($79–299) and undercut Northbeam ($1,500 floor) / Peel ($499 entry) at Growth — exploiting the documented "charges more for identical features" resentment. The AI add-on at ~$490 is priced where Lifetimely's "AI Profit Agent" and Klaviyo CDP add-ons live, but **stacks** rather than re-bundles.

### How the plan structure fits existing architecture

`billing_plan` already has `brand_id` PK + `rate_bps` + `effective_from`. **Change required (additive, one migration):**
- Add `plan_tier TEXT CHECK (plan_tier IN ('free','core','growth','enterprise'))`, `platform_fee_minor BIGINT`, `ai_addon BOOLEAN`, `ai_actions_included INTEGER`.
- Keep `rate_bps` — it stays the GMV meter rate per tier.
- **Wire `entitlements.ts` to read plan_tier as an additional gate** alongside the existing readiness gate (so a center unlocks only if *both* data-ready AND plan-entitled). This is a pure extension of the existing `Requirement` predicate pattern — no redesign. Today entitlements are readiness-only; this layers plan-based gating on the same `EntitlementEntry` shape.

---

## Part 3 — The AI add-on as the NRR engine (metering AI actions)

This is where expansion revenue lives. Today `ai_config.recommendation_action` (0082) and `ml.prediction_log` (0083) **log every action/prediction but bill none of them.** That is a metered usage stream sitting unused.

**Initiative: AI-action metering on the existing ledgers.**
- **(a) Brand growth:** Brands pay for *outcomes they act on* — a recommendation approved (`recommendation_action`) that produces measured lift (`recommendation_outcome` 0045). They never pay for a chart they ignored. This is the "predictions and actions, not just dashboards" wedge against descriptive Peel/Daasity.
- **(b) Brain growth:** AI actions scale with engagement, not just GMV — so NRR exceeds 100% even for a brand whose GMV is flat, because deeper usage = more billable actions. This is the structurally strongest NRR vector in the category.
- **(c) Architecture fit:** Reuses `ai_config.recommendation_action` (already append-only, partitioned, RLS) as the meter and `gmv_meter_snapshot`'s exact sealing pattern. Add a sibling `ai_action_meter_snapshot` table (same immutable-by-GRANT shape) sealed by the same period-close job.
- **(d) Changes required:** New migration `ai_action_meter_snapshot` (clone `0040` structure, count instead of sum); extend `sealBillingPeriod` to also seal AI-action count; overage line in `get-inspectable-bill.ts` composition.
- **(e) Impact:** If 30% of paid brands adopt the AI add-on at ₹40k + overage, and AI-action usage doubles within a cohort over 12 months, this drives **NRR from ~100% (GMV-only, churn-exposed) to ~115–130%** — the difference between a flat and a compounding ARR base.

**AI-action overage price point:** included bucket per tier, then **₹15 (~$0.18) per approved AI action** beyond the bucket. Predictions (`prediction_log` reads via `serveCustomerScore`) are *bundled free* until a trained model exists — do not bill inference that is currently a deterministic Gold read masquerading as a prediction (the council's repeated warning; billing it is the "self-grading homework" sin).

---

## Part 4 — Land-and-expand motion

**LAND (Free → Core): the reconciliation receipt is the wedge.**
Free tier ships exactly one un-fakeable artifact: a **Brain-vs-Shopify/Razorpay reconciliation receipt** built on `gold_revenue_ledger` + `realized_gmv_composition_as_of()` (0041, already exists) + the metric registry. It shows Brain's realized revenue next to the platform's number, the delta, and drill-to-source per line (refunds, RTO clawbacks via `silver_shipment` terminal_class, COD non-delivery). This is the "we found the money your current tool is hiding" demo. **Land is free; the % fee only starts at Core.**

**EXPAND axis 1 — GMV growth (automatic).** As a brand's `realized_gmv_for_period` grows, the % fee grows with zero sales motion. This is built-in expansion the moment auto-sealing exists.

**EXPAND axis 2 — tier upgrade (Core→Growth→AI).** Driven by `entitlements.ts`: a brand that connects ads (foundation `established`) sees attribution *light up* (once reconcile auto-fires — see Part 6) and is prompted to Growth. A brand acting on RTO recommendations is prompted to the AI add-on to close the action loop.

**EXPAND axis 3 — multi-brand (the org seat).** Org→Brand is the isolation boundary; each brand is a `billing_plan` row. A holding company / agency adds brands = adds billable units. Enterprise pools these. **This is the cleanest seat-expansion in the category** because it rides the existing tenant boundary — no new seat model needed.

---

## Part 5 — ARR model & drivers

**ARR = Σ_brands (platform_fee + rate_bps × realized_GMV + AI_action_overage)**

| Driver | Mechanism | Lever |
|---|---|---|
| **New brands** | Free→Core conversion via reconciliation receipt | Land motion |
| **GMV per brand** | `rate_bps × gold_revenue_ledger` realized GMV | Auto-expansion |
| **Tier mix** | `entitlements`-prompted upgrades | Sales/product-led upsell |
| **AI add-on attach** | `recommendation_action` metering | NRR engine |
| **Multi-brand** | org seat expansion | Enterprise land-and-expand |

**Illustrative unit economics (single Growth brand, ₹50L/mo GMV):** ₹16,000 platform + 0.75% × ₹50L = ₹37,500 GMV fee = **₹53,500/mo (~$650)**. Add AI add-on: +₹40k +overage = **~₹95k/mo (~$1,150)** — competitive with Northbeam Enterprise while delivering COD/RTO truth Northbeam structurally cannot.

**NRR target: 115–130%** driven by (1) GMV growth of retained brands, (2) AI-action usage growth, (3) multi-brand expansion — even net of the ~10–15% logo churn typical at the SMB end.

---

## Part 6 — The three blocking prerequisites (must ship before charging anyone)

The council and grounded reality converge: **the monetization engine cannot be turned on until its own loop closes.** In strict order:

1. **Automate the month-close.** Wrap `sealBillingPeriod` in an Argo `CronWorkflow` (the `pipeline-orchestration` seam) sealing all brands' prior period on day 1. Today it is a manual button — you cannot run a subscription business on a human clicking. *Change: one CronWorkflow + a loop-over-brands wrapper. No new schema.*

2. **Add the payment rail.** Add `payment_status`, `paid_at`, `payment_ref` to `invoice` (0042 is additive-safe); wire Razorpay subscription/charge against the issued GST invoice; add the **meter↔invoice↔payment↔ledger reconciliation loop** (`billing-and-metering` reference pattern). Without this, ARR is structurally $0-capable regardless of pricing. *Change: migration + Razorpay connector (OAuth/secrets already exist for Gokwik/Shiprocket — same `oauth-implementation` seam).*

3. **Make the value visible so the fee is justifiable.** Auto-trigger `reconcileAttribution` on `realized_revenue_ledger` finalization so `gold_marketing_attribution`/`gold_attribution_paths` are never 0 rows (today reconcile is manual/Argo, marts are data-starved — billing on an empty attribution surface violates "no empty charts"). The reconciliation receipt + populated attribution are what make a buyer accept the %-of-GMV basis.

**Do NOT** build trained ML, autonomous Autopilot, or new gold marts before these three ship — every persona flagged this as the path to inheriting competitors' black-box distrust with none of their distribution.

---

## Part 7 — What to avoid (pricing anti-patterns, grounded in competitor pain)

- **No MTU/event-volume billing** (Segment's hated model) — Brain's %-of-realized-GMV is the trust wedge; diluting it forfeits the differentiator. Events meter the Free ceiling only.
- **No active-profile billing** (Klaviyo's 2025 shock) — bill on delivered revenue, not contacts.
- **No identical-features-at-every-tier** (Peel's loudest complaint) — tiers must unlock *real* capability (RTO, attribution, CM2, action loop), enforced through `entitlements.ts`.
- **No mid-contract rate hikes** (Triple Whale's reputation damage) — `billing_plan.effective_from` exists; honor rate stability and surface it.
- **No billing of deterministic "predictions"** as AI inference until a real model lands in `ml.model_registry`.

---

## Bottom line

Brain has the most honest billing *primitives* in the category (immutable `gmv_meter_snapshot`, GST-grade invoicing, %-of-realized-GMV aligned to verified revenue) and **cannot charge a single brand today** because there is no cron close, no payment rail, and one flat rate with no tier/AI-action meter. The path to ARR is not new architecture — it is: (1) close the financial loop (auto-seal + Razorpay + reconciliation), (2) extend `billing_plan` into Free/Core/Growth/AI/Enterprise tiers wired through the existing `entitlements.ts` gate, (3) light up the AI-action meter on the already-existing `recommendation_action`/`prediction_log` ledgers to drive 115–130% NRR. Land free on the reconciliation receipt; expand on GMV, tier, AI actions, and multi-brand seats. Price the COD/RTO + CM2 profit beachhead where Brain is the *only* option — that is where %-of-delivered-GMV pricing is both most defensible and most honest.

---

# 9. Engineering / DB / Medallion / Identity / Pipeline / UI Impact

*Engineering Impact: Top Initiatives to Convert Brain's Truth Moat into Activated, Paid Value*

## Thesis (grounded, skeptical)

Brain has the strongest data foundation in the category — immutable Iceberg Bronze (`brain_bronze.collector_events`), a deterministic money ledger (`gold_revenue_ledger`, `toleranceMinor=0`), a single-source `METRIC_REGISTRY` (21 IDs), and `%`-of-realized-GMV billing (`gmv_meter_snapshot`, `billing_plan`). But the AI/attribution tier it markets is **built and inert**. Three facts I verified in the repo, not the inventory:

1. **Attribution is data-starved by design.** `reconcile-attribution.ts:19` literally comments *"NOT auto-triggered by the finalization job"* — `reconcileAttribution` is called only from `apps/core/src/jobs/attribution-reconcile.ts` (Argo) and `bff.routes.ts:2487` (manual). So `gold_marketing_attribution` / `gold_attribution_paths` are ~0 rows on a fresh tenant — violating Brain's own "no empty charts" law.
2. **All recommendation detectors are brand-grain.** `detectors/registry.ts` — every one of `rto_risk`, `realization_gap`, `margin_erosion`, `scale_opportunity` is `subject: 'brand'`. None fire at channel/campaign/SKU grain where money is actually moved.
3. **CAPI feedback never sends.** `capi-adapter.ts:11` + `main.ts:525` — `DevCapiAdapter` returns `would_send_dev`, "NEVER sends." A live causal lever is parked as a compliance artifact.

The council converges violently: stop racing incumbents on agents/ML; **make the truth moat visible, populated, and acted-upon.** Below are the four top initiatives, ranked by leverage-on-existing-assets, then a buildable first slice.

---

## Initiative 1 (FLAGSHIP): Auto-populate attribution + the Reconciliation Receipt

**What.** (a) Fire `reconcileAttribution` automatically on every order finalization/reversal so `gold_marketing_attribution` and `gold_attribution_paths` are never empty; (b) ship a "Brain vs Shopify/Razorpay" reconciliation receipt that ties `gold_revenue_ledger` realized revenue to platform payout, delta explained line-by-line.

- **Brand growth:** Day-1 multi-touch credit + ROAS by channel/campaign reconciled to verified revenue; merchant sees where Triple Whale's 15-25% discrepancy hides.
- **Brain growth:** Activates 3 already-built registry metrics (`attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`) + `computeChannelRoas`/`computeCampaignRoas` with zero new modeling. The receipt is the un-fakeable sales demo that justifies the `%`-of-GMV fee (you can't bill on a basis the buyer can't audit).
- **Architecture fit:** Reuses `AttributionCreditWriter` (`packages/attribution-writer`), `reconcile-attribution.ts`, the existing credit ledger (migration 0032), and the `realized_gmv_composition_*` seams (0041/0043). No new infra.
- **Changes required:**
  - **PIPELINE:** Add a consumer-group `attribution-reconcile-live` on the existing `{env}.collector.event.v1` lane that triggers `reconcileAttribution(brandId)` on `order.live.v1` finalization/reversal events (debounced per brand, idempotent — credit_ids already `ON CONFLICT`). This removes the Argo-only dependency. Keep the Argo job as a nightly backfill/repair.
  - **DB:** No new tables. Add index on `gold_marketing_attribution(brand_id, channel, occurred_at)` for the channel-ROAS read; ensure `attribution_credit_ledger` has `(brand_id, order_id, model_id)` covering index for the reconcile credit-pass scan.
  - **MEDALLION:** No new marts. `gold_marketing_attribution` / `gold_attribution_paths` simply populate. Optionally flip their `ledger_source` to `iceberg` only after the dbt-StarRocks incremental-CTAS bug is resolved (keep `pg` default — do not ship a bug-gated path).
  - **API:** New `GET /api/v1/analytics/reconciliation` returning per-period {brain_realized, platform_reported, delta, drill lines} from `gold_revenue_ledger` + `realized_gmv_composition_for_period`.
  - **UI:** New "Reconciliation" tile on `/dashboard` and a drill page; stamp `attribution_confidence` (A/C/D) on every channel-ROAS row in `/analytics/attribution`.
- **Impact:** This is the trial-conversion gate. Populated attribution + a reconciliation receipt is the difference between a demo that closes and an empty chart. Rough range: **+15-30pp trial→paid conversion**; it is the precondition for any paid analytics tier ($129-379/mo competitor band).

## Initiative 2: Abandoned-cart recovery — close ONE action loop on data that already exists

**What.** `silver_checkout_signal` already computes recoverable GMV (`signal_type='checkout_abandoned'`, `total_price_minor`, `has_address`). Turn that number into a consent-gated audience exported to an outbound channel, attributed back to `gold_revenue_ledger`.

- **Brand growth:** Recovers revenue currently only measured — the Klaviyo/Postscript value, but margin-aware and identity-deduped (via the PG identity graph, not per-email).
- **Brain growth:** Brain's first true insight→action→outcome loop. Recovered GMV flows through the very ledger Brain bills on, so recovery *increases the `%`-fee base* — perfectly aligned revenue.
- **Architecture fit:** Reuses `silver_checkout_signal`, the `decision_log` + `recommendation_action` ledger (0082), the consent boundary (`can_contact`), and the existing CAPI/feedback seam pattern.
- **Changes required:**
  - **API/PIPELINE:** A reverse-ETL publisher that reads abandoned-cart signals → resolves `brain_id` (identity graph) → writes a segment to `recommendation_action` (0082, auditable) → pushes to Klaviyo list / Meta Custom Audience. Same consent-gated send boundary as CAPI.
  - **DB:** Add `audience_export` table (brand_id, segment_id, destination, member_count, exported_at) or reuse `recommendation_action` with an `action_type='audience_export'`.
  - **UI:** `/analytics/abandoned-cart` gains a "Recover" action + outcome tile (recovered GMV vs at-risk).
- **Impact:** Recoverable carts are typically **3-8% of GMV**; even 10-20% recovery is a directly attributable, screenshot-ready ROI story. This is the renewal/expansion proof the CS council demands.

## Initiative 3: RTO/COD profit-protection + CM2-by-channel (the uncontested beachhead)

**What.** Promote the India COD/RTO assets to a headline product, and re-grain profit to where spend decisions are made.

- **Brand growth:** `silver_shipment.terminal_class` (rto/delivered) + `cod_rto_rate` + `gokwik.rto_predict` risk + the `rto_risk` detector → pre-ship flag/hold for high-RTO COD orders. Combine `contribution-margin`/CM2 (`cost_input` 0055) with channel attribution → CM2-positive vs CM2-negative spend per channel. No Western competitor can compute either.
- **Brain growth:** Uncontested geographic + vertical wedge; price on demonstrable margin recovered. `%`-of-*realized* GMV is more honest in India (bills delivered-and-paid, not gross orders).
- **Architecture fit:** All marts exist (`silver_shipment`, `silver_checkout_signal`, `gold_cac`, CM2 compute fn). The gap is **grain + an action sink**, not data.
- **Changes required:**
  - **DETECTORS:** Add `channel`/`campaign` subject variants beside the brand-grain detectors in `detectors/registry.ts`, driven by `gold_marketing_attribution.channel/campaign_id` + `silver_marketing_spend`. Add a SKU-grain `cod_rto_signal` for pre-ship hold.
  - **MEDALLION:** Re-grain `gold_cac` off `silver_marketing_spend.campaign/stat_date` to channel×week (currently month-grain). New `gold_channel_profit` mart joining CM2 + attribution credit.
  - **UI:** New top-level "Profit Protection" nav surfacing RTO-saved-rupees + CM2-by-channel.
- **Impact:** RTO is **20-40% of COD orders**; even a few points of reduction is large margin. Value-based pricing on recovered margin is a wedge incumbents structurally cannot match.

## Initiative 4: Confidence + freshness as a first-class trust UI

**What.** Wire the existing `attribution_confidence` (A/C/D), `effective_confidence`, `cost_confidence`, `FeatureStaleError` SLO, and data-foundation-health into ONE visible trust badge on every KPI tile, with drill-to-source.

- **Brand growth:** Buyer never acts on a stale/low-confidence number unknowingly — the direct antidote to Sidekick hallucinations and Triple Whale silent discrepancies.
- **Brain growth:** Productizes Brain's "confidence before decisions" principle into the category white-space no rival occupies. Cheap (substrate exists), high differentiation, enterprise-procurement unlock.
- **Architecture fit:** Pure UI + BFF surfacing of grades the metric-engine already computes. No DB/pipeline change.
- **Impact:** Trust is the conversion lever in every competitor's hated column. **Supporting** differentiator (not the headline) — but it converts GA4-burned/Northbeam-burned skeptics and reduces churn.

---

## Engineering Impact summary (by layer)

| Layer | Flagship (Init 1) | Init 2 | Init 3 | Init 4 |
|---|---|---|---|---|
| **DATABASE** | Indexes on `gold_marketing_attribution`, `attribution_credit_ledger`; no new tables | `audience_export` table or reuse `recommendation_action` (0082) | `gold_channel_profit` mart; re-grain `gold_cac`; SKU `cod_rto_signal` fn | none |
| **MEDALLION** | Populate `gold_marketing_attribution`/`gold_attribution_paths` (no new marts) | reads `silver_checkout_signal` | new Gold `gold_channel_profit`; `gold_cac` channel×week | none |
| **IDENTITY** | journey resolve via `silver_touchpoint.stitched_brain_id` (PG graph) | `brain_id` resolve for audience dedup (PG union-find, NOT Neo4j) | `brain_id` on shipment/order | none |
| **PIPELINE** | new consumer-group `attribution-reconcile-live` on `collector.event.v1` | reverse-ETL publisher + consent gate | detector re-grain; nightly CM2 refresh | none |
| **API** | `GET /analytics/reconciliation` | audience-export endpoint | channel-profit + RTO-hold endpoints | grades on every `/analytics/*` response |
| **UI** | Reconciliation tile + drill; confidence on ROAS rows | Recover action + outcome tile | "Profit Protection" nav | trust badge everywhere |
| **AI/FEATURE** | activates `computeChannelRoas`/`computeCampaignRoas` | none (deterministic) | reuses CM2 + `rto_risk` detector | none |

**Do NOT (council consensus):** no trained ML models / autopilot on a 0-row credit ledger; no 5th attribution model (Markov/Shapley) without incrementality ground truth; no Neo4j dual-write (PG union-find is the authoritative SoR); no new gold marts before the existing data-starved ones populate.

---

## BUILDABLE FIRST SLICE (flagship) — "Attribution never ships empty + the Reconciliation Receipt"

**Goal:** On a fresh tenant, finalize one order → channel/campaign credit appears in `gold_marketing_attribution` within the session, and `/dashboard` shows a reconciliation tile. Vertical slice, reversible, wired to real marts.

**Exact files/marts touched:**

1. **PIPELINE — auto-trigger reconcile (the core fix)**
   - `apps/stream-worker/src/main.ts` — register a new consumer group `attribution-reconcile-live` on `{env}.collector.event.v1`, filtered to `order.live.v1` finalization/reversal `event_type`s. Debounce per `brand_id` (e.g. 30s coalesce window).
   - New `apps/stream-worker/src/interfaces/consumers/AttributionReconcileConsumer.ts` → calls into a core endpoint or shared `reconcileAttribution` path (the function is already exported from `apps/core/src/modules/attribution/index.ts:61`). Idempotent: credit_ids already `ON CONFLICT` in migration 0032.
   - Keep `apps/core/src/jobs/attribution-reconcile.ts` as nightly backfill/repair (unchanged).

2. **DB — read-path indexes (migration 00xx)**
   - `CREATE INDEX ON attribution_credit_ledger (brand_id, order_id, model_id)` (speeds reconcile credit-pass scan).
   - StarRocks: ensure `gold_marketing_attribution` order_by covers `(brand_id, channel)`.

3. **API — Reconciliation Receipt**
   - `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — add `GET /api/v1/analytics/reconciliation` reading `gold_revenue_ledger` (via `withSilverBrand`) + `realized_gmv_composition_for_period()` (0043). Returns `{period, brain_realized_minor, platform_reported_minor, delta_minor, lines[]}` with `currency_code` + `attribution_reconciliation_rate`.
   - New compute fn `packages/metric-engine/src/reconciliation-receipt.ts` (deterministic, integer-minor, `toleranceMinor=0`) — registered alongside existing readers, parity-oracle covered.

4. **UI**
   - `apps/web/app/(dashboard)/page.tsx` — add Reconciliation tile (Brain realized vs platform, delta, "drill" link) using `use-` hook pattern + a new `use-reconciliation.ts`.
   - `apps/web/app/(dashboard)/analytics/attribution/` — stamp the `attribution_confidence` A/C/D grade on each channel-ROAS row (reads grade already on `gold_marketing_attribution`).

5. **Tests (mandatory per CLAUDE.md "tests for any behavior change")**
   - Consumer idempotency test: replay the same finalization event → no duplicate credits.
   - Reconciliation parity test in `packages/metric-engine` against the independent oracle (`attribution-parity-oracle.test.ts` pattern).
   - e2e: finalize order → assert `gold_marketing_attribution` rows > 0 for the brand within the session.

**Verification:** run a finalized `order.live.v1` through the dev `collector.event.v1` lane (Collector :8787 → Kafka → consumer), confirm `gold_marketing_attribution` populates in StarRocks, and `GET /api/v1/analytics/reconciliation` returns a non-empty receipt that ties to `gold_revenue_ledger` to the minor unit.

**Why this slice first:** it honors Brain's own "no empty charts" invariant, activates the most under-leveraged assets already built (attribution marts + reconciliation seams), and produces the one un-fakeable artifact every council persona named as the conversion event — a penny-accurate number the merchant can audit, backed by populated multi-touch credit.


---

# 10. Gap Analysis & Product Roadmap

## CPSO Capstone — Gap Analysis & Product Roadmap

**Thesis (verified, not asserted).** Brain has the strongest, most honest data foundation in the category and the *weakest commercial activation*. I confirmed the four load-bearing facts in code before writing this roadmap:

1. **Attribution never auto-populates.** `apps/core/src/modules/attribution/internal/reconcile-attribution.ts:19` literally states reconcile is *"NOT auto-triggered by the finalization job."* So `gold_marketing_attribution` / `gold_attribution_paths` are ~0 rows on a fresh tenant — the flagship surface violates Brain's own "no empty charts" law.
2. **All recommendation detectors are brand-grain.** Every `subject` in `apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts` is `'brand'` (lines 46, 70, 95, 133) — none fire at channel/campaign/SKU grain where money moves.
3. **Monetization cannot charge anyone.** `db/migrations/0041_billing_plan_and_composition.sql` defines `billing_plan` with a single `rate_bps` column and no `plan_tier`/`payment_status`; `sealBillingPeriod`'s only non-test caller is `bff.routes.ts:1944` (a manual button — no cron); there is no payment rail.
4. **The action loop is parked.** CAPI passback is the only write-back and it is dev-boundaried (`apps/core/src/main.ts:525`, `would_send_dev`, "NEVER sends"); `feature_customer_daily` carries `days_since_last_order` but **no order-sequence timestamps**, so no inter-purchase interval, no true retention curve, no predictive-LTV substrate.

The strategic error every advisory council named: **spending the truth moat on the one fight Brain cannot win (agentic AI / trained ML on an unclosed foundation) instead of making truth visible, populated, actioned, and collectable.** This roadmap sequences accordingly.

---

## PART 1 — GAP ANALYSIS (current Brain vs future Brain)

Severity: 🔴 blocks revenue / 🟠 blocks a paid tier / 🟡 differentiation upside.

### A. Data & medallion gaps
| Gap | Current reality (grounded) | Future state | Sev |
|---|---|---|---|
| Attribution data-starved | `gold_marketing_attribution`, `gold_attribution_paths` ~0 rows; reconcile manual/Argo only | Auto-fire `reconcileAttribution` on `realized_revenue_ledger` finalization + backfill → populated day-1 | 🔴 |
| No retention curve | `gold_cohorts` is acquisition aggregate; `computeCohortRetention` returns avg lifetime orders, not N0/N1/N2 | `gold_retention_curve` (cohort_month × period_index) from `silver_order_state` timestamps | 🟠 |
| No inter-purchase clock | `feature_customer_daily` has `days_since_last_order`, no order-sequence | Add `order_2_at`, `median/p75_days_to_next_order` → per-brand churn definition | 🟠 |
| Orphaned mart | `gold_revenue_analytics` builds, **no reader** | Wire to Product dashboard `order_status_mix`, or delete | 🟡 |
| Money-spine still PG | order-state/customers/spend Silver read PG read-shims, not raw Iceberg | Reconcile or flip; do not claim "lakehouse-sourced revenue truth" until then | 🟠 |
| Iceberg flip bug-gated | `gold_revenue_ledger`/`gold_marketing_attribution` default `ledger_source='pg'`; Iceberg flip blocked on dbt-StarRocks incremental-CTAS bug | Resolve bug or make marts `table`; keep `pg` default meanwhile | 🟡 |

### B. AI / decision-layer gaps
| Gap | Current reality | Future state | Sev |
|---|---|---|---|
| Detectors wrong grain | all `subject:'brand'` | channel/campaign/SKU/customer detectors using `gold_marketing_attribution` + `silver_marketing_spend` columns that already exist | 🔴 |
| No closed action loop | `recommendation_action` (0082) + `recommendation_outcome` (0045) logged, **never closed with a real user** | recommend→approve→action→measured-lift on ≥1 detector | 🔴 |
| No write-back | CAPI `would_send_dev`; no Klaviyo/Meta audience sink | live CAPI (EMQ) + outbound audience-activation sink (reversible, audited via Temporal saga) | 🟠 |
| No trained models | `ml.model_registry` holds only `customer_churn_rfm v0-deterministic`; `serveCustomerScore` is a Gold read cosplaying as inference; eval gate exempts deterministic | predictive LTV/churn — **only after** the deterministic loop produces outcome labels | 🟡 |
| Online store write-only | no `RedisOnlineStore.get()` caller in prod; two divergent feature defs (dbt vs TS) | unify feature definition; one prod consumer reads online store | 🟠 |
| `$ impact` not first-class | `priority` is 0–1000 ordinal; ₹ hides in `evidence` | formula-bound `impact_minor` (BIGINT + currency) per detector | 🟠 |

### C. UI / trust gaps
| Gap | Current reality | Future state | Sev |
|---|---|---|---|
| Truth moat invisible | no reconciliation receipt (Brain vs Shopify/Razorpay) | headline reconciliation receipt on `/dashboard` over `gold_revenue_ledger` + `realized_gmv_composition_*` | 🔴 |
| Confidence unwired | `attribution_confidence`/`cost_confidence`/`effective_confidence` computed, not surfaced | first-class trust badge (grade + as-of + drill-to-source) on every tile | 🟠 |
| Mislabeled metrics | `ltv` = realized÷customers (ARPU); "cohort retention" = avg orders | rename ARPU; back `cohort_retention` with real triangle | 🟠 (demo-loser today) |
| Funnel denominator undercounted | only `brain_anon_id` touches sessionize (~23/94 dev) | coverage/confidence indicator gating the funnel UI | 🟡 |
| No funnel segmentation / cart recovery | `computeStorefrontFunnel` measures; `silver_checkout_signal.abandonedValueMinor` quantified then ignored | segmented funnel + abandoned-cart recovery loop | 🟠 |
| Doc drift | `silver_customers.sql` still claims Neo4j mints `brain_id` (PG union-find 0017 is authoritative) | fix before any tech eval | 🟡 |

### D. Monetization / business gaps
| Gap | Current reality | Future state | Sev |
|---|---|---|---|
| No payment rail | `issue_invoice()` exists; `invoice` has no `payment_status`/`paid_at` | Razorpay charge + dunning + meter↔invoice↔payment↔ledger reconciliation | 🔴 |
| Manual month-close | `sealBillingPeriod` only caller = manual BFF button | Argo CronWorkflow seals all brands monthly | 🔴 |
| One pricing dimension | `billing_plan` = single `rate_bps`, no tiers/AI meter | Free/Core/Growth/AI/Enterprise via `plan_tier` + AI-action meter on `recommendation_action` | 🟠 |
| Entitlements ≠ monetization | `entitlements.ts` gates on data-readiness only | layer plan-tier gate on the same `EntitlementEntry` shape | 🟠 |

---

## PART 2 — PRODUCT ROADMAP (prioritized by business impact × revenue impact × eng effort)

Scoring = (Business × Revenue) ÷ Effort. The 0–3mo band is deliberately the financial-loop-close + truth-visible band the councils unanimously demanded *before* anything else.

### Horizon 1 — 0–3 months: "Close the loop, make truth visible, become collectable"
*Goal: a real brand reconciles to the penny, sees populated attribution, and Brain can charge.*

| Initiative | Outcome | Owner-area | Real marts/pipelines touched | Success metric |
|---|---|---|---|---|
| **1. Auto-trigger reconcile + backfill** 🔴 | attribution populated day-1; honors "no empty charts" | Data/Pipeline | new consumer-group `attribution-reconcile-live` on `{env}.collector.event.v1` (order.live.v1 finalize/reversal) → `reconcileAttribution`; `gold_marketing_attribution`/`gold_attribution_paths` | 0→>0 rows within first session; 3 registry metrics (`attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`) emit |
| **2. Reconciliation Receipt** 🔴 | "Brain vs Shopify/Razorpay to the rupee, delta explained" | Backend/Web | new `packages/metric-engine/src/reconciliation-receipt.ts` + `GET /api/v1/analytics/reconciliation` over `gold_revenue_ledger` + `realized_gmv_composition_for_period()`; `/dashboard` tile | reconciliation_rate surfaced per brand; trial→paid lift (target +15–30pp on first cohort) |
| **3. Automate month-close** 🔴 | revenue close stops being a human clicking | Platform/SRE | Argo `CronWorkflow` wrapping `sealBillingPeriod` over all brands; `gmv_meter_snapshot` | 100% of brands sealed by period-day-1, 0 manual seals |
| **4. Payment rail** 🔴 | Brain can collect a rupee | Backend | additive migration: `invoice.payment_status/paid_at/payment_ref`; Razorpay charge (reuse `oauth-implementation` seam); meter↔invoice↔payment↔ledger reconciliation | first ₹ collected; collection reconciliation drift = 0 |
| **5. Confidence + freshness trust badge** 🟠 | every number drills to source with grade + as-of | Web/Backend | surface `attribution_confidence`/`cost_confidence`/`effective_confidence` + `data-foundation-health` across `/analytics/*` | badge on 100% of KPI tiles; metric drill-to-source coverage 100% |
| **6. Honesty fixes (cheap)** 🟡 | survive a tech eval | Data/Web | relabel `ltv`→ARPU in UI; fix `silver_customers.sql` Neo4j doc drift | analyst-eval pass; 0 mislabeled metrics |

### Horizon 2 — 3–6 months: "First action loop + the uncontested beachhead"
*Goal: one measured before/after win per brand; lead GTM where Brain is the only option.*

| Initiative | Outcome | Owner-area | Real marts/pipelines touched | Success metric |
|---|---|---|---|---|
| **7. Abandoned-cart recovery loop** 🔴 | recovered GMV flows through the ledger Brain bills on | Backend/AI | `silver_checkout_signal` (abandonedValueMinor) → consent-gated audience → outbound sink (Klaviyo/Meta) via `recommendation_action` (0082) + `decision_log`; attributed back to `gold_revenue_ledger` | first closed action→outcome; 5–12% of at-risk GMV recovered |
| **8. RTO/COD Profit-Protection (headline nav)** 🟠 | pre-ship flag/hold for high-RTO COD orders; net-of-RTO revenue | AI/Data | `silver_shipment.terminal_class`, `cod_rto_rate`, `gokwik.rto_predict`, `rto_risk` detector → SKU-grain pre-ship action | RTO-saved-rupees tile; 3–8% net-margin recovery per COD-heavy brand |
| **9. Re-grain detectors → channel/campaign + `impact_minor` first-class** 🔴 | recs land where budget is spent | AI/Backend | add `channel`/`campaign` detectors over `gold_marketing_attribution` + `silver_marketing_spend`; promote formula-bound `impact_minor`; re-grain `gold_cac` to channel×week | recs at spend-grain; approve-rate > 0 |
| **10. CM2-by-channel** 🟠 | profit per spend unit, not vanity ROAS | Data/AI | wire `contribution-margin`/CM2 (`cost_input` 0055) to `silver_order_line` grain + channel attribution; new `gold_channel_profit` | CM2-negative channels flagged; spend reallocated |
| **11. Tiered plan structure + AI-action meter** 🟠 | Free/Core/Growth/AI/Enterprise; NRR engine | Backend | extend `billing_plan` (`plan_tier`, `platform_fee_minor`, `ai_addon`); new `ai_action_meter_snapshot` (clone 0040) over `recommendation_action`; wire plan-gate into `entitlements.ts` | paid conversions by tier; AI add-on attach rate; NRR trending >100% |

### Horizon 3 — 6–12 months: "Retention foundation + segmentation + scenario copilot"
*Goal: fix the mislabeled retention pillar, ship targetable segments, narrate without hallucinating.*

| Initiative | Outcome | Owner-area | Real marts/pipelines touched | Success metric |
|---|---|---|---|---|
| **12. Feature substrate + retention curve** 🟠 | true N0/N1/N2 + per-brand reorder clock | Data | extend `feature_customer_daily` (order-sequence from `silver_order_state`); new `gold_retention_curve` + `silver_order_sequence` intermediate | retention triangle live with cohort-size greying; win-back timed to brand cadence |
| **13. Dynamic segmentation engine** 🟠 | VIP/loyal/churn-risk/high-intent + user-defined segments → audience sink | Data/AI | new `gold_customer_segment_membership` from `gold_customer_scores`; register `segment_membership` in metric registry; predicate DSL in `ai_config` | segments published to CRM; activation count; switching-cost up |
| **14. Segmented funnel + drop-off diagnosis** 🟡 | where/for-whom conversion breaks | Data/Web | segment `computeStorefrontFunnel` by source/device/landing (`silver_touchpoint`); new `gold_journey_dropoff` with coverage badge | biggest-leak step flagged; funnel daily-active sessions |
| **15. AI Copilot (briefings + Ask Brain)** 🟡 | proactive what-changed/why/what-to-do, registry-grounded, non-hallucinating | AI | extend `ask-brain.ts` grounding (model binds, engine computes); `period-delta` service over snapshot marts; `generate-briefing.ts` Argo cron; cost-tier routing | daily-active briefing opens; 0 model-generated numbers; "why not free Sidekick" objection win-rate |
| **16. Live CAPI (EMQ) + budget-shift recommendation (suggest/approve)** 🟡 | measurable CPA lever; spend reallocation | AI/Backend | flip `capi-passback.orchestrator` to live (consent-gated, reversible); budget-shift detector (approve-only, never autopilot) | EMQ trend up; 10–20% CPA reduction; reversible action audit trail |

### Horizon 4 — 12–24 months: "Earn the right to ML + scale upmarket"
*Goal: trained models gated by outcome labels; incrementality; platform breadth done well.*

| Initiative | Outcome | Owner-area | Real marts/pipelines touched | Success metric |
|---|---|---|---|---|
| **17. Predictive LTV/churn (eval-gated)** 🟡 | forecast that beats the deterministic baseline | AI/ML Platform | Python training service (sklearn/lifetimes) on `feature_customer_daily` + outcome labels from H2 loop; `ml.model_registry` + eval harness; forecast-vs-realized overlay | model promoted only if it beats `customer_churn_rfm v0`; predictive-LTV tier conversions |
| **18. Incrementality / geo-holdout primitive** 🟡 | causal proof on the immutable Bronze (upmarket wedge vs Northbeam) | Data/AI | `experimentation-holdouts` seam over `brain_bronze.collector_events`; lift vs counterfactual reconciled to `gold_revenue_ledger`; written to `decision_log` | first holdout shipped; upmarket (>₹50L GMV) deals |
| **19. Unify feature store + online serving** 🟠 | kill training/serving skew; close online read loop | AI/ML Platform | unify dbt `feature_customer_daily` vs TS `CUSTOMER_FEATURES` (Feast); ≥1 prod `RedisOnlineStore.get()` consumer | one feature definition; online-served features in prod |
| **20. Platform breadth (Woo/Magento/marketplaces)** 🟡 | non-Shopify brands not second-class | Connectors | universal pixel + Woo/Magento installers (currently credential-blocked) into `brain_bronze.collector_events` | non-Shopify brands live; multi-brand/org seat expansion |
| **21. Multi-brand/org + compliance shield (Enterprise)** 🟡 | Plus-tier procurement unlock | Backend/Security | org-rollup billing across `billing_plan` rows; surface PII vault + FORCE-RLS + WORM audit as merchant-facing governance report | Enterprise ACV; security-review cycle time down |

---

## Sequencing logic & what NOT to do

**The dependency spine (do not reorder):** payment rail + auto-seal + reconciliation (H1) → first action loop + collectable tiers (H2) → retention/segmentation/copilot (H3) → ML/incrementality/breadth (H4). Every council converged on this: *truth that produces an empty chart and no action loses to a "good-enough number that already paused the campaign" — and to a free Shopify Sidekick alert.*

**Explicitly deferred / avoided (grounded):** no trained ML, autonomous autopilot, Markov/Shapley attribution, Neo4j dual-write, or new gold marts (beyond `gold_retention_curve`, `gold_channel_profit`, `gold_journey_dropoff`, segment membership) **until the deterministic recommend→action→measured-outcome loop closes with real brands** and produces the outcome-labeled dataset that is the only honest license to train. `serveCustomerScore` must stop being called "inference." Do not flip `ledger_source` to Iceberg-default until the dbt-StarRocks incremental-CTAS bug resolves.

**Rough quantified business impact:** H1 is the trial-conversion gate (target +15–30pp trial→paid; first ₹ collectable — today ARR is structurally $0-capable). H2 is the first attributable ROI story (5–12% cart-GMV recovery flowing through the billed ledger; 3–8% COD net-margin recovery) and the NRR engine (target NRR 115–130% via GMV growth + AI-action attach + multi-brand seats). H3/H4 unlock the retention/predictive paid tier and the upmarket (>₹50L GMV) segment — but their value is **0 until H1–H2 prove trust and collectability**.

**Files this roadmap actually touches (verified paths):** `apps/core/src/modules/attribution/internal/reconcile-attribution.ts`, `apps/core/src/modules/recommendation/internal/domain/detectors/registry.ts`, `apps/core/src/modules/billing/internal/application/seal-billing-period.ts`, `apps/core/src/modules/frontend-api/internal/bff.routes.ts`, `apps/core/src/main.ts` (CAPI), `db/migrations/0041_billing_plan_and_composition.sql` (+ new tier/payment migrations), `db/dbt/models/marts/feature_customer_daily.sql`, and the marts `gold_revenue_ledger`, `gold_marketing_attribution`, `gold_attribution_paths`, `silver_checkout_signal`, `silver_shipment`, `silver_order_state`, `silver_marketing_spend`, `gold_cohorts`.


---

# Appendix A — Open Risks (Adversarial Critique)

> Two skeptical reviewers (a CTO/Data-lead on groundedness+feasibility, a CRO/VC on revenue+market) were instructed to be ruthless. Their findings are kept verbatim so the strategy is read with eyes open.

## A.1 Groundedness & Feasibility (CTO/Data-lead lens)

**Verdict:** Strategically sound and unusually well-grounded — the 4 load-bearing facts (manual reconcile, brand-grain detectors, no payment rail, dev-only CAPI) all VERIFY in code — but it ships a recurring factual error (21 vs actual 24 registry IDs), a mis-cited abandoned-cart field, an over-claimed 'lakehouse revenue truth' (money spine is still PG read-shim), and a headline 'penny reconciliation' demo that secretly needs a non-existent payout-import connector; tighten these before any buyer or analyst greps the repo.

**Ungrounded claims (not backed by real Brain data):**
- Registry size is cited as '21 metric IDs' EVERYWHERE (North Star, Dashboard doc 'verified 21 ids', Persona doc, Competitor doc, Engineering-Impact doc). VERIFIED FALSE: the MetricId union in packages/metric-engine/src/registry.ts has 24 members (adds cost_confidence, effective_confidence beyond the 21, plus the H9 block). One doc inconsistently says '24' in its own opening then '21' later. A doc that brands itself on 'every number drills to source' miscounting its own registry is a credibility self-own.
- 'silver_checkout_signal.abandonedValueMinor' attributed to storefront-abandoned-cart.ts in the Decision-Intelligence + Persona docs. VERIFIED: storefront-abandoned-cart.ts emits abandonedSessions (a COUNT), NOT a value. The monetary field abandonedValueMinor lives in checkout-funnel.ts (SUM of total_price_minor). The claim is grounded but mis-cited; anyone building 'abandoned-cart recovery $-impact' off the wrong reader gets session counts, not rupees.
- Claims of 'penny-reconciled revenue TRUTH from the lakehouse' overreach. VERIFIED via _sources.yml: silver_order_state, silver_customers, and silver_marketing_spend still read DERIVED Postgres ledgers via the StarRocks JDBC read-shim (dev catalog connects as superuser 'brain', bypassing RLS), NOT raw Iceberg Bronze. The money/customer/spend spine is NOT lakehouse-sourced. Several docs DO caveat this, but the North Star executive summary and competitor positioning still imply end-to-end lakehouse revenue truth.
- 'cohort_retention' marketed as a retention curve in places. VERIFIED executive-metrics.ts: computeCohortRetention returns avg lifetime orders per customer, with the code comment 'Retention beyond order-count requires the order spine per-month activity (deferred to a richer cohort mart)'. The Dashboard/Retention docs correctly call this out, but the metric is registered as 'cohort_retention' and would mislead a buyer/analyst until relabeled.

**Feasibility risks:**
- ML feasibility is honestly gated but the docs still overstate readiness in places. VERIFIED: feature_customer_daily has only lifetime_orders + days_since_last_order (datediff on last_seen_at) — NO order-sequence timestamps (order_2_at, median_days_to_next_order). So BG/NBD + Gamma-Gamma predictive LTV, churn labels, and inter-purchase clock are ALL infeasible until Initiative 0 (feature substrate) ships. The Segmentation doc correctly flags this as 'the single hardest blocker', but the North Star / Year-2 roadmap schedule trained LTV/churn without making that dependency a hard gate in every doc.
- No training data / labels exist for any supervised model. ml.model_registry seeds exactly ONE row: customer_churn_rfm v0-deterministic (VERIFIED migration 0083:80), framework='deterministic', eval-gate-exempt. There is no Python training service, no outcome-labeled dataset (the recommend->action->outcome loop has never closed with a real user). Any Year-1/Year-2 'trained model' claim is a multi-quarter dependency chain, not a near-term deliverable.
- 'Reconciliation Receipt to the rupee vs Shopify/Razorpay payout' requires a payout-import seam that does NOT exist. The strategy treats it as 'pure read over existing marts', but there is no Shopify/Razorpay payout ingestion. gold_revenue_ledger is Brain's OWN computed realized revenue; reconciling it to an external payout needs a new connector + payout source-of-truth. The 'no new infra' claim is false for the headline demo.
- Auto-trigger reconcile via a new consumer-group on collector.event.v1 is plausible but the docs underweight that reconcileAttribution resolves journeys via silver_touchpoint.stitched_brain_id, and journey coverage is honestly partial (only brain_anon_id touches sessionize; docs cite ~23/94 in dev). So 'populated attribution day-1' will be SPARSE/low-coverage on real tenants, not a full chart — risking the same 'partial/confusing' trust problem it claims to solve.

**Revenue holes:**
- No payment rail — VERIFIED. invoice table (migration 0042) has NO payment_status/paid_at/payment_ref columns; no Razorpay/Stripe brand-charge code exists in apps/core/src/modules/billing. issue_invoice() produces a GST invoice but nothing collects money. ARR is structurally $0-capable until this is built. This is correctly identified as a blocker in the monetization doc but the North Star 'Year-1 collectable ARR book' depends entirely on net-new connector + dunning + reconciliation work that is scoped thinly.
- Manual month-close — VERIFIED. sealBillingPeriod's only non-export caller is bff.routes.ts:1944 (a manual button); infra/helm/cronworkflows contains spark-bronze only, NO billing-seal CronWorkflow. No automated revenue close exists.
- Flat single-dimension pricing — VERIFIED. billing_plan has exactly one rate_bps column (CHECK 0..10000), PK brand_id, no plan_tier/platform_fee/ai meter. The entire Free/Core/Growth/AI/Enterprise tier ladder + AI-action metering is net-new schema + entitlements rewiring; the doc's price points (Rs 4k/16k/40k) are invented with no demand evidence.
- AI-action meter monetization assumes the recommendation_action ledger reflects paid value, but detectors are ALL subject:'brand' (VERIFIED registry.ts lines 46/70/95/133). Until detectors re-grain to channel/campaign/SKU and the action loop closes with a real user, there are no billable AI actions to meter — the NRR engine has no fuel.

**Generic / fluff:**
- Repeated marketing-grade superlatives presented as facts: 'the single most honest data foundation in commerce intelligence', 'the most architecturally honest product in the category', 'category-of-one', 'un-fakeable'. These are unverifiable assertions, not engineering claims.
- Competitor stats (Triple Whale '15-25% discrepancy', Sidekick '~95% hallucination', 'RTO eats 20-40% of COD margin', '60k brands / $82B GMV', G2 scores) are quoted as settled fact across every doc with no source. Plausible directionally but uncited — should be flagged as estimates, not load-bearing evidence.
- Quantified business outcomes ('+15-30pp trial->paid', 'NRR 115-130%', '3-8% COD margin recovery', '5-15% CPA reduction', 'mid-six-figure ARR') are repeated verbatim across all docs as if validated. They are speculative ranges with zero internal data behind them (Brain has zero paying brands).

**Missing pieces:**
- No data-residency / multi-currency reconciliation plan despite India-first + Enterprise ambitions. Inspectable bill is single-currency-per-brand (noted in inventory); the reconciliation receipt and tier pricing ignore multi-currency brands entirely.
- No tenant-isolation/RLS verification for the new write-back paths (audience export to Klaviyo/Meta, CAPI go-live). A cross-tenant audience leak is a P0; the docs add new outbound connectors and a new consumer-group without addressing brand-scoped credential isolation or the consent suppression boundary at the sink.
- No backfill cost/runtime estimate for the one-shot attribution backfill over the full ledger, nor idempotency/throughput analysis for the new per-brand debounced reconcile consumer on the single shared collector.event.v1 lane (which already hosts many consumer groups). Reconcile scans the realized ledger per finalization — hot-brand thrash risk unaddressed.
- The dbt-StarRocks incremental-CTAS bug that gates the Iceberg ledger_source flip is repeatedly named as 'do not flip' but no doc proposes resolving it or converting the marts to table — it is left as a permanent caveat, which quietly undercuts the 'lakehouse-served money marts' narrative.
- No eval/observability plan for the Ask-Brain Copilot cost-tier routing claims (1:100:1k:10k); gen_ai.* tracing and llm-evals gates are mentioned but not specified as ship gates, so the 'non-hallucinating' guarantee is asserted, not enforced.

## A.2 Revenue & Market (CRO/VC lens)

**Verdict:** Architecturally honest and internally consistent, but commercially unproven and built on a flagship (reconcile-to-Shopify-payout) whose core data source does not exist in the repo and whose collection rail is unbuilt — fix the payout-connector gap, get ONE paying design partner, and model CAC before believing any ARR number here.

**Ungrounded claims (not backed by real Brain data):**
- FLAGSHIP IS UNGROUNDED: The 'Reconciliation Receipt — Brain vs Shopify/Razorpay payout to the rupee' is the stated #1 demo, fee-justifier, and +15-30pp conversion lever in EVERY document — but there is NO Shopify payout connector in the repo (grep for shopify_payout/payouts/balance-transactions/shopifyPayments returns ZERO), and NO silver_settlement mart (inventory admits 'No silver_settlement mart (deferred)'). The receipt compares the ledger against a payout figure that is not ingested on the Shopify side. The whole strategy's centerpiece reconciles to a number Brain does not have.
- The metric registry is cited as '21 metric IDs' in 4 of 6 documents and '24' in the Capstone exec summary — the actual count in registry.ts is 24. The flagship grounding doc (Dashboard Requirements) hard-codes a list of exactly 21 named IDs as its 'grounding contract,' so its own contract is wrong by 3.
- Quantified outcomes ('+15-30pp trial-to-paid', 'NRR 115-130%', '3-8% COD margin recovery', '5-12% cart-GMV recovery', '5-15% CPA reduction', '2.3x LTV by first-product-channel') are asserted with industry-rule-of-thumb framing but ZERO Brain-specific evidence — no pilot, no cohort, no design partner. Every revenue claim in the ARR model is a borrowed benchmark.
- 'AI add-on attach 30% → NRR 115-130%' (Monetization Part 3/5) is a spreadsheet fantasy: the AI actions being metered are deterministic recommendations nobody has yet acted on, and the docs themselves forbid billing the only inference path (serveCustomerScore) because it is 'a Gold read cosplaying as inference.'
- 'Recovered GMV flows through the very ledger Brain bills on' assumes attribution of recovered carts back to gold_revenue_ledger — but there is no outbound audience sink (zero klaviyo/custom_audience/audience_export matches), so recovery attribution cannot exist; the self-funding-fee-base claim is unbuilt on both ends.

**Feasibility risks:**
- The Reconciliation Receipt requires building TWO net-new connectors that don't exist (Shopify Payouts API ingestion + a settlement-truth mart) before the 'pure read, no new infra' claim holds. Every doc calls it 'a surfaced view over existing marts' — that is false. It is a connector build, the hardest, slowest, most credential-gated work in the whole plan, mis-scoped as a UI tile.
- Auto-triggering reconcileAttribution on finalization is described as low-risk, but the attribution marts default ledger_source='pg' and the Iceberg flip is BLOCKED on a dbt-StarRocks incremental-CTAS bug (inventory, repeatedly). Populating marts at scale on the PG path, per-brand debounced, on the single live Kafka lane, with idempotent credit_ids, is a real consumer-group + backpressure build — not a config flip.
- The payment rail (Razorpay charge against GST invoice + dunning + meter-invoice-payment-ledger reconciliation) is rated 0-3mo alongside 5 other H1 initiatives. Payment integration + dunning + reconciliation is itself a quarter of work for one team; bundling it with auto-seal, the receipt, attribution, and a trust-badge in one 3-month horizon is unachievable.
- Year-3 'graded autonomy with Temporal saga reversal + 60s kill switch + budget write-back to Meta/Google' depends on connectors with WRITE scope that today only have read/webhook scope, plus a reversal model for irreversible ad-platform actions (you cannot un-spend ad budget). Reversibility-as-first-class is asserted but ad-spend actions are structurally non-compensable.
- The India COD/RTO beachhead leans on gokwik.rto_predict and shiprocket/gokwik feeds that the inventory flags as partner-credential-gated with reserved-but-UNWIRED seams (gokwik.checkout_abandoned, otp). The 'uncontested moat' is partly gated on partner access Brain may not control.

**Revenue holes:**
- NO PAYMENT RAIL = STRUCTURALLY $0 ARR TODAY, confirmed in code: billing_plan has a single rate_bps column, no plan_tier/payment_status; invoice (0042) has no payment_status/paid_at; zero Razorpay/Stripe charge integration. Brain can issue a GST invoice and collect nothing. Every ARR number in the strategy is downstream of an unbuilt collection mechanism.
- %-of-GMV pricing is a buyer-adverse model the strategy under-stresses: a growing brand's bill rises automatically with no added value delivered that month — the exact 'charges more as volume grows' resentment the docs mock Peel for. At 0.75% on ₹50L GMV (₹37.5k/mo just the variable fee) a price-sensitive D2C founder will fight the meter; there is no value-cap, no ROI-gate, no 'we only bill if we found you money' alignment despite the trust narrative.
- Free tier = the reconciliation receipt, which is the single most expensive thing to build (two connectors). Giving away the one un-fakeable artifact as the land motion means the entire CAC is spent proving truth, and the upgrade trigger (Core's COD/RTO) is a SEPARATE feature — the free-to-paid bridge is a leap, not a slope.
- AI-action metering (the claimed NRR engine) bills approved recommendations at ₹15 each, but recommendations are brand-grain, advisory, and have never been acted on. Pricing a usage meter on a behavior with zero observed adoption is revenue fiction; the 30% attach assumption has no anchor.
- Monetization is single-currency-per-brand (inventory M1) and the inspectable bill filters to basis currency — multi-currency/cross-border brands (a large slice of ambitious D2C) bill separately, fragmenting invoices and undercutting the 'one trusted number' promise at exactly the higher-ACV end the Enterprise tier targets.
- No new-logo acquisition engine anywhere. Every growth lever is retention/expansion (daily-active, NRR, multi-brand seats). The Copilot doc even concedes it is 'a retention/stickiness lever, not a new-logo lever.' A %-of-GMV business with no top-of-funnel motion and a free tier that costs the most to serve has a CAC problem no document addresses.

**Generic / fluff:**
- The phrase 'the single most honest data foundation in commerce intelligence' (Capstone Exec Summary) is unfalsifiable marketing — 'honest' is not a category a buyer pays for; a CFO buys accuracy they can audit against an external source, which this strategy cannot yet provide.
- 'Trust is the conversion event' is repeated verbatim across all 6 documents as if repetition were proof. It is asserted, never evidenced — no design-partner data, no win/loss, no pilot. For a VC this is a belief dressed as a finding.
- RGUD (Reconciled GMV Under Decision) as North Star is elegant prose but operationally circular: it can only be non-zero AFTER the action loop closes with a real brand, which the docs concede has 'never closed with a real user.' A North Star you cannot measure for 6-12 months is a slide, not an instrument.
- 'Brain is the brain, Klaviyo the mouth' and 'rip out Brain and the lights go dark' are stickiness narratives with zero switching-cost evidence — there is no audience sink built, so nothing goes dark today.
- The competitor teardown's per-vendor 'Loves/Hates' lists are largely G2-review folklore (e.g., 'Triple Whale 15-25% discrepancy', 'Sidekick ~95% hallucination') presented as hard constants Brain will exploit — none are sourced and several are stale-sounding round numbers.

**Missing pieces:**
- No design partners, no pilot, no LOIs, no waitlist — zero evidence any merchant wants reconciled-to-payout truth enough to pay a % of GMV for it. The entire thesis rests on 'merchants distrust their tools,' which is plausible but unvalidated. A VC's first question — 'who has paid you and for what' — has no answer.
- No competitive response modeled. Shopify Sidekick/Magic is free and pre-installed with native payout access — Shopify can ship a 'reconciliation' view from inside the payout system Brain has to reverse-engineer. The strategy treats Shopify as a hallucinating joke while ignoring that Shopify owns the exact payout data Brain's flagship needs and Brain doesn't have.
- No CAC, payback period, sales motion, or GTM cost anywhere across 6 documents. ARR formulas exist; the cost to acquire the brands in them does not. For a %-of-GMV model with long value-realization, payback is the make-or-break number and it is absent.
- No data-network-effect / true moat argument beyond 'outcome-labeled dataset.' That dataset doesn't exist yet and won't until the action loop closes — so the defensibility claim is entirely prospective. Meanwhile the actual differentiator (COD/RTO settlement truth) is replicable by any India-focused entrant (GoKwik itself, a Razorpay analytics play) faster than Brain can build the Western-parity features it's also chasing.
- No churn/concentration analysis. %-of-GMV means revenue concentrates in a few large brands; losing one COD-heavy brand to RTO-driven GMV collapse (the exact thing Brain warns about) directly craters Brain's own revenue — Brain's ARR is correlated to its customers' worst quarter. This pro-cyclical exposure is never named.
- No verification that 'realized GMV' Brain meters equals what a merchant would accept as the billing basis. The billing basis (realized_revenue_ledger) is PG-derived, not lakehouse-sourced (inventory caveat), and order/customer/spend Silver still read PG read-shims — so 'lakehouse-sourced revenue truth,' used as a selling point, is not true for the billed number itself.

---

# Appendix B — Competitor Intelligence (Data)

## Triple Whale
**Positioning:** Self-styled "AI operating system for modern ecommerce" — Shopify-first analytics + attribution + AI agent layer (Moby). Used by ~60,000 brands / $82B+ GMV. Sells on ease-of-use, real-time dashboards, first-party pixel (Triple Pixel), and now agentic execution (Moby 2). Aimed primarily at DTC performance-marketing teams under ~$25M revenue who want a single pane of glass that matches platform reporting and tells them what to do next.
**Pricing:** Free tier (channel tracking, first/last-click attribution, 12-mo lookback, up to 10 users). Paid tiers commonly reported as Growth (~$129/mo, ~$107.50/mo annual), Pro (~$199-379/mo), Enterprise (~$279/mo+ custom). Pricing scales by annual GMV + package (Foundation/Automate/Enterprise); real-world quotes range ~$1,490 to ~$4,490+/mo at scale. Raised prices 30-50% across tiers in 2024 (Pro $300->$379), including some mid-contract existing customers.

**Key features:**
- Triple Pixel first-party tracking (claims 20-30% more conversions captured than GA4; 70-85% Meta match rate on iOS-heavy audiences)
- Seven attribution models incl. last-click, linear, time-decay, Total Impact, Clicks & Deterministic Views
- Compass: unified measurement layer stacking MTA + MMM + incrementality (continuously calibrating)
- Real-time blended dashboards (MER, POAS, NC-CPA, blended ROAS), summary boards
- CDP, RFM audiences, cohort analysis, 60/90-day LTV, cart analysis (Pro tier)
- Sonar: signal enrichment sending first-party conversion data back to Meta/ad platforms (CAPI-style)
- Creative Cockpit / product analytics, post-purchase surveys, influencer hub, Activity Feed
- APIs to push data out (Enterprise); supports Shopify/WooCommerce/BigCommerce + Custom Sales Platform API

**AI features:**
- Moby 2 (GA May 2026): agentic "AI ecommerce operator" in Copilot (approve actions) and Autopilot (autonomous within guardrails) modes
- Three Moby Specialists (rolling out): Media Buyer (bids/budgets across Meta/Google/TikTok), Creative Director (creative-fatigue detection + variant generation), Conversion Optimizer (landing-page build + CRO)
- Multi-model orchestration across Claude, GPT, and Gemini
- Autonomous actions: adjust Meta bids in real time, build/send Klaviyo campaigns, forecast inventory + flag restocks, generate + launch creative, build + sync audience segments, build Shopify landing pages
- Anomaly monitoring across spend, performance, and site behavior with real-time recommendations
- Permanent knowledge graph that remembers account-specific preferences; benchmarking across 60k brands
- Moby chat copilot for natural-language querying of business data

**Loved:**
- Ease of use and fast time-to-value vs heavier tools; clean real-time blended dashboards
- One pane of glass connecting Shopify + ad platforms + CRM with clear attribution
- Threshold alerts (ROAS/spend) that let teams act quickly and cut wasted spend
- Strong for performance-marketing depth; Moby NL querying praised
- First-party pixel meaningfully better match rates than raw Meta pixel post-iOS 14.5
- G2 ~4.4/5 across 350+ reviews; some standout CS reps (e.g. screen-share onboarding)

**Hated:**
- Attribution accuracy disputes: 15-25% discrepancies vs Shopify Analytics on same orders; users call attribution "buggy and unreliable"
- Click-based model doesn't learn causal channel contribution; seen as over-attributing in complex multi-step journeys
- 2024 price hikes (30-50%), including mid-contract; "deceptive billing," ignored cancellation requests, overbilling complaints
- Inconsistent support: some report no support despite paying $600+/mo, 3-month-old unresolved tickets, "worst in years"
- "Overwhelming" for ops teams without a dedicated analyst
- Non-Shopify stores are a second-class experience; Amazon/PayPal-direct cohorts can be invisible

**Gaps:**
- Deterministic revenue truth: no immutable, replayable bronze ledger — discrepancies vs Shopify erode trust; click-based credit isn't causal
- Platform breadth: built Shopify-first; weak on WooCommerce/Magento/BigCommerce/headless and offline/marketplace (Amazon) revenue
- No medallion-grade data lineage/audit; numbers aren't traceable to source, undermining "trust before insight"
- Billing/CS trust: opaque GMV-based pricing, mid-contract hikes, cancellation friction
- Confidence/freshness not surfaced as first-class — dashboards present numbers without explicit confidence or data-quality state
- Identity resolution is pixel-centric; no graph-based deterministic+probabilistic stitching across channels/devices

**Threat to Brain:** High. Triple Whale is the category-defining incumbent with 60k brands, strong brand mindshare, an aggressive agentic-AI narrative (Moby 2 in Autopilot), and the exact "insights -> actions -> decisions" framing Brain targets. Their multi-model orchestration (incl. Claude), knowledge graph, anomaly detection, and autonomous ad/email/creative execution directly overlap Brain's roadmap. Their first-mover distribution on the Shopify App Store and large GMV benchmark dataset are hard to match.
**Opportunity for Brain:** Win on trust and truth where Triple Whale is weakest. (1) Lead with deterministic, immutable, replayable revenue truth (bronze ledger, medallion lineage, audit) that reconciles to Shopify/Razorpay to the penny — directly attacking the 15-25% discrepancy + "buggy attribution" pain. (2) Surface confidence + freshness as first-class UI (no empty/over-confident charts) — "confidence before decisions." (3) Graph-based identity resolution (Neo4j) for journey reconstruction beyond a pixel. (4) True platform breadth (Woo/Magento/headless + marketplaces) so non-Shopify brands aren't second-class. (5) Transparent, predictable pricing + reliable support as a wedge against billing/CS resentment. (6) Explainable AI with deterministic-before-ML routing so autonomous actions are auditable, not black-box.

*Sources:* https://www.triplewhale.com/blog/moby-2 · https://www.prnewswire.com/news-releases/triple-whale-unveils-the-ai-operating-system-for-ecommerce-with-the-launch-of-moby-2-302776288.html · https://www.triplewhale.com/moby-agents · https://www.triplewhale.com/pricing · https://www.g2.com/products/triple-whale/reviews · https://www.g2.com/products/triple-whale/pricing · https://adlibrary.com/posts/triple-whale-review-2026 · https://www.triplewhale.com/blog/triple-whale-vs-northbeam · https://www.triplewhale.com/blog/sonar-signal-enrichment · https://uk.trustpilot.com/review/triplewhale.com · https://ecommercefastlane.com/triple-whale-review/

## Northbeam
**Positioning:** Marketing-intelligence platform for profitable growth, positioned as the rigorous, research-heavy attribution + media-mix-modeling tool for larger, data-mature DTC brands and agencies (typically $250k+/mo media spend). Differentiates on server-side data ingestion (not a client pixel as primary signal), ML multi-touch attribution, weekly-retrained MMM+, and feeding signals back to ad platforms via Apex. Platform-agnostic (Shopify, WooCommerce, BigCommerce, Magento, custom).
**Pricing:** Starter from $1,500/mo (some sources note a $1,000/mo entry), month-to-month, for brands under ~$1.5M annual / <$250k/mo media spend; includes MTA, Clicks+Deterministic Views, Apex, creative + correlation analysis. Professional (custom, annual/semi-annual) for >$250k/mo spend, adds Media Strategist. Enterprise (custom, annual) for >$500k/mo spend, adds MMM+, CSM, Slack support. Pricing is usage-based on pageview/data volume. Commonly requires ~3 months paid upfront (argued: time to accurate data).

**Key features:**
- First-party ML multi-touch attribution with fractional weighting + holdout testing
- Server-to-server ingestion: Shopify webhooks, direct platform API feeds, email/SMS exports, UTM-tagged links (less pixel-dependent)
- Clicks + Deterministic Views attribution model (deterministic view-through)
- MMM+ (Enterprise): ML media-mix model retrained weekly, ingests native MTA data, models non-linear effects, daily budget reallocation/forecasts
- Apex: deep ad-platform integration sending attribution signals back to algorithms to improve delivery ("deeper than CAPI")
- Creative analytics, correlation analysis, cross-channel sales attribution dashboards (paid social/search, CTV, email)
- Platform-agnostic support incl. non-Shopify and custom storefronts
- Unlimited integrations, users, and customizable dashboards on all plans

**AI features:**
- ML attribution models analyzing trillions of data points for channel credit + forecasting
- MMM+ machine-learning media mix model (weekly retrain, non-linear effects, daily forecast/budget adjustment)
- Data-discovery tools to detect hidden patterns and anomalies in large datasets
- Apex algorithmic signal feedback loop to ad platforms (Meta etc.) to improve delivery
- Forecasting / budget-allocation recommendations driven by ML

**Loved:**
- More sophisticated, research-grade MTA for complex multi-channel media mixes; favored by data-mature teams/agencies
- Server-side ingestion seen as more robust and less pixel/iOS-fragile than client-pixel tools
- Weekly-retrained MMM+ and incrementality/holdout rigor (vs traditional quarterly MMM)
- Platform-agnostic — supports non-Shopify and custom storefronts
- Apex signal feedback praised for improving ad-platform delivery
- Powerful for brands with dedicated analytics resources who can exploit the depth

**Hated:**
- Steep learning curve; many brands hire someone specifically to run it — too complex for lean teams
- Painful onboarding: reports of 29-day back-and-forth, a paying month with no usable product
- Customer service criticized as dismissive/absent post-sale ("never hear from them after closing")
- Slower reporting cadence limits live decision-making
- ~3 months upfront payment is a high commitment/cash barrier
- Some users found attribution underwhelming vs GA4; Magento2 extension technical issues reported
- High entry price ($1.5k/mo) prices out smaller brands

**Gaps:**
- No real-time / live feedback — slow cadence hurts intraday decisions
- Heavy implementation + ongoing expertise required; not self-serve; weak onboarding/support
- No mass-market low-end offering — leaves SMB/mid-market underserved
- Less of an agentic-execution story than Triple Whale's Moby 2 (more measurement than autonomous action)
- Reported attribution depth/accuracy complaints despite ML positioning
- Upfront commitment + opaque custom pricing create adoption friction

**Threat to Brain:** Moderate. Northbeam is the credibility benchmark for serious attribution + MMM among larger brands/agencies and is platform-agnostic, which overlaps Brain's multi-platform ambition. Its server-side ingestion and weekly MMM are technically respected. But its complexity, weak onboarding/support, slow cadence, high price, and thinner agentic-action layer limit how broadly it competes — it threatens Brain mainly at the high end / analytics-mature segment, not mass mid-market.
**Opportunity for Brain:** Beat Northbeam on accessibility + speed + action while matching its rigor. (1) Deliver research-grade attribution AND deterministic revenue truth without the steep learning curve or analyst headcount — guided onboarding, no empty/black-box states. (2) Real-time event-driven serving (StarRocks) for live decisions where Northbeam is slow. (3) Close the loop into actions/recommendations (Brain's decision intelligence) where Northbeam stays measurement-heavy. (4) Transparent pricing + no large upfront lock-in + reliable support to exploit Northbeam's post-sale CS resentment. (5) Explainable, deterministic-before-ML attribution with surfaced confidence/freshness so brands trust the model rather than treating it as a GA4-disagreeing black box. (6) True platform breadth done well (Woo/Magento/headless) without the Magento extension breakage they report.

*Sources:* https://www.northbeam.io/pricing · https://www.northbeam.io/blog/how-does-northbeam-use-ai · https://www.northbeam.io/features/apex · https://www.northbeam.io/northbeam-meta-introducing-northbeam-apex · https://www.mediaplanningtool.com/northbeam · https://www.g2.com/products/northbeam/reviews · https://www.trustpilot.com/review/northbeam.io · https://improvado.io/blog/northbeam-vs-triple-whale · https://www.triplewhale.com/blog/triple-whale-vs-northbeam · https://www.attnagency.com/blog/northbeam-shopify-review · https://www.aisystemscommerce.com/post/northbeam-review-2026-incrementality-attribution-dtc

## Lifetimely (by AMP / useamp.com)
**Positioning:** Positions itself as the 'AI Profit Agent' for Shopify (and Shopify+Amazon) DTC brands — deep, real-time P&L, net profit, LTV, cohort analysis and channel-level attribution. Distinct from Triple Whale: it leans on financial truth (true profit per product, CAC, contribution margin, LTV) rather than ad-attribution dashboards. Sells on 'data-driven retention and acquisition decisions' with a claimed average 12% LTV lift. Mid-market DTC sweet spot ($30k+/mo revenue).
**Pricing:** Free up to 50 orders/mo (full features). Paid: S $79/mo (up to 500 orders), M $149/mo (up to 3,000 orders), L $299/mo (up to 7,000 orders). Amazon data add-on +$75/mo. 14-day trial on paid tiers. Order-volume-banded.

**Key features:**
- Real-time net profit / P&L dashboard across Shopify and Amazon (Amazon is a $75/mo add-on)
- Best-in-class cohort analysis: segment by first purchase date, first product, acquisition channel, geography
- Predictive LTV: projected 30/60/90-day and 12-month LTV for any customer segment, trained on 'billions of customers globally'
- LTV Drivers report — surfaces products, promos, channels correlated with high-LTV customers
- Profit per product, customer CAC, ROAS, channel-level marketing attribution
- Custom dashboards + multi-store reporting; sales forecasting
- Slack integration for AI alerts/insights and daily reports
- Subscription data via Recharge integration

**AI features:**
- AI Profit Agent — monitors margins, detects trends/anomalies, and emits actionable recommendations ('tells you what to do')
- Predictive LTV model — forecasts segment lifetime value from a large cross-merchant historical dataset
- Anomaly detection on profit/margin metrics surfaced as opportunities
- Natural-language 'ask it anything' insight layer (positioned but light on documented technical detail/accuracy)

**Loved:**
- Profit/LTV insights 'impossible to get without time-consuming calculations' — far beyond native Shopify analytics
- Cohort reporting genuinely best-in-class for a Shopify app; users make daily decisions on it
- Clean, simplified, impactful dashboards; easy setup
- Highly responsive, knowledgeable support (named reps repeatedly praised)
- Strong long-term retention — many 3-5+ year users; 4.9/5 over ~493 reviews (97% 5-star)

**Hated:**
- Not true real-time — data refreshes every few hours, unusable for monitoring flash sales/time-sensitive promos
- No dedicated mobile app; browser UI clunky on mobile
- Shopify lock-in — WooCommerce, BigCommerce, headless unsupported; Amazon only via paid add-on
- Setup friction: manual COGS/payment-fee config + ad-account connections, 1-2 hrs + up to 24 hrs historical import
- Add-ons make the product feel limiting/costly; occasional minor glitches in daily reports
- Pricing 'a real line item' for stores under ~$30k/mo

**Gaps:**
- No multi-touch / cross-platform attribution depth (intentionally weaker than Triple Whale — imports CAC rather than resolving journeys)
- No identity resolution / journey reconstruction — relies on Shopify transaction data + imported ad spend
- Single-platform: no WooCommerce/Magento/headless; no first-party pixel; Amazon bolt-on only
- No deterministic-vs-ML transparency or confidence/freshness signals on predictions
- Predictive LTV is a black box — no documented accuracy, no explainability
- No recommendation-to-action execution loop or audit/decision log; insights are advisory only
- No data residency / regional / multi-tenant org->brand isolation story (single-store oriented)

**Threat to Brain:** Highest-overlap competitor on LTV + cohort + profit narrative, now wrapping it in an 'AI Profit Agent' that does anomaly detection + NL Q&A + recommendations — exactly Brain's INSIGHTS->RECOMMENDATIONS framing. 4.9/5 across ~493 reviews and 3-5yr retention prove deep merchant trust and stickiness. Cross-merchant LTV training data is a moat Brain cannot match early. They own the 'true profit' positioning Shopify DTC brands already pay for.
**Opportunity for Brain:** Beat Lifetimely on exactly its documented weaknesses: (1) true real-time vs their hours-stale refresh — Brain's Kafka->Bronze->serving path is genuinely streaming; (2) multi-platform + identity graph + journey reconstruction vs their Shopify-only, CAC-import attribution — Brain can show real cross-channel journeys, not just imported spend; (3) explainable, deterministic-first AI with confidence/freshness signals vs their black-box predictive LTV; (4) close the action loop — Brain turns recommendations into executed ACTIONS with an audit/decision log, where Lifetimely stops at advice; (5) brand isolation + regional residency for multi-brand/enterprise that single-store Lifetimely ignores. Lead with 'no empty charts / data foundation before dashboards' to contrast with their setup-friction + glitch complaints.

*Sources:* https://apps.shopify.com/lifetimely-lifetime-value-and-profit-analytics · https://apps.shopify.com/lifetimely-lifetime-value-and-profit-analytics/reviews · https://useamp.com/products/analytics · https://www.attnagency.com/blog/lifetimely-shopify-review · https://useamp.com/products/analytics/lifetimely-vs-triple-whale · http://www.lifetimely.io/

## Peel Insights (peelinsights.com)
**Positioning:** Self-described 'all-in-one analytics software Shopify brands trust to answer their hardest LTV questions' — a retention/cohort/subscription analytics platform for DTC. Headline value prop is operational: '80% reduction in time looking for data,' 150+ pre-built metrics, 30+ cohort KPIs. Strong subscription-analytics angle (deep Recharge/Smartrr/Skio/Stay.ai/Bold integrations). Aimed up-market at established DTC brands (free tier targets Smartrr users up to 16k orders/mo; paid tiers serve 29k-62k orders/mo).
**Pricing:** Free for Smartrr Subscription App users (up to 16k orders/mo). Essentials $499/mo (~$5,389/yr at 10% off; up to 29k orders/mo). Accelerate $899/mo (~$9,709/yr; up to 62k orders/mo; dedicated account manager). Custom enterprise tier. 7-day trial. Startup program for <$1M GMV brands. Same features across tiers — you pay more purely for order volume.

**Key features:**
- Retention analytics — repurchase rate, churn, cohort analysis (30+ cohort KPIs, 150+ metrics)
- Subscription analytics across Recharge, Bold, Skio, Smartrr, Stay.ai
- RFM segmentation + audience overlap analysis; Market Basket Analysis
- Product/SKU-level analytics, order analytics, ad-performance reporting
- Magic Dash customizable dashboards + Templates Library of pre-built reports
- Daily automated insight reports pushed to Slack/Email; daily data refresh
- Audience activation — enrich Klaviyo flows & Meta ad audiences from segments
- Custom Metrics with 1:1 strategy/analyst consulting; unlimited users/stores/metrics
- Integrations: Shopify, Amazon, Walmart, Klaviyo, Meta Ads, Google Analytics

**AI features:**
- 'AI insights' for cohort/segment building (referenced in case studies; light documentation)
- 'AI optimization' positioning for campaigns/audiences
- NOTE: No documented anomaly detection, predictive LTV, NL copilot, or forecasting — AI is marketing-light. (The 'Peel AI' brand found in search is an unrelated conversation-automation company, not this analytics product.)

**Loved:**
- Massive metric breadth (150+ metrics, 30+ cohort KPIs) and saves huge time vs manual analysis ('80% less time looking for data')
- Deep subscription analytics — standout for subscription-led DTC brands
- High-touch service: 1:1 strategy consulting and dedicated account managers; custom metric building
- Polished pre-built templates and customizable Magic Dash
- Klaviyo/Meta audience enrichment closes some loop into activation
- Top ratings where reviewed: 5.0/5 (Shopify, ~34 reviews), ~4.5/5 on G2

**Hated:**
- Expensive — $499/mo entry is high-end; smaller/startup brands can't justify it
- Pricing punishes growth: identical features at every tier, you just pay more as order volume rises (reviewers call this out explicitly)
- Data export is a raw 'data dump,' not the curated views — painful to manipulate in Excel
- Integration setup needs technical knowledge and is time-consuming
- No mobile app; reliance on real-time/online access limits on-the-go use
- Missing connectors (e.g., Snapchat Ads, ShipStation for COGS); gaps for emerging ad platforms
- Custom segmentation often needs manual Shopify tag setup; limited native behavioral tracking

**Gaps:**
- No real predictive/forecasting AI, no anomaly detection, no NL copilot — analytics is descriptive/diagnostic, not predictive or prescriptive
- No recommendation/action layer — surfaces metrics but doesn't tell you what to do or execute it
- No identity resolution / journey reconstruction; attribution is ad-performance reporting, not multi-touch journeys
- Export limited to data dumps; weaker self-serve data portability
- Connector gaps (Snapchat, ShipStation, emerging platforms); Shopify/Amazon/Walmart-centric
- No documented deterministic-vs-ML rigor, confidence/freshness signals, or explainability
- Flat-feature/volume-banded pricing creates a value cliff for high-volume brands

**Threat to Brain:** Owns the deep-retention/cohort/subscription-analytics niche for established DTC brands and commands premium pricing ($499-$899+/mo) with strong satisfaction and high-touch service — proving brands will pay a lot for LTV/retention answers. Their metric breadth (150+) and template library set a high bar for Brain's gold marts and dashboard completeness. Subscription-analytics depth is a category Brain has not emphasized.
**Opportunity for Brain:** Peel is descriptive analytics that stops at the chart — Brain's entire thesis (INSIGHTS->RECOMMENDATIONS->PREDICTIONS->ACTIONS->DECISIONS) is the layer Peel lacks. Win by: (1) adding genuine predictive LTV/churn (gold_customer_scores RFM/churn + ML platform) and anomaly detection + an explainable copilot where Peel has none; (2) closing the action loop with executed recommendations + decision/audit log vs Peel's read-only metrics; (3) real journey reconstruction + identity graph vs their ad-performance-only attribution; (4) honest, curated export + single-source metric registry vs their raw data-dump pain; (5) usage/value-fair pricing to exploit the loud complaint that Peel charges more for identical features at scale; (6) match their subscription-analytics depth via Razorpay/Recharge connectors. Brain can credibly market 'predictions and actions, not just dashboards.'

*Sources:* https://apps.shopify.com/peel-insights · https://www.peelinsights.com/ · https://www.peelinsights.com/pricing · https://aazarshad.com/resources/peel-insights-review/ · https://www.smbguide.com/review/peel-insights/ · https://www.g2.com/products/peel-analytics/reviews · https://www.trustradius.com/products/peel-insights/pricing

## Klaviyo
**Positioning:** Positions itself as the 'AI-first, autonomous B2C CRM' — consolidating customer data (CDP), messaging execution (email/SMS/RCS/WhatsApp/push), service, and analytics into one platform for DTC/e-commerce brands. The 2026 narrative is explicitly agentic: 'the first autonomous CRM built for the AI era.' Reality check: it remains, at its core, a messaging-and-retention engine bolted onto a lightweight CDP — it is a marketing-execution platform that markets itself as a CRM, not a profit/decision OS.
**Pricing:** Free up to 250 profiles (500 emails/mo, 150 SMS credits). Email scales by active-profile count: ~$20/mo at 500, $30 at 1k, $100 at 5k, $400 at 25k, up to ~$2,300/mo at 250k. SMS is separate credit budget from ~$15/mo (1 credit/SMS, 3+/MMS, plus carrier fees). Add-ons stack: Marketing Analytics from $100/mo (13.5k profiles); CDP from $500/mo (100k) to $9,100/mo (2M profiles). Real-world: a 35k-profile mid-size brand pays ~$575/mo all-in; a 430k-profile enterprise ~$4,030/mo. 2025 shift to active-profile billing raised costs and surprised users.

**Key features:**
- Email + SMS marketing automation (flows/campaigns) — the revenue core
- Customer Data Platform (CDP) add-on for unified profiles and real-time signals
- Marketing Analytics add-on: RFM, product, funnel, and cohort analyses
- Multi-channel: email, SMS, RCS, WhatsApp, mobile push
- Pre-built flows/templates, sign-up forms, A/B testing
- Segmentation engine over unified profiles
- Reviews product and reporting dashboards
- Last-touch attribution within configurable window
- MCP server exposing Klaviyo data to Claude/ChatGPT/external AI

**AI features:**
- Marketing Agent — AI strategist that generates campaigns/flows from prompts
- Customer Agent — 24/7 AI support+sales assistant (order tracking, returns, loyalty, subscriptions)
- Composer — agentic experience generating/optimizing full campaigns and flows from a single prompt (2026 launch, ~75 new features)
- Predicted CLV, churn-risk prediction, expected next order date
- Segments AI, Email AI, SMS AI, Reviews AI (generative content)
- Smart/Personalized Send Time, Channel Affinity
- Product Recommendations, Image Remix (AI product photo editing)
- Review Sentiment AI (topic clustering + sentiment)
- Flow Anomaly Detection, Brand Voice AI, Smart Translations
- Klaviyo claims 40+ AI features built since 2017

**Loved:**
- Best-in-class deep Shopify/e-commerce integration and data access
- Powerful, flexible segmentation and automation flows
- Strong predictive analytics (CLV, churn) baked in
- Generally solid deliverability with good inbox tooling
- Mature, feature-rich — 'the default' for DTC email/SMS
- Rapidly shipping AI agents and generative tooling

**Hated:**
- Cost escalates steeply as the contact list grows; widely called 'expensive'
- 2025 active-profile billing change caught many off guard and raised bills
- Steep learning curve; interface feels complicated with many flows/segments
- Limited support, especially on free/lower tiers (email support drops after 60 days on free)
- Reports of INFLATED attributed revenue (credit across opens/sends/renewals) — trust gap
- Add-on pricing (CDP, Analytics) makes the 'unified platform' expensive to actually unify
- Deliverability dips that support can't always explain

**Gaps:**
- No profit/margin truth — no COGS, fulfillment, discount, or refund subtraction; reports gross revenue only, so a 'winning' campaign can be margin-negative
- Last-touch attribution with window blind spots; weak multi-touch and cross-channel journey reconstruction
- No ad-spend/ROAS/CAC integration — paid channels live outside its analytics; can't connect acquisition cost to retention value
- Attribution overcounts revenue (self-serving credit), eroding decision trust
- Not a true data foundation — CDP is an add-on, not an immutable replayable lakehouse; limited identity resolution depth
- Analytics is reporting, not decision intelligence — surfaces metrics, doesn't reconcile revenue truth or drive auditable actions
- No deterministic 'capture truth' layer; numbers are platform-truth, not revenue-truth

**Threat to Brain:** High. Klaviyo is the incumbent system-of-engagement for DTC and owns the customer relationship + first-party data. Its 2026 land-grab into 'autonomous B2C CRM' with Marketing Agent, Customer Agent, and Composer is a direct move up the value chain toward insights->recommendations->actions — the exact AI-decisioning territory Brain targets. With its install base, data access, and capital, Klaviyo can ship 'good-enough' AI recommendations and frame itself as the AI OS for commerce, making Brain look redundant to buyers who already pay Klaviyo.
**Opportunity for Brain:** Win on REVENUE TRUTH and PROFIT, not messaging. Klaviyo reports gross, self-attributed, platform-truth revenue with no COGS/refunds/ad-spend — Brain's deterministic Bronze->Silver->Gold revenue ledger, multi-touch journey reconstruction, and CAC/margin marts (gold_cac, gold_revenue_ledger, gold_marketing_attribution) expose what Klaviyo structurally cannot: real profit per campaign/customer/channel. Position Brain as the neutral, auditable measurement and decision layer ABOVE Klaviyo (and ads, logistics, payments) — 'the truth Klaviyo grades its own homework against.' Integrate Klaviyo as a connector + a conversion-feedback/action sink rather than competing on email sends. Emphasize explainable, confidence-gated recommendations, brand isolation, and replayable/auditable data foundation as trust differentiators against Klaviyo's inflated-attribution reputation.

*Sources:* https://www.klaviyo.com/solutions/ai · https://www.klaviyo.com/platform · https://investors.klaviyo.com/news/news-details/2026/Klaviyo-Expands-AI-Agents-to-Power-the-Autonomous-B2C-CRM/default.aspx · https://martechedge.com/news/klaviyo-launches-ai-marketing-and-customer-agents-positioning-itself-as-ai-first-b2c-crm · https://www.moengage.com/blog/klaviyo-pricing/ · https://www.omnisend.com/blog/klaviyo-pricing/ · https://bsandco.us/blog-post/what-does-klaviyo-cost · https://www.g2.com/products/klaviyo/reviews · https://www.g2.com/products/klaviyo/reviews?qs=pros-and-cons · https://www.bloomanalytics.io/blog/klaviyo-email-marketing-roi-for-shopify · https://www.nudgify.com/attributed-revenue-klaviyo-vs-total-revenue/ · https://stormy.ai/blog/klaviyo-predictive-analytics-clv-strategy · https://www.eesel.ai/blog/klaviyo-ai

## Postscript
**Positioning:** Positions itself as the focused, best-of-breed SMS marketing and conversational-sales platform built EXCLUSIVELY for Shopify brands. The 2026 narrative pushes SMS from a broadcast channel to a two-way AI sales channel ('Shopper' AI assistant). It is the specialist challenger to Attentive — deliberately narrow: SMS-only, Shopify-only, North-America-only.
**Pricing:** Starter plan free with pay-per-message (~$0.015/SMS, $0.045/MMS) but carries a ~$25/mo minimum spend. Growth ~$100/mo, Professional ~$500/mo (adds automation, AI tools, dedicated support), Enterprise custom. 30-day trial with $100 messaging credits. Carrier fees stack on top of per-message cost. Note: list price headlines ($0/$29) are inconsistent across sources and the 'free' plan still bills minimums — a recurring billing complaint.

**Key features:**
- SMS + MMS campaigns and automation flows, native deep Shopify integration
- Two-way conversational messaging
- Subscriber list-growth tools (popups/forms), AI-powered list building
- Segmentation and targeting
- Performance analytics and reporting
- SMS compliance management (TCPA/carrier)
- Strong, frequently praised human customer support / strategy team

**AI features:**
- Shopper — always-on AI shopping assistant handling inbound SMS, answering product questions, making personalized recommendations, guiding to purchase (turns SMS into 24/7 two-way sales)
- Brand Center — trains AI on brand voice/tone/messaging guidelines, feeding all AI features
- Infinity Testing — AI tests hundreds of on-brand campaign/automation variants automatically
- AI message drafting matched to brand tone
- AI send-time optimization
- AI response recommendations for inbound conversations
- AI-powered subscriber growth

**Loved:**
- Best-in-class focused SMS execution for Shopify; clean, purpose-built
- Strong, knowledgeable, responsive human support (its #1 differentiator vs Attentive)
- Advanced personalization and automation for SMS
- Shopper AI assistant genuinely turns SMS into a conversational sales channel
- Good incremental revenue for Shopify DTC brands

**Hated:**
- Billing complaints: 'free' plan still charges $25+/mo minimums; users report unauthorized/surprise charges ($67.99, $500 upfront fees) and refused refunds
- Per-message + carrier fees add up fast for high-volume senders
- Deliverability complaints — messages not delivered while still being billed, then 'runaround' from support
- Recent shift toward AI-driven support reducing human availability (erodes its core strength)
- Native reporting OVER-ATTRIBUTES revenue (like most SMS tools)
- Limited documentation, smaller community
- Weak multi-currency support, discount-code logic issues

**Gaps:**
- SMS-only — no email, no push, no broader channels; brands must run a second platform and stitch attribution manually
- Shopify-only and North-America-only — no platform breadth, no international reach
- No true cross-channel attribution; native reporting overcounts and can't reconcile SMS vs email vs paid
- No profit/margin/CAC view — pure revenue/engagement reporting, no COGS or ad-spend
- No data foundation / CDP / identity graph — it's a channel tool, not a system of record
- No predictive CLV/churn analytics depth comparable to Klaviyo
- No decision intelligence — surfaces SMS performance, doesn't recommend cross-business actions

**Threat to Brain:** Low-to-moderate, and indirect. Postscript is a single-channel execution tool, not a data/decision platform — it does not compete for Brain's measurement, revenue-truth, or AI-decisioning layer. The only threat vector is its Shopper conversational-AI agent expanding into recommendations and the broader 'AI commerce assistant' framing, plus it being one more siloed source that fragments a brand's data and over-attributes its own revenue.
**Opportunity for Brain:** Postscript is an ideal CONNECTOR and conversion-feedback target, not a competitor. Brain should ingest Postscript SMS engagement/conversion events into Bronze, reconcile its over-attributed revenue against Brain's deterministic ledger, and feed back high-confidence audiences/triggers (churn-risk, predicted next-order, margin-aware segments) that Postscript itself can't compute. Pitch to Postscript-using brands: 'Postscript over-credits its own SMS revenue and only sees one channel — Brain shows the real profit and the true multi-touch journey across SMS, email, and ads, then tells Postscript exactly whom to text.' Brain's multi-channel journey reconstruction and margin truth directly fix Postscript's two biggest structural gaps (single-channel attribution + no profit view).

*Sources:* https://shyft.ai/tools/postscript · https://postscript.io/ · https://postscript.io/pricing · https://www.attnagency.com/blog/postscript-shopify-review · https://fiske.ai/postscript-review/ · https://apps.shopify.com/postscript-sms-marketing/reviews?page=2 · https://www.sequenzy.com/versus/postscript-vs-attentive · https://www.attentive.com/compare/attentive-vs-postscript · https://bsandco.us/blog-post/maximize-your-sales-with-postscript-sms-marketing · https://www.headwestguide.com/tools/postscript-sms · https://softabase.com/software/marketing/postscript

## Twilio Segment
**Positioning:** The market-defining, incumbent enterprise CDP. Positions as the data backbone that collects customer events once (via SDKs/APIs) and routes them to 700+ tools, plus identity resolution (Unify), audience building (Engage), data governance (Protocols), and increasingly an AI/personalization layer (CustomerAI). Sells to mid-market and enterprise; developer-first heritage but now marketer- and growth-team-oriented. Distribution muscle from Twilio (comms channels) is the strategic moat.
**Pricing:** Free: up to 1,000 visitors/mo, 2 sources. Team: from $120/mo for 10K MTUs (~$350 at 50K, ~$600 at 100K). Business: custom, typically $25K-$500K+/yr; unlocks Reverse ETL, identity resolution, advanced Protocols, premium support. Billing is MTU-based (Monthly Tracked Users) — every unique identifier including anonymous visitors counts.

**Key features:**
- Connections: 700+ pre-built source/destination integrations, the largest catalog in the category; clean web/mobile/server SDKs
- Unify: identity resolution into unified profiles; Linked Profiles/Linked Audiences query data directly in Snowflake/BigQuery/Redshift/Databricks (warehouse-aware, not pure SaaS-store)
- Engage: audience builder + journeys for activation
- Protocols: tracking plans, schema validation, real-time event governance to stop bad data upstream
- Reverse ETL + warehouse activation (Business tier)
- Live event debugger praised by reviewers for fast QA
- Functions: custom code sources/destinations

**AI features:**
- CustomerAI Predictions (GA 2025): out-of-the-box Likelihood to Purchase, Likelihood to Churn, Predicted LTV, and Custom Predictive Goals
- Recommendation Audiences & Recommendation Traits (GA): build audiences of users likely to buy a specific product/brand/category
- Model transparency: exposes the contributing events and their weights per prediction, exportable; Model Monitoring dashboard with conversion history
- Daily (up from weekly) predictive score refresh
- Generative AI features for technical and non-technical workflows (e.g., assisted audience/SQL building)
- No clearly marketed real-time anomaly-detection product surfaced in research

**Loved:**
- Largest integration catalog (700+) — route data anywhere without custom engineering
- Best-in-class developer experience: clean APIs, mature SDKs, excellent docs, fastest setup among CDPs (per G2)
- Centralizes data from many sources and activates in real time, saving large amounts of eng time
- Live debugger for fast event troubleshooting
- Strong identity resolution / unified profiles
- Brand trust and category-leader status reduce buying risk

**Hated:**
- MTU pricing is the single most-cited complaint: anonymous visitors count, so high-traffic B2C sites pay regardless of conversion — costs scale with traffic
- Expensive at scale; reviewers cite $400K+ deals and prohibitive cost for smaller teams
- Costs can spike unexpectedly when event volume grows
- Implementation and event-taxonomy design are hard to get right; early mistakes are costly long-term
- Poor customer support reported by multiple reviewers
- Reviewers explicitly name RudderStack and Snowplow as cheaper alternatives

**Gaps:**
- No deep commerce/revenue-truth layer: it is a generic event router, not a profit/CAC/ROAS/LTV outcome engine for brands
- Predictions are generic (purchase/churn/LTV) and not tied to verified order/settlement/return revenue — no revenue-truth grounding
- No logistics/RTO/COD or settlement-aware revenue reconciliation (critical for India/emerging commerce)
- Does not store data in a replayable, immutable Bronze it owns end-to-end the way a lakehouse-first system does; warehouse-native is bolted on, not foundational
- Weak on closed-loop action/decision execution — it activates audiences but does not orchestrate recommendation->action->outcome learning
- MTU model is structurally misaligned with high-anonymous-traffic ecommerce

**Threat to Brain:** High brand gravity and the default-choice incumbent for any company that wants a CDP. If a brand already runs Segment, it owns the event-collection and identity layer Brain also needs, and Segment is pushing into predictions/recommendations that overlap Brain's feature/decision layer. Twilio's distribution (messaging channels) lets it close the loop into activation. A brand could see Segment + a BI tool as 'good enough.'
**Opportunity for Brain:** Win on (1) commerce-specific revenue truth — verified order/settlement/return/COD/RTO-aware revenue and CAC/ROAS that Segment cannot produce; (2) event-volume/lakehouse pricing vs hated MTU model; (3) closed-loop decisions (recommendation->action->outcome->learning) vs Segment's stop-at-activation; (4) deterministic-before-ML, explainable, revenue-grounded predictions vs Segment's generic models; (5) faster time-to-value for commerce brands who find Segment's taxonomy/implementation painful. Position Brain as 'the outcome OS for commerce' that can even sit downstream of Segment's collection while owning the intelligence/decision layer.

*Sources:* https://www.twilio.com/en-us/products/connections/pricing · https://www.twilio.com/docs/segment/guides/usage-and-billing/mtus-and-throughput · https://www.stackscored.com/pricing/cdp/segment/ · https://segment.com/solutions/ai/predictions/ · https://www.twilio.com/en-us/changelog/2025/twilio-segment-ai-releases-general-availability · https://www.twilio.com/docs/segment/unify/traits/predictions · https://www.g2.com/products/twilio-segment/reviews?qs=pros-and-cons · https://www.g2.com/products/twilio-segment/pricing · https://cdp.com/articles/what-is-twilio-segment/ · https://www.twilio.com/en-us/blog/harnessing-contextual-data-segment-predictive-intelligence

## RudderStack
**Positioning:** The warehouse-native, developer-/data-team-first CDP positioned explicitly as the cheaper, data-you-own alternative to Segment. Core pitch: your customer data lives in YOUR cloud warehouse (Snowflake/BigQuery/Redshift/Databricks); RudderStack runs the pipelines, transformations, profiles and reverse-ETL on top of it and does not store your data. Segment API-compatible to make migration trivial. 2025 repositioning as 'The Agentic Customer Data Platform' with RudderAI. Open-source/self-hostable roots (Go + React, Elastic 2.0 license).
**Pricing:** Free: $0, 250K events/mo, 200+ destinations, warehouse + reverse ETL. Growth: from $265/mo for 1M events (up to ~25M; older data cited Starter at $500/mo for 3M, up to $1,425/mo for 25M). Enterprise: custom — 5-min sync, unlimited transformations, Profiles & Data Apps, HIPAA, SSO. Self-hosted: Elastic 2.0 open-source core. Event-volume based with no MTUs and no cliffs; pitched at 5-10x cheaper than Segment for high-growth/high-traffic.

**Key features:**
- Warehouse-native architecture: build the CDP inside your own warehouse, no separate vendor data store, eases compliance/data control
- Segment API compatibility: repoint existing SDKs to RudderStack endpoint — schemas/tracking code carry over, no re-instrumentation
- 200+ real-time destination integrations; 16 SDK sources; reverse ETL
- Profiles: build Customer 360 / identity stitching natively in the warehouse
- Data governance: tracking plans, schema validation, plus 2025 Infrastructure-as-Code (IaC) tracking plans with CI-driven validation
- Open-source / self-hosted edition under Elastic 2.0 (rudder-server)
- Transformations and warehouse-sync (down to 5-min on Enterprise)

**AI features:**
- RudderAI (2025): an agentic layer anchored by CLI + MCP — a natural-language control plane to operate RudderStack and build/self-serve audiences via chat
- Predictions: runs natively in Snowpark, auto-trains/runs ML for churn, LTV, and propensity scoring — no separate MLOps
- Profiles accelerates time-to-value for AI/ML models (feature generation in-warehouse)
- AI-native audience self-serve (chat or UI) over warehouse data for ad targeting and lifecycle personalization
- Positioned as the governed 'data foundation for AI' (Snowflake AI Data Cloud partnership)

**Loved:**
- Event-based, no-MTU pricing — major cost savings vs Segment, especially for high anonymous-traffic B2C; primary migration motivator on G2
- Warehouse-native: you own/control the data, no third-party data store, easier privacy/compliance
- Drop-in Segment compatibility makes switching low-risk
- Open-source/self-hosted option lets teams collect unlimited data without event-budget anxiety
- Fine-grained control over what data forwards to which tool
- Some reviewers praise fast, knowledgeable technical support

**Hated:**
- Documentation gaps — insufficient guidance setting up new sources/destinations/transformations; onboarding takes time, few quick-start videos
- UI gets confusing with many sources/destinations
- Setup complexity overwhelming for less-technical users (it is a data-team tool, not a marketer tool)
- Slow/inefficient support for NON-technical issues (billing, access, invoicing, user roles) — contradicts the praise above
- Limited customization options cited by some users
- Value depends on you already running and operating a warehouse well

**Gaps:**
- Requires you to bring/operate a cloud data warehouse — no value without it; not turnkey for brands without a data team
- Generic CDP/data-infra framing, not commerce-outcome focused — no revenue truth, CAC/ROAS, logistics/RTO/COD/settlement reconciliation
- Predictions are generic warehouse ML (churn/LTV/propensity), not grounded in verified commerce revenue or explainable decision loops
- Marketer/business-team UX is weak; it is engineer-centric
- No deep activation/messaging channels of its own (relies on destinations) — does not close the recommendation->action->outcome loop
- Onboarding/docs friction slows time-to-value despite 'days not months' marketing

**Threat to Brain:** Architecturally the closest philosophical competitor: warehouse/lakehouse-native, data-ownership, governed pipelines, in-warehouse Profiles + Predictions, and a 2025 agentic/MCP layer — all overlapping Brain's medallion + feature + decision narrative. Its no-MTU pricing and Segment-compatibility make it the value choice for technical commerce teams, and RudderAI directly competes with Brain's AI-decision positioning. It could be 'good enough' for brands with strong data teams.
**Opportunity for Brain:** RudderStack stops at governed data + generic predictions and assumes a capable in-house data team. Brain wins by being (1) turnkey commerce intelligence — no warehouse-operating burden; Brain owns the full Bronze->Gold->Feature->Decision stack out of the box; (2) commerce revenue-truth and outcome metrics (verified revenue, CAC, ROAS, repeat/LTV, RTO/COD/settlement) RudderStack has no concept of; (3) explainable deterministic-before-ML predictions grounded in real money vs generic Snowpark models; (4) closed-loop recommendation->action->outcome->learning with native activation, where RudderStack only ships data; (5) marketer/operator-friendly UX vs RudderStack's engineer-only surface and weak docs. Brain can also interoperate (ingest from a RudderStack/warehouse) while owning the intelligence and decisions layer.

*Sources:* https://www.rudderstack.com/pricing/ · https://www.rudderstack.com/warehouse-native-cdp/ · https://www.rudderstack.com/competitors/rudderstack-vs-segment/ · https://www.rudderstack.com/blog/introducing-rudderai/ · https://www.rudderstack.com/blog/announcing-rudderstack-predictions-automate-churn-and-conversion-scores-in-your-warehouse/ · https://www.rudderstack.com/blog/how-rudderstack-profiles-accelerates-time-to-value-for-aiml-models/ · https://github.com/rudderlabs/rudder-server · https://www.g2.com/products/rudderstack/reviews?qs=pros-and-cons · https://cdp.com/articles/what-is-rudderstack/ · https://www.prnewswire.com/news-releases/rudderstack-accelerates-ai-native-growth-launches-iac-driven-governance-for-trusted-customer-context-302676493.html

## Elevar
**Positioning:** The de-facto server-side conversion-tracking layer for Shopify DTC brands (6,500+ merchants incl. Vuori, SKIMS, Rothy's). It is data infrastructure / signal-quality plumbing, NOT an analytics or attribution dashboard. Sells on a 99% conversion-delivery guarantee to ad destinations (Meta CAPI, GA4, TikTok, etc.) and a 10-20% lift in attributed conversions vs client-side only. Official Shopify checkout-extensibility preferred partner. Deliberately narrow: it makes the SIGNAL clean and gets it to the ad platforms; it leaves modeling/reporting to others.
**Pricing:** Transparent published tiers: Core $225/mo (2k orders, 2 destinations, $0.50 overage); Advanced $650/mo (10k orders, 4 destinations, profit optimization, $0.15 overage); Premium $1,250/mo (30k orders, 10 destinations, global markets/multi-storefront/API, $0.10 overage); Elite from $3,000/mo (75k orders, 25 destinations, $0.04 overage). Free Starter tier for eval. Add-ons billed separately: Expert install $1,000, Headless/API install $4,500, Analyst services $500-$1,000/mo. Note: implementation is NOT bundled.

**Key features:**
- Server-side event routing (Shopify backend -> Meta CAPI, GA4, TikTok, Pinterest, Snap, Klaviyo via S2S)
- Pre-built Shopify-optimized data layer (standardized ecommerce event object, no DOM scraping)
- Session Enrichment - stitches anonymous sessions across device/time to recover original-source attribution
- Identity resolution to recognize returning anonymous users
- 40+ marketing destinations; up to 25 on top tier
- Consent/privacy: Google Consent Mode v2, OneTrust, Cookiebot; multi-market per-market pixels
- Real-time tag-error monitoring & alerts (catches silent tracking failures)
- Profit Optimization 'Boosted Event' - sends real margin (cost+discounts+margin fallback) instead of revenue into ad bidders
- Funnels/visual analytics (reportedly unreliable per reviews)
- Global markets, multi-storefront, API framework (Premium/Elite tiers)

**AI features:**
- No genuine AI/ML. Profit Optimization is deterministic margin computation injected into ad-platform bidding (the ML lives in Meta/Google, not Elevar)
- Anomaly detection is rule-based tag-error monitoring/alerting, not learned anomaly models
- No copilot, no predictions, no recommendations, no forecasting - positioned as data infrastructure, not an algorithmic optimization tool

**Loved:**
- Customer support / onboarding repeatedly singled out as best-in-class ('cannot think of a better support experience'); named reps praised
- Real, dashboard-visible conversion recovery (10-20% more attributed conversions; clean consistent data across destinations)
- Real-time monitoring prevents silent tracking-failure revenue drain
- Shopify checkout-extensibility migration handled as official preferred partner
- Profit Optimization lets brands bid to margin instead of top-line revenue

**Hated:**
- Setup complexity is the #1 complaint - ~74% of Reddit issues are setup, not function; needs real GTM/API-token knowledge; multiple support tickets to get live
- Pricing escalates fast; BFCM/viral order spikes trigger surprise overage bills
- 'Reports always show 100% accuracy by default' called misleading; Funnels feature reported as unreliable/inoperable
- At least one closed-without-reply support ticket (inconsistent with the praise)
- Implementation not included - real cost is plan + $1k-$4.5k install + analyst retainer
- Shopify-only; WooCommerce/Magento/BigCommerce support materially lags
- Poor proactive comms on platform/API changes (e.g. Shopify's Jan-2026 'Optimized' pixel default change)

**Gaps:**
- No attribution modeling, no unified reporting dashboard, no creative analytics - must be paired with Triple Whale/Northbeam/Rockerbox, inflating total cost
- No MMM, no incrementality testing, no causal measurement
- No true AI/ML: no predictions (LTV/churn/CAC), no recommendations, no copilot, no learned anomaly detection
- Shopify-centric; weak multi-platform / headless / non-Shopify ecommerce coverage
- No decision/action layer - it improves signal but doesn't tell the brand what to DO
- Profit data depends on merchant-supplied cost/margin config; no automated COGS truth or order-line cost lineage
- No identity graph beyond session stitching; no cross-channel customer 360

**Threat to Brain:** Medium. Elevar owns the Shopify signal-quality beachhead Brain depends on - if a brand already trusts Elevar for CAPI delivery and consent, Brain's universal pixel + connector ingestion can be seen as redundant plumbing, making it harder to justify ripping out tracking. Its profit-to-ad-bidder feature directly overlaps Brain's CAC/profit ambitions at the signal layer, and its support reputation sets a high bar. It is sticky because it sits in the critical conversion-tracking path.
**Opportunity for Brain:** Win on everything Elevar deliberately omits and treat it as a complement, not a fight. Elevar stops at 'clean signal delivered to ad platforms'; Brain continues to Bronze->Silver->Gold->Feature Layer->Recommendations->Decisions. Pitch: Brain ingests the SAME server-side events (or even ingests Elevar's output), then adds deterministic revenue truth, identity graph, attribution + incrementality, LTV/churn/CAC predictions, explainable recommendations, and an action/decision layer - none of which Elevar has. Specifically: (1) replace 'reports always show 100% accuracy' with measurable confidence + freshness; (2) solve Elevar's setup-complexity pain via Brain's auto-install pixel + guided onboarding; (3) be platform-agnostic (Woo/Magento/GA4 connectors) where Elevar is Shopify-only; (4) turn Elevar's deterministic profit signal into a true margin-aware decision engine backed by order-line COGS lineage. Elevar feeds optimization to Meta's black box; Brain gives the brand the explainable why and what-to-do.

*Sources:* https://getelevar.com/pricing-and-plans/ · https://getelevar.com/profit-optimization/ · https://docs.getelevar.com/docs/understanding-profit-optimization · https://www.hubbvee.com/blog/elevar-server-side-tracking-review-2026 · https://apps.shopify.com/gtm-datalayer-by-elevar/reviews · https://www.aimerce.ai/blogs/seo/top-5-elevar-alternatives-for-shopify-tracking-in-2026 · https://joindatacops.com/resources/elevar-alternative-shopify/ · https://attribuly.com/blogs/elevar-pricing-ultimate-guide-shopify-server-side-tracking/

## Rockerbox
**Positioning:** 'The Platform of Record for All Marketing Measurement' for mid-market-to-enterprise multi-channel DTC/B2C brands. The differentiator: unify MTA + MMM + managed incrementality testing on one SOC2-certified, reconciled dataset (100+ integrations) and let brands compare/calibrate the three methods side-by-side rather than trust a single black-box number. Explicitly positions transparency over single-source-of-truth automation. Real adoption trigger is ~$5M-$15M+ annual ad spend, when platform-reported numbers diverge. Acquired by DoubleVerify for $85M cash (Feb 2025).
**Pricing:** Opaque, sales-gated, spend-based. No published tiers. Priced primarily on monthly marketing spend under management (not per-conversion or per-seat), plus data volume, channel count, and service level. Third-party estimate: ~$2,000 per feature per month, scaling with volume; full-stack deployments materially higher. Designed for $5M+ ad-spend brands - not viable for SMBs.

**Key features:**
- Multi-Touch Attribution (MTA) - cross-channel, daily tactical credit assignment (not just last-click)
- Marketing Mix Modeling (MMM) - statistical historical analysis, budget allocation, forecasting, scenario planning
- Managed Incrementality Testing - geo-holdouts/PSA tests for causal validation
- Cross-methodology reconciliation - shows where MTA, MMM, and incrementality agree/diverge; calibration of MTA with MMM
- Centralized SOC2 data foundation - 100+ integrations incl. offline (Postie direct mail, Tatari TV/OTT, CallRail)
- Customer journey mapping; user-level de-duplicated attribution
- Data export to Snowflake/BigQuery/Redshift
- Scenario planning / budget what-if forecasting
- Rockerbox Relay - feeds attribution results back to Meta as an optimization signal (post-DV)

**AI features:**
- Primarily statistical/econometric ML, not generative AI: MMM is regression/Bayesian-style statistical modeling; incrementality is experimental causal inference
- Model calibration - test results refine MTA/MMM outputs (a feedback loop, not a copilot)
- Scenario planning / forecasting on MMM outputs
- Rockerbox Relay - closed-loop activation feeding measurement back to Meta bidding; DoubleVerify roadmap pairs it with DV Scibids AI for a measurement->optimization->activation loop
- No conversational copilot or LLM-driven insight narration surfaced; emphasis is transparent statistical method comparison, explicitly NOT black-box AI

**Loved:**
- Only platform unifying MTA + MMM + incrementality in one system; side-by-side model comparison and calibrating MTA with MMM are the standout praised capabilities
- Comprehensive cross-channel view incl. hard-to-measure offline (linear TV, direct mail, affiliate)
- Documented outcomes: TULA validated non-brand-search incrementality (200%+ MoM spend increase); Gorjana scaled spend 10x while doubling ROAS; affiliate to ~$2M run rate at 17% lower CPA
- Gartner/G2 'High Performer' recognition in attribution
- Responsive support and straightforward integrations (cited alongside the opposite complaint - experience varies)

**Hated:**
- Setup is tedious - reportedly needs a full-time developer, warehouse readiness, and ongoing analyst bandwidth; long time-to-value
- Slow time-to-insight - dashboards 'sometimes break' and it takes a long period to accumulate enough data for actionable changes
- Attribution transparency complaints - limited visibility into HOW credit is assigned ('Meta drove 38%' with no clear derivation), ironic given its transparency positioning
- Started charging extra for some services
- Expensive; only justifiable at high spend
- Post-acquisition uncertainty - operators watching for roadmap shifts under DoubleVerify

**Gaps:**
- Floor at $5M-$15M ad spend - structurally cannot serve SMB/early-stage brands (a wide-open segment)
- Pure measurement, historically no activation/automation layer (Relay is early and Meta-only); no automated bidding or creative optimization native
- Heavy implementation burden - requires data warehouse + dedicated analyst; not self-serve
- Attribution-credit opacity undercuts its own transparency claim - no explainable per-touchpoint rationale
- Slow data accumulation before insights are actionable
- Marketing-measurement focused - not a full commerce OS: no deep customer-level LTV/churn/retention engine, no order-line revenue truth, no recommendations/decision execution
- Roadmap risk and potential enterprise-ification under DoubleVerify

**Threat to Brain:** Medium-high at the high end, low at Brain's likely entry segment. Rockerbox is the credible incumbent for the rigorous MTA+MMM+incrementality measurement Brain's attribution/decision-intelligence ambitions aspire to, now backed by DoubleVerify's capital, enterprise distribution, and an activation loop (Relay + Scibids). If Brain moves upmarket it collides directly with a well-funded, Gartner-recognized incumbent that already does causal measurement. However, its $5M+ floor, heavy setup, warehouse dependency, and credit-opacity leave its lower-mid market and its trust/explainability flank exposed.
**Opportunity for Brain:** Attack the segment and the experience Rockerbox can't/won't serve. (1) Serve the under-$5M and fast-growing mid-market with self-serve onboarding - no full-time dev, no warehouse-readiness project, no analyst retainer - because Brain already owns ingestion (pixel + connectors) and the lakehouse. (2) Beat its transparency gap with Brain's single-source metric registry + explainable AI: never report '38% from Meta' without a drill-to-source, confidence, and freshness - turn Rockerbox's #1 complaint into Brain's headline. (3) Go beyond measurement to ACTION: Rockerbox stops at numbers and a Meta-only Relay; Brain closes the loop to recommendations -> predictions -> decisions -> outcomes -> learning across the whole commerce OS (LTV/churn/CAC, retention, customer 360). (4) Offer deterministic-before-ML credibility (revenue truth, identity graph, incrementality on the same replayable Bronze) so causal rigor doesn't require a separate $2k/feature/mo line item. (5) Capitalize on DoubleVerify post-acquisition roadmap uncertainty to win brands wary of enterprise-ification and lock-in.

*Sources:* https://www.rockerbox.com/ · https://www.rockerbox.com/plans · https://www.aisystemscommerce.com/post/rockerbox-review-2026 · https://www.g2.com/products/rockerbox/reviews · https://www.businesswire.com/news/home/20250226250084/en/DoubleVerify-To-Acquire-Rockerbox-Adding-Outcome-Measurement-and-Attribution-Capabilities-to-Its-Suite-of-Performance-Measurement-and-Optimization-Solutions · https://www.vendr.com/marketplace/rockerbox · https://doubleverify.com/products/advertisers/prove · https://segmentstream.com/blog/articles/rockerbox-alternatives

## Daasity
**Positioning:** Warehouse-native modular data platform (MDP) for omnichannel consumer/DTC brands. Sells 'Enterprise-level analytics, no data engineering' to mid-market/enterprise brands ($5M-$150M+, ideally $25M+) selling across 3+ sales channels and 5+ ad/marketing platforms. It is fundamentally a data-infrastructure play (ETL + dbt/semantic modeling into Snowflake/BigQuery, then Looker/dashboards on top), NOT a plug-and-play app. Notable customers: Unilever, Guess, KitchenAid, Timex.
**Pricing:** Shopify App Store lists $1,899/month with a 14-day free trial; usage charges based on annualized rolling 3-month average of total revenue. Other sources cite an entry point as low as $199/mo but real enterprise implementations are custom and substantially higher. Pricing is not publicly transparent — they push to demo/trial.

**Key features:**
- 60-300+ native connectors across ecommerce, retail POS, Amazon, ad platforms, NetSuite, Salesforce, inventory systems
- Writes raw data to a customer-owned warehouse (Snowflake/BigQuery), models with dbt + a proprietary semantic/standardized-metrics layer
- Pre-built + fully custom dashboards/reports; custom SQL; Looker-based exploration
- Omnichannel single-source-of-truth unifying digital + retail + wholesale
- Product/merchandising analytics (size/color/style), LTV, repeat-purchase & churn, cross-sell/upsell, pricing & promo optimization
- Reverse-ETL 'data activation' back into tools like Klaviyo and Meta
- Syndicated retail benchmarking via Nielsen and SPINS data (differentiator for CPG/retail brands)

**AI features:**
- Natural-language agent layer over the modeled warehouse tables — ask questions in plain English, primary output is an answer 'with the work shown' rather than a dashboard tile
- Deterministic LTV / repeat-purchase / churn analytics (semantic-model driven, not clearly ML/predictive)
- No publicly documented anomaly detection, proactive alerting, or predictive/forecasting copilot on the marketing site — AI is thin and recent vs. the data-modeling core

**Loved:**
- Genuine single-source-of-truth across many disparate systems (Shopify, NetSuite, Amazon, Northbeam, marketing channels)
- Easy to ingest/consolidate new data sources; builds a real warehouse you own
- Flexibility/customization — data models and reporting evolve as needs grow
- Hands-on team treated 'like teammates not a 3rd-party vendor'; support builds reports for you
- Cost-effective vs building an in-house data stack; used for investor presentations & internal decisions
- 4.5/5 on Shopify App Store (51 reviews, 90% 5-star)

**Hated:**
- Workflow is comprehensive but very time-consuming; significant investment that still needs internal analyst resources
- Steep learning curve on Daasity/Looker to self-serve; teams stay reliant on Daasity's team to resolve data discrepancies
- Opaque usage-based pricing — customers want clearer packaging to forecast/justify spend
- 3-4 week (days-to-months) implementation due to dbt modeling layer; ongoing maintenance burden
- At least one scathing review: 'possibly the worst implementation I have ever experienced' — poor PM, timeline/cost overruns, and the team incl. cofounder left abruptly mid-engagement
- Requires a data-mature team / someone who can work with a warehouse

**Gaps:**
- No real-time event/journey layer — it's batch ETL into a warehouse, not streaming; freshness is a function of sync cadence
- AI is shallow: a NL query agent bolted on, no robust prediction/anomaly/recommendation engine or explainable-AI decisioning
- No identity-graph / deterministic identity resolution as a first-class capability
- Heavy time-to-value (weeks-months) and high analyst dependency — anti-self-serve
- Does not turn analysis into recommended ACTIONS/decisions; outputs answers and dashboards, leaving the 'so what / now what' to humans
- Opaque, revenue-scaled pricing creates trust friction

**Threat to Brain:** Daasity is the closest architectural analog to Brain among the two — it also champions warehouse-native, data-modeled, single-source-of-truth, multi-channel truth (the same 'capture truth' thesis). For data-mature mid-market/enterprise brands it owns credibility on data ownership, omnichannel/retail+wholesale breadth, and CPG syndicated benchmarking (Nielsen/SPINS) that Brain does not have. If a prospect already values 'own your data in a warehouse,' Daasity is the incumbent answer and a real displacement threat at the $25M+ tier.
**Opportunity for Brain:** Beat Daasity on time-to-value and the action layer. Daasity's fatal weaknesses are weeks-to-months setup, heavy analyst dependency, shallow AI, and no real-time/decisioning. Brain can win by: (1) deterministic-first, fast-onboard medallion that surfaces trusted metrics in days not weeks with no analyst required; (2) real-time event/journey + identity-graph that Daasity lacks; (3) closing the loop from insight -> recommendation -> prediction -> ACTION/decision with explainable AI (single-source metric registry + confidence/freshness), where Daasity stops at 'answer with work shown'; (4) transparent pricing vs Daasity's opaque revenue-scaled model. Position Brain as 'Daasity's data rigor without the data team or the wait, plus it actually decides.'

*Sources:* https://www.daasity.com/ · https://www.daasity.com/post/best-ecommerce-analytics-software-for-fast-growing-dtc-brands · https://apps.shopify.com/daasity · https://www.g2.com/products/daasity/reviews · https://www.g2.com/products/daasity/reviews?qs=pros-and-cons · https://www.polaranalytics.com/comparison/triple-whale-vs-daasity · https://podvector.ai/articles/ai-analytics/ai-agents/ai-analytics-platforms-for-shopify-what-it-looks-like-for-pod-sellers · https://www.aisystemscommerce.com/post/daasity-review-ecommerce-data-platform

## Shopify Analytics / Shopify Magic (incl. Sidekick)
**Positioning:** The native, built-in analytics + AI layer inside Shopify admin. Shopify Analytics = commerce reporting (sales/orders/sessions/conversion) bundled with every plan. Shopify Magic = free generative-AI suite (text, image editing) and Sidekick = conversational AI commerce assistant. Positioned as zero-setup, zero-cost, in-context defaults — 'good enough' analytics and AI for the millions of Shopify merchants. Explicitly NOT a cross-functional BI layer; a commerce reporting tool inside a commerce platform.
**Pricing:** Shopify Magic and Sidekick are 100% free on all plans (Basic/Shopify/Grow/Advanced/Plus) with no usage caps. Analytics is bundled: basic on all plans; custom reports require Advanced ($229/mo); cohort/ShopifyQL/org/B2B analytics require Plus (from ~$2,000/mo). Custom-app generation gated to Grow+ after April 2026.

**Key features:**
- Built-in Analytics dashboard on all plans: revenue, orders, sessions, conversion rate, prebuilt reports
- Custom reports (build any dimension/metric combo) gated to Advanced plan ($229/mo)+
- Cohort analysis, ShopifyQL, multi-store/org analytics, B2B analytics gated to Shopify Plus
- Winter 2025/2026 editions added a more flexible/customizable dashboard (choose metrics & dimensions)
- Deep, zero-config integration with the merchant's own store data, products, orders, and admin workflows
- Sidekick can build Shopify Flow automations from natural language and generate basic custom apps (Polaris + GraphQL Admin API)

**AI features:**
- Sidekick: conversational assistant that queries store analytics, compares periods, identifies trends, builds Flow automations, and generates custom apps from natural language
- Sidekick Pulse: proactive anomaly detection / alerting — flags declining sales, top-performing products, discount opportunities, and benchmarks store performance vs global market trends
- Shopify Magic: unlimited AI text generation (product descriptions, emails, blogs), AI image editing, multi-language (8 languages)
- All free across every plan as of April 2026 (custom-app generation gated to Grow+ after April 2026)

**Loved:**
- Free and zero-setup — instantly available in-context inside the admin every merchant already uses
- Magic genuinely saves time on copywriting/product descriptions/images (cited 15+ hrs/week)
- Sidekick Pulse's proactive 'tells you when something is wrong' alerting is a real UX leap vs pull-only dashboards
- Conversational analytics lowers the barrier for non-technical merchants
- Tightest possible data integration — it IS the store

**Hated:**
- Hallucinations are the dominant complaint: invents product specs/dimensions/materials, fabricates alphanumeric product codes corrupting catalogs, hallucinates tax/regulatory answers, reverts language despite instructions, ignores negative-constraint brand rules
- Reviewers caught ~95% hallucination/SEO-drift rate needing human review before publish (23 client audits)
- Sidekick lacks real store context — can't see theme code, metafields, custom functions, tag logic; 'prefers to hallucinate rather than admit it doesn't know'
- Analytics UI overhaul widely panned: too complicated, jargon-heavy, dozens of scattered reports
- No web analytics (bounce, time-on-page, scroll depth, clear channel breakdown); weak cross-channel attribution post-iOS
- Data sync delays (1-24h); cookie-consent loss drops tracking incl. completed checkouts; no real cohort/multi-variable/statistical depth without Plus or 3rd-party tools
- Lack of dashboard customization on lower plans

**Gaps:**
- No multi-channel / off-Shopify data (Amazon, retail POS, wholesale, marketplaces) — single-platform myopia
- No true cross-channel marketing attribution or unified ad-spend ROAS truth
- No identity resolution / customer journey reconstruction across sources
- No deterministic-first guarantee — AI hallucinates numbers and facts, undermining trust (the opposite of 'confidence before decisions')
- No real predictive/ML layer (forecasting, churn/LTV prediction, CAC reduction) — analytics is descriptive
- Web analytics, advanced cohort/statistical analysis only via Plus or third parties
- No data ownership / warehouse / replayable Bronze — merchant can't own or audit raw data

**Threat to Brain:** Massive distribution and price-to-zero gravity: it's free, pre-installed, and 'good enough' for the long tail, which sets merchant expectations and commoditizes basic dashboards and conversational analytics. Sidekick Pulse's proactive anomaly alerts move Shopify toward the insight->recommendation space Brain targets. For smaller/single-channel Shopify brands, 'why pay when Sidekick is free' is the default objection Brain must overcome. Shopify's reach means any feature it ships becomes table stakes overnight.
**Opportunity for Brain:** Win on trust, truth, and breadth — exactly where Shopify's AI is weakest. (1) Lead with Brain's 'no hallucinated numbers' guarantee: deterministic single-source metric registry with confidence + freshness, vs Sidekick's documented hallucination of specs, codes, and tax facts. (2) Be multi-channel/omnichannel + identity-graph + journey reconstruction where Shopify is Shopify-only and journey-blind. (3) Own the raw, replayable, auditable data (Bronze) and real attribution/revenue-truth Shopify can't provide. (4) Go beyond Pulse's alerting to closed-loop recommendation -> prediction -> action -> decision with measured outcomes. Position Brain as the trustworthy, cross-channel decision OS that sits ABOVE Shopify's free-but-unreliable layer — capturing brands the moment they outgrow single-platform, hallucination-prone defaults.

*Sources:* https://www.shopify.com/sidekick · https://help.shopify.com/en/manual/shopify-admin/productivity-tools/sidekick · https://www.adsx.com/blog/shopify-magic-sidekick-ai-features-2026 · https://pagefly.io/blogs/shopify/shopify-magic · https://pagefly.io/blogs/shopify/shopify-sidekick · https://community.shopify.com/t/warning-shopify-ai-sidekick-magic-hallucinates-technical-data-and-sabotages-strategic-seo/589483 · https://monkeyman.agency/insights/shopify-sidekick-magic-failures · https://plausible.io/blog/shopify-analytics · https://reportgenix.com/shopify-analytics-issues-2025/ · https://niblin.com/blog/shopify-plus-vs-advanced-analytics · https://www.letstalkshop.com/blog/shopify-sidekick-vs-shopify-magic

---

# Appendix C — Advisory Board (15 Personas, 6 Councils)

## Council: Analytics & Attribution

**Council's sharpest challenge:** Brain has built the most honest, penny-accurate revenue-truth foundation in the category — and is about to spend it on the one fight it cannot win. The plan points the flagship at multi-touch attribution against a 60k-brand incumbent (Triple Whale) and a causal-measurement specialist (Northbeam), yet what Brain actually has there is data-STARVED (gold_marketing_attribution ~0 rows, reconcileAttribution not auto-fired on finalization) and is allocation bookkeeping (4 deterministic heuristics + a stitch-quality confidence grade), NOT incrementality — the exact 'GA4-disagreeing black box' trap that scars both incumbents. Meanwhile Brain is sitting on two genuinely uncontested assets it is under-marketing: (1) RTO/COD profit protection (silver_shipment terminal_class, cod_rto_rate, gokwik.rto_predict, the rto_risk detector) that NO Western competitor has, and (2) CM2 profit-by-channel after COGS that Klaviyo/Triple Whale/Peel structurally cannot compute. The council's unanimous verdict: stop being a worse Triple Whale. Before scaling attribution, do three things in order — (a) auto-trigger reconcile + backfill so attribution is never an empty chart, honoring your own 'no empty charts' law; (b) close the recommend->approve->action loop at channel/campaign grain so truth becomes a 9am-Monday decision, not a spreadsheet; and (c) lead go-to-market from the RTO/COD + CM2-profit beachhead where you are the ONLY option and can price on demonstrable margin recovered. Truth is your moat, but truth that produces an empty chart and no action loses to a 'good-enough number that already paused the campaign' — and to a free Shopify Sidekick alert.

### Triple Whale VP Product
**Insights:**
- Your single hardest-won asset is the thing my company gets crucified for: deterministic, penny-reconciling revenue truth. We over-attribute by 15-25% vs Shopify and users call our attribution 'buggy.' You have an immutable Iceberg Bronze, a single-source METRIC_REGISTRY (21 IDs, toleranceMinor=0, exact-integer money), and a parity oracle. That is a wedge I literally cannot copy without rebuilding my foundation. Lead the whole product with 'reconciles to Shopify/Razorpay to the penny' — that one sentence sells against me.
- But here is the brutal truth from running this category: merchants do not buy 'truth.' They buy 'what do I do at 9am Monday.' I have 60k brands not because Moby is accurate but because it tells a media buyer to cut a campaign and lets them click yes. Your recommendation engine is 4 deterministic brand-level detectors (rto_risk, realization_gap, margin_erosion, scale_opportunity), recommend-only, nothing auto-executed. That is a dashboard with opinions, not an operator.
- Your attribution is structurally complete but DATA-STARVED — gold_marketing_attribution and gold_attribution_paths are ~0 rows, and reconcileAttribution is not auto-triggered on order finalization; it runs via Argo/BFF. So the headline 'multi-touch attribution' demo is empty on a fresh tenant. We learned the hard way: an empty attribution chart on day 1 churns the trial. Your own CLAUDE.md rule — 'no empty charts as a success state' — is being violated by your flagship surface.
- You have something I'd pay for: confidence as a first-class frozen grade (strong/partial/weak = A/C/D, 1.000/0.700/0.400) stamped on every credit row. We slap a number on a chart with no honesty. If you put 'Confidence: C (0.70) — 40% of touches are cookieless direct' next to every attributed-revenue figure, you make my dashboards look reckless.

**Challenge to Brain:** You are trying to out-truth me while I out-action you. Truth without action is a spreadsheet — and a free Shopify Sidekick Pulse alert is closing the 'what's wrong' gap for $0. If your reconcileAttribution doesn't auto-fire on finalization and your detectors don't execute (or at minimum draft) a budget/spend change a buyer can approve in one click, your penny-accurate revenue ledger will lose every deal to my 'good-enough number that already paused the campaign.' Which one will you actually ship in 90 days?

**Must build:**
- **Auto-trigger reconcileAttribution on order finalization + a backfill so a new tenant sees populated gold_marketing_attribution / gold_attribution_paths within the first session (close the data-starved gap on your 4 existing deterministic models).** — brand: On day 1 the brand sees real multi-touch channel/campaign credit (channel_path, first/last touch, position_based credit) reconciled to revenue — not an empty chart. | Brain: Activates the single most under-leveraged asset you already built; turns ~0-row marts into the demo that wins trials; satisfies your own 'no empty charts' invariant. | revenue logic: Attribution is the #1 reason DTC brands pay $129-379/mo for Triple Whale. A populated, reconciled attribution surface is the table-stakes entry ticket — without it there is no paid conversion.
- **A one-click 'approve action' loop on the existing recommendation detectors: turn scale_opportunity / margin_erosion / rto_risk recs into a drafted action (e.g. shift budget, pause SKU, flag COD orders) written to the recommendation_action ledger (0082) with a Copilot-style human approval — NOT autonomous yet.** — brand: The buyer gets 'here's the action, click yes' instead of 'here's a number, go figure it out' — the exact 9am-Monday job. | Brain: Moves you from descriptive (Peel/Daasity tier) into the action loop where stickiness and expansion live; your decision_log + recommendation_action ledger already exist to audit it. | revenue logic: Action drives daily active use and retention; recommend-only tools get cancelled in budget reviews. Approve-loops justify the expansion from 'reporting' price to 'operator' price.
- **Surface the frozen confidence grade (A/C/D + numeric) and data freshness on EVERY attributed-revenue and ROAS figure in the UI.** — brand: The brand knows when to trust a number and when not to — the opposite of my 'buggy attribution' reputation. | Brain: Productizes attribution_confidence/effective_confidence you already compute; a defensible, demo-able differentiator that money can't quickly buy. | revenue logic: Trust is the conversion lever in this category post-iOS14. 'We tell you the confidence; they don't' is a direct rip-and-replace pitch against incumbents whose numbers disagree with Shopify.

**Avoid:**
- Do NOT chase Moby-style multi-model autonomous agents now. You have zero trained models, no Python training service, and an online feature store nobody reads (.get() has no caller). An 'Autopilot' demo on a deterministic stack is a lie you'll get caught in.
- Do NOT build a 5th, 6th, 7th attribution model. Your 4 deterministic models + frozen confidence are honest and enough. Markov/Shapley with no causal validation is exactly the over-attribution rabbit hole that wrecked our credibility.
- Do NOT widen the metric registry to chase coverage vanity. Ship the action loop on the 21 you have.

### Northbeam Attribution Architect
**Insights:**
- I respect the engineering discipline — largest-remainder integer apportionment so Σcredit = realized revenue exactly, no float, clawbacks mirroring saved weights on reversal. That is more rigorous plumbing than most of the market. But let me be precise about what you have: deterministic credit ALLOCATION, not MEASUREMENT. first_touch/last_touch/linear/position_based are accounting rules for splitting a known number. They tell a brand where to ASSIGN credit; they do not tell them which channel actually CAUSED the sale.
- Your confidence grade is honest but it grades STITCH QUALITY (was the journey deterministically stitched, were touches cookieless), not CAUSAL confidence. A position_based model at grade A is still position_based — a heuristic. A brand could 10x spend on the 'first touch' channel your model credits and see zero incremental revenue. Without incrementality you cannot distinguish correlation from cause, and that is the exact trap that makes brands say our ML 'disagrees with GA4 and I don't trust it.'
- You have NO MMM and NO incrementality/holdout — I checked, there's no holdout file in the metric-engine and experimentation-holdouts is a reference skill you haven't bound. That's fine for a v1, but do not let sales call 4 allocation heuristics 'attribution intelligence.' Your real moat is the replayable Bronze: you can run a geo-holdout or a deterministic-assignment experiment on the SAME immutable event log that produces your ledger — measurement and truth from one substrate. Almost no one can do that cleanly.
- The brand-level recommendation grain worries me. rto_risk/margin_erosion at subject='brand' is too coarse to act on a media budget. Attribution lives at channel x campaign x creative. Your gold_marketing_attribution has channel and campaign_id columns — push the recommendation grain down to where the spend decision is actually made.

**Challenge to Brain:** You are marketing 'attribution' but you have built bookkeeping. The moment a sophisticated buyer asks 'is this incremental, or are you just crediting the channel that was always going to convert?' your deterministic models have no answer — and that buyer is exactly the >$250k/mo brand worth real ARR. Will you build ONE incrementality primitive (a deterministic-assignment holdout on your Bronze) before you scale the attribution story, or will you ship allocation heuristics dressed as measurement and inherit our 'GA4-disagreeing black box' problem?

**Must build:**
- **A deterministic-assignment holdout / incrementality primitive computed on the immutable Bronze event log: assign customers/geos to holdout vs exposed deterministically, measure realized-revenue lift vs counterfactual, write every experiment to the decision/audit log.** — brand: The brand learns which channels are actually INCREMENTAL — the difference between 'cut this and lose nothing' and 'cut this and bleed.' This is the answer Northbeam charges $1,500/mo+ for. | Brain: Converts your replayable Bronze from a compliance feature into a causal-measurement engine; lets you honestly say 'measurement, not just allocation' and move upmarket past Triple Whale's allocation-only ceiling. | revenue logic: Incrementality is the upmarket wedge: >$250k/mo-spend brands and agencies pay premium specifically for causal proof. It unlocks the price tier above the $129-379 DTC band.
- **Push the recommendation grain from subject='brand' down to channel x campaign (and eventually creative) using the channel/campaign_id columns already in gold_marketing_attribution + silver_marketing_spend.** — brand: Recommendations land where the buyer actually moves money — 'this Meta campaign is margin-negative on a CM2 basis,' not 'your margins are eroding.' | Brain: Makes recommendations actionable and credible to performance marketers; differentiates from brand-summary dashboards; sets up the action loop the VP Product wants. | revenue logic: Granular, spend-decision-level recs are what justify a tool sitting in the daily media-buying workflow — the seat that doesn't get cancelled.
- **Reconciliation honesty surface: show side-by-side what each of the 4 deterministic models would credit per channel (you already loop all 4 in reconcile), plus the attribution_reconciliation_rate (credited vs realized).** — brand: Brands see the model spread and stop treating any single number as gospel — the transparency Rockerbox claims but doesn't deliver. | Brain: Productizes the 4-model loop you already run; 'compare models, see where they disagree' is a defensible, honest position no allocation-only competitor matches. | revenue logic: Transparency is the trust purchase. Showing the model spread converts skeptical, GA4-burned buyers who churned from black-box tools.

**Avoid:**
- Do NOT build Markov or Shapley data-driven attribution to look sophisticated. With no incrementality to validate against, they over-credit and you inherit our worst reviews. Incrementality FIRST, fancier allocation never (or much later).
- Do NOT let attribution marts ship to a customer at ~0 rows behind a 'multi-touch' label. Data-starved measurement is worse than no measurement — it teaches the brand to distrust the surface permanently.
- Do NOT conflate stitch-quality confidence (A/C/D) with causal confidence in any UI copy. Naming a heuristic 'confidence' near a revenue number is the exact misrepresentation that erodes attribution trust.

### Performance Marketing Director
**Insights:**
- I run the budget. I don't care about your medallion architecture or that Bronze is immutable. I care about three numbers I can't get honestly anywhere: true blended ROAS, real CAC by channel, and contribution margin AFTER COGS/shipping/RTO. You actually have these — gold_cac (new_customers / acquisition_spend by month), blended_roas, and CM2 via contribution-margin reading cost_input config. Klaviyo can't subtract COGS, Triple Whale over-attributes, Peel just reports. If you show me CM2-positive vs CM2-negative spend by channel, I will pay for that today.
- But your RTO/COD capability is your secret weapon and you're burying it under 'attribution.' I'm an India-context buyer — COD is 60%+ of my orders and RTO eats my margin alive. You have silver_shipment with terminal_class (rto/delivered), cod_rto_rate, cod_mix, a gokwik.rto_predict risk signal, AND an rto_risk recommendation detector. NO Western competitor (Triple Whale, Northbeam, Peel, Klaviyo) touches this. This isn't a feature, it's a beachhead. Lead with RTO/COD profit protection, not generic attribution where you're the 50th entrant.
- Your CAC mart is month-grain and your recommendations are brand-grain — I can't act on either. I need CAC by channel by week and a rec that says 'pause this' at the campaign level. The data is in silver_marketing_spend (platform, campaign_id, spend by stat_date); the grain just isn't surfaced to where I spend.
- Honesty check that earns my trust: your docs admit only ~23/94 dev touches carry brain_anon_id, NULL-anon touches are dropped. That means journey/attribution coverage is partial. If you show me 'attribution covers 41% of your revenue, the rest is unmatched' I trust you MORE than a tool claiming 100%. Use your own honesty as the sales weapon.

**Challenge to Brain:** You're about to position as 'AI Growth OS' and compete head-on with Triple Whale on attribution — a knife fight against a 60k-brand incumbent — while you're sitting on RTO/COD profit-truth that NONE of them have and that every Indian/COD-heavy brand is desperate for. Why are you fighting where you're the 50th-best instead of where you're the only one? Pick the beachhead you can win, or you'll burn runway being a worse Triple Whale.

**Must build:**
- **An RTO/COD profit-protection surface as a headline product: cod_rto_rate + cod_mix + silver_shipment terminal_class + gokwik.rto_predict risk, feeding the rto_risk detector into a pre-ship action (flag/hold/verify high-RTO-risk COD orders) written to the action ledger.** — brand: Directly recovers margin lost to RTO — the single biggest profit leak for COD-heavy brands. Quantifiable rupees saved per flagged order. | Brain: A category NO Western competitor has; an uncontested beachhead with built-in proof-of-value (margin saved) and zero attribution-credibility baggage. | revenue logic: RTO can be 20-40% of COD orders; even a small reduction is huge margin. Brain can price on a share of demonstrable margin recovered — value-based pricing competitors can't match because they can't even measure it.
- **CM2-by-channel (and CM2-by-campaign) profit view: combine contribution-margin/CM2 (cost_input + realized revenue + spend) with channel/campaign attribution to show profit, not just ROAS, per spend unit.** — brand: I stop optimizing to vanity ROAS and start cutting CM2-negative campaigns — the decision that actually grows profit. | Brain: Profit-truth-by-channel is the gap Klaviyo (no COGS), Triple Whale (gross), and Peel (descriptive) all share; it's your 'revenue truth over platform truth' principle made operational. | revenue logic: Reallocating spend from CM2-negative to CM2-positive channels is direct profit lift the brand can attribute to Brain — the cleanest ROI story for renewal/expansion.
- **Drop CAC and recommendation grain to channel x week: re-grain gold_cac off silver_marketing_spend's campaign/stat_date and make the scale_opportunity/margin_erosion recs fire at channel/campaign level.** — brand: Recommendations land at the lever I actually pull (a campaign budget), at the cadence I actually decide (weekly), not a monthly brand-level summary. | Brain: Turns existing marts into a daily-driver tool for the budget owner — the seat that renews. | revenue logic: Workflow-embedded, decision-grain tooling is what survives budget cuts; brand-grain monthly summaries are the first thing cancelled.

**Avoid:**
- Do NOT lead go-to-market with generic multi-touch attribution against Triple Whale/Northbeam. You're under-armed there and over-armed in RTO/COD/profit. Lead where you're unique.
- Do NOT show me ROAS without margin. Gross ROAS optimization is how brands grow themselves broke; if your headline metric is ROAS not CM2 you look like everyone else.
- Do NOT hide your coverage gaps (the ~23/94 anon-id, ~0-row attribution marts). The instant I catch a 100%-confident number that's actually 41%-covered, I never trust the tool again — make honesty the pitch.

## Council: Retention & Lifecycle — a skeptical advisory council inhabiting three retention-native operators (Lifetimely Retention Lead, Klaviyo Customer Architect, Retention Specialist). They were asked NOT to assume Brain's current direction is correct. Verified against Brain's real code: gold_cohorts (acquisition-cohort AGGREGATES only — size/lifetime-orders/lifetime-value, NOT a period-over-period retention curve), gold_customer_scores (deterministic RFM + churn BAND, rule-based, explicitly not ML), feature_customer_daily (lifetime_orders, days_since_last_order, customer_age_days — but NO second-order/inter-purchase/next-order-date feature), computeCohortRetention (returns avg lifetime orders per cohort, NOT N0/N1/N2 repurchase rates — code comment admits 'per-month activity deferred to a richer cohort mart'), ltv = realized ÷ customers (cohort-naive, no forecast), CAPI passback orchestrator EXISTS (conversion-feedback to ad platforms), but NO subscription analytics, NO outbound audience activation into Klaviyo/email/SMS, NO inter-purchase-timing. The personas disagree sharply: Lifetimely Lead says ship predictive LTV now; Klaviyo Architect says don't — be the truth layer ABOVE Klaviyo and activate, don't predict-for-its-own-sake; Retention Specialist says both are wrong until the retention CURVE itself is fixed.

**Council's sharpest challenge:** Brain has labeled an acquisition-cohort value rollup as 'retention' and historical ARPU as 'LTV' — so the entire Retention & Lifecycle pillar is currently a naming exercise over data that cannot answer the two questions the pillar exists for: 'do customers come back, and when?' and 'what will a customer be worth?' Before arguing predictive LTV (Lifetimely's wedge) or margin-true activation (Klaviyo's wedge), Brain must (1) build a real period-over-period retention curve and an inter-purchase-interval feature from order timestamps it already lands, and (2) stop presenting cohort-naive realized-revenue-per-customer as 'LTV.' The single most dangerous outcome is a head-to-head demo where Brain's honest-but-mislabeled $42 'LTV' and avg-orders 'retention' lose to a competitor's forecasted numbers — turning Brain's greatest asset (truth) into the reason it looks broken. Truth without the right metric and the right label is not trust; it is self-sabotage.

### Lifetimely Retention Lead
**Insights:**
- Brain's headline 'LTV' is realized-revenue ÷ customers (cohort-naive, per computeExecutiveMetrics). That is not LTV — it is historical ARPU. Lifetimely's entire 4.9/5 / 3-5yr-retention moat is *predictive* 30/60/90-day and 12-month LTV per segment. Brain currently ships a number a merchant cannot make an acquisition decision on, because it answers 'what did this cohort spend' not 'what will this customer be worth.'
- The real LTV unlock is not a fancy model — it is the LTV DRIVERS report: which first-product, first-channel, first-promo correlates with high-LTV customers. Brain already has silver_order_line (first product), silver_touchpoint (first channel), and gold_cohorts (cohort value). The join exists in pieces; nobody has assembled the 'what acquisition path produces my best customers' view, which is the single most-acted-on report in retention tooling.
- Brain's biggest structural advantage over Lifetimely is hiding in plain sight: Lifetimely IMPORTS CAC and is hours-stale; Brain has gold_cac + a real Bronze->serving streaming path. A live 'LTV:CAC by acquisition cohort' tile — payback period included — is something Lifetimely literally cannot build because it has no journey/CAC truth, only imported spend.
- feature_customer_daily is a genuine point-in-time SCD substrate — the one thing most Shopify retention apps fake. This is the correct foundation for predictive LTV and it is already append-per-day and idempotent. Brain under-sells that it has the training substrate that Lifetimely's 'billions of customers' black box won't expose.

**Challenge to Brain:** You are about to lose the LTV battle by being honest in the wrong place. 'Cohort-naive realized-revenue-per-customer' labeled 'LTV' in the executive tile is worse than no LTV — it looks like the competitor's number, is lower (no forecast tail), and a merchant comparing Brain's $42 'LTV' to Lifetimely's $115 predicted LTV will conclude Brain is broken, not honest. Either rename it 'ARPU/realized value-per-customer' loudly, or ship a forecast — but do not let a deterministic-purity decision hand the comparison to your highest-overlap competitor.

**Must build:**
- **Predictive 90-day & 12-month LTV per acquisition cohort and segment — a real forecast (BG/NBD + Gamma-Gamma or equivalent) trained on feature_customer_daily, registered in ml.model_registry, served via the existing serve path, with confidence band and 'forecast vs realized' overlay.** — brand: A brand can decide TODAY how much to pay to acquire a customer from a given channel/first-product, instead of waiting 12 months to learn the cohort was unprofitable. This is the single decision retention tooling exists to inform. | Brain: Closes the only feature where Lifetimely beats Brain head-to-head; gives ml.model_registry/prediction_log their first non-deterministic resident so the ML platform stops being a labeled skeleton; the forecast-vs-realized overlay is a unique trust artifact (deterministic-truth-anchored prediction) no competitor ships. | revenue logic: Predictive LTV is the gateway feature merchants pay $79-$299/mo for at Lifetimely. It justifies a retention tier and, because it drives ad-budget decisions, it makes Brain sticky to the CFO not just the marketer — expansion via 'now bid to predicted-LTV.'
- **LTV Drivers report: a Gold mart joining first-product (silver_order_line), first-channel (silver_touchpoint), first-discount, and acquisition month (gold_cohorts) to realized + predicted cohort LTV, ranked by lift.** — brand: Tells the brand 'acquire customers via paid-Google whose first product is X — they are worth 2.3x'; directly reallocates acquisition spend toward high-LTV paths. | Brain: Uses three marts Brain already has but has never joined; differentiates from Lifetimely's single-platform driver report by including the REAL multi-touch first-channel (Lifetimely only has imported CAC, not journeys). | revenue logic: This is the report that converts a free/trial user to paid in retention tools — it produces an immediate, defensible 'we moved $X spend and LTV rose' outcome that anchors renewal.

**Avoid:**
- Do NOT keep shipping 'LTV' as the cohort-naive realized ratio under the LTV label — rename it or forecast it, but stop presenting ARPU as LTV.
- Do NOT try to out-data Lifetimely's cross-merchant benchmark on day one — you cannot match 'billions of customers' as a cold-start moat; win on per-brand truth + live CAC, not benchmark bragging.
- Do NOT build a generic churn model before LTV — for an acquisition-led DTC brand, predicted LTV drives more money than churn-risk does, and your gold_customer_scores RFM band already covers basic churn triage.

### Klaviyo Customer Architect
**Insights:**
- Klaviyo's documented fatal flaw is that it reports GROSS, self-attributed, send-credited revenue with no COGS/refunds/RTO. Brain has gold_revenue_ledger (realized, signed, with clawbacks) + silver_shipment (RTO/delivered terminal class) + cost_input/CM2. Brain can compute true *net-margin* contribution per lifecycle flow that Klaviyo structurally cannot. That, not predictions, is the wedge: be the scorecard Klaviyo grades its homework against.
- Brain has a CAPI passback orchestrator already (conversion-feedback to ad platforms) — but it has NO outbound activation into the messaging plane (no Klaviyo/SMS audience sink). That is the missing half of the loop. A retention insight that cannot be ACTIVATED in the tool the merchant already runs is just a prettier dashboard. The decision layer dies at the dashboard edge today.
- Klaviyo's predicted CLV/churn are good-enough and free-with-the-plan. Brain should NOT try to beat Klaviyo at predicting churn for a brand that already pays Klaviyo. Brain should COMPUTE margin-aware, RTO-aware, identity-resolved segments (which Klaviyo cannot, being single-channel and gross-revenue) and PUSH them into Klaviyo as the audience. Brain is the brain; Klaviyo is the mouth.
- Brain's identity graph (PG, deterministic, real) means a segment built in Brain is de-duplicated across the true customer, not per-email like Klaviyo profiles. 'Suppress high-RTO-risk COD customers from the win-back flow' is a margin-saving segment Klaviyo cannot express and Brain can — and it is a one-row decision_log + a CAPI/audience push away.

**Challenge to Brain:** Your roadmap is drifting toward becoming a worse Klaviyo (predict churn, score customers) instead of the thing Klaviyo can never be (the neutral, net-margin, cross-channel truth + audience source above it). Every hour spent making gold_customer_scores look like Klaviyo's predictive panel is an hour not spent on the outbound audience-activation sink that would make Brain indispensable to a brand that ALREADY pays Klaviyo $575/mo. If a Brain insight can't become a Klaviyo/SMS audience by Friday, you have built decision theater.

**Must build:**
- **Outbound audience-activation sink: a reverse-ETL/connector path that publishes a Brain-computed segment (e.g. 'predicted-high-LTV + low-RTO-risk + lapsing') into Klaviyo lists / Meta Custom Audiences, written through the existing decision_log + recommendation_action ledger so every push is auditable.** — brand: The brand acts on Brain's superior segment inside the tool it already operates — no rip-and-replace, immediate win-back/retention campaigns on margin-true, RTO-aware audiences. | Brain: Closes the insight->action loop that every competitor (Peel, Daasity, even Triple Whale partially) leaves open; turns Brain from a measurement layer into a decision layer; makes Brain a system-of-record the merchant configures their CRM FROM. | revenue logic: Activation is what converts 'nice dashboard' into a renewed contract — outcome-attributable retention campaigns let Brain claim revenue lift, justifying both base subscription and a per-activation/seat expansion vector. It also raises switching cost: rip out Brain and your audiences go dark.
- **Net-margin lifecycle scorecard: per-segment (new/repeat/lapsed/winback) realized net contribution after refunds, RTO clawbacks, discounts, and COGS — reconciling, to the penny, against Klaviyo's claimed attributed revenue and showing the gross-vs-net delta.** — brand: Exposes which 'winning' Klaviyo flows are actually margin-negative (high COD/RTO, deep-discount cohorts) — stops the brand from scaling a flow that loses money on net. | Brain: Directly weaponizes Klaviyo's #1 documented weakness (gross, inflated, self-attributed revenue) using marts Brain already has (revenue_ledger + shipment + CM2); a screenshot-ready 'Klaviyo says $80k, real net = $31k' is the sales wedge. | revenue logic: Net-truth-vs-platform-truth is a CFO-grade artifact — it moves Brain's buyer from the marketing manager (who loves Klaviyo) to finance (who distrusts it), unlocking a higher-authority budget and a defensible 'we found $X of fake revenue' ROI story.

**Avoid:**
- Do NOT compete with Klaviyo on predicted churn/CLV for brands that already pay Klaviyo — it is free there and good-enough; you will lose a feature race you don't need to enter.
- Do NOT build your own email/SMS sending — outbound delivery (the WhatsApp 24h window, deliverability, suppression) is a swamp; be the audience SOURCE, not the channel.
- Do NOT let the CAPI passback be the only outbound integration and call the loop 'closed' — ad-platform passback is signal enrichment, not lifecycle activation; the messaging-plane sink is the missing piece.

### Retention Specialist
**Insights:**
- Brain does not actually have retention measurement. gold_cohorts is acquisition-cohort AGGREGATES (cohort_size, cohort_orders, cohort_value) and computeCohortRetention returns AVG LIFETIME ORDERS per cohort. That is not a retention curve. A retention curve is N0/N1/N2... = % of cohort that made a 2nd/3rd order in month 1/2/3. The code comment literally admits 'per-month activity deferred to a richer cohort mart.' Brain is one mart away from having retention, and currently has none — every persona arguing about LTV/churn is building on sand.
- The most decision-grade retention metric for DTC is the second-order rate and TIME-TO-SECOND-ORDER (inter-purchase interval). feature_customer_daily has lifetime_orders and days_since_last_order but NO order-timestamp sequence, so Brain cannot compute 'median days between order 1 and 2' — the metric that sets win-back flow timing. This is the highest-leverage missing feature and it is buildable from silver_order_state event timestamps Brain already lands.
- days_since_last_order ÷ a static churn band is a crude churn proxy because 'lapsed' is brand-specific: a 90-day replenishment brand and a 18-month furniture brand cannot share a fixed band. Real retention needs churn defined relative to each brand's own inter-purchase distribution. Brain's deterministic-first ethos is perfect for this — a per-brand empirical 'expected next order by' is more trustworthy AND more correct than a generic model.
- Brain's honest 'no empty charts / confidence before decisions' principle is the perfect frame for retention specifically, because retention curves are the chart most often shown with too-thin cohorts. A retention surface that GREYS OUT cohorts below N customers and shows the confidence/maturity of each cohort month is a trust differentiator Peel/Lifetimely don't bother with.

**Challenge to Brain:** Both other personas are arguing about the second floor of a building with no first floor. You cannot ship predictive LTV (Lifetimely's pitch) or margin-true lifecycle segments (Klaviyo's pitch) without a real per-period retention/repurchase curve and an inter-purchase-interval feature — and you have NEITHER. You have an acquisition-cohort value rollup mislabeled as retention. Fix the retention curve and the inter-purchase clock FIRST, or every downstream LTV forecast and lifecycle segment is computed on a foundation that can't answer 'do customers come back, and when.'

**Must build:**
- **True period-over-period retention curve mart: gold_retention_curve at grain (brand_id, cohort_month, period_index) = customers from the cohort who placed an order in period N ÷ cohort_size, built from silver_order_state order timestamps; surfaced as the canonical N0/N1/N2 triangle with per-cell cohort-size confidence/greying.** — brand: Answers the foundational retention question — 'what % of my Jan customers came back in Feb, Mar, Apr' — that drives every replenishment, win-back, and budget decision; today the brand literally cannot get this from Brain. | Brain: Converts the mislabeled cohort aggregate into genuine retention measurement; registry-backs cohort_retention as a real curve (not avg-orders); the confidence-greyed triangle operationalizes 'no empty charts' as a visible differentiator. | revenue logic: The retention triangle is the single most-screenshotted artifact in retention sales demos — it is what makes a merchant say 'I didn't know that.' It anchors the retention product's existence and is the prerequisite that makes LTV and lifecycle tiers sellable.
- **Inter-purchase-interval feature + per-brand empirical churn definition: extend feature_customer_daily (or a sibling) with order-sequence timestamps to compute median/p75 days-to-next-order per brand, and define 'lapsing/churned' relative to each brand's own distribution rather than a global band.** — brand: Tells the brand exactly WHEN to trigger a win-back (e.g. 'your median reorder is 47 days; a customer at day 70 is lapsing') instead of a generic 90-day rule that mis-times every flow. | Brain: Replaces gold_customer_scores' static churn band with a per-brand-correct, deterministic, explainable definition — more defensible than a black-box churn model AND the timing input the activation sink needs; pure deterministic-before-ML credibility. | revenue logic: Reorder timing is the lever that moves repeat-rate, the metric retention buyers are graded on; a brand that lifts repeat-rate via correctly-timed flows attributes it to Brain, driving renewal and the 'measured outcome -> expansion' loop.

**Avoid:**
- Do NOT keep exposing the acquisition-cohort aggregate under a 'retention' or 'cohort_retention' label — it is not retention, and shipping it as such poisons trust on the exact surface where trust is the product.
- Do NOT adopt a fixed global churn window (30/60/90) — it is wrong for every brand whose replenishment cadence differs; let each brand's own inter-purchase data define lapse.
- Do NOT layer ML churn/LTV on top of feature_customer_daily until it carries order-sequence timing — a model trained on lifetime_orders + days_since_last alone cannot learn repurchase dynamics and will just memorize recency.

## Council: Data & AI Platform

**Council's sharpest challenge:** Brain has earned a CDP-and-data-foundation credibility that NONE of these competitors can match — immutable Iceberg Bronze, deterministic auditable identity, a 24-ID metric registry as sole Gold reader, toleranceMinor=0 money, and %-of-GMV billing aligned to the customer's truth. But it is marketing itself one full tier ahead of what it has shipped: there are no trained models, the online feature store has no production reader, attribution marts sit at ~0 rows because reconcile never auto-fires, and serveCustomerScore is a Gold read cosplaying as inference. The council's unified verdict: STOP selling the AI tier and START activating the trust tier. The single sharpest challenge — do these THREE things before writing one line of ML training code, because each lights up assets already built and each directly weaponizes a documented competitor weakness: (1) auto-trigger attribution reconcile so the already-built attribution metrics and channel/campaign ROAS actually populate; (2) productize confidence + freshness as a first-class trust UI across every tile (the white-space no rival occupies); (3) close the deterministic recommendation -> action -> measured-outcome -> learning loop to generate the outcome-labeled dataset that is the ONLY honest license to train a model later. Deterministic-first is not a limitation to apologize for — it is the exact antidote to the inflated-attribution, hallucinated-number, black-box pain that every competitor is hated for. Win on truth you can prove before predictions you can't yet stand behind.

### Segment CDP Architect
**Insights:**
- Brain's actual moat is not 'AI' — it is the deterministic, replayable, brand-isolated data foundation that every competitor I just read (Triple Whale, Klaviyo, Segment, Rudder) structurally lacks: an immutable Iceberg Bronze (PG bronze_events DROPPED via 0070/0085), a single Kafka lane fanned to many idempotent consumer groups, integer-minor-units money with toleranceMinor=0, and a 24-IDs-strong metric registry as the sole Gold reader (withSilverBrand, BRAND_PREDICATE injected). That is a CDP-grade ingestion+identity+governance stack that took Segment a decade. Brain should sell THIS first.
- The identity story is honest and that honesty IS the asset: PostgreSQL union-find (migration 0017) is the authoritative resolver, Neo4j is a default-OFF, never-read projection (ADR-0003). Deterministic-only stitching (strong ids merge; device/anon resolve-only; phone-guard) is exactly what an enterprise data buyer wants because it is auditable and reversible (brain_id_alias, deterministic merge_id). Segment's Unify and Rudder's Profiles can't show you WHY two profiles merged; Brain can.
- The pricing wedge is real and grounded: every CDP competitor is hated for the same thing — MTU billing (Segment counts anonymous visitors), active-profile billing (Klaviyo's 2025 surprise), volume-banded identical-feature tiers (Peel). Brain bills %-of-REALIZED-GMV off an immutable sealed ledger with GST invoicing and credit notes. That aligns Brain's revenue to the customer's revenue truth — a structural trust advantage no event-volume CDP can copy.
- But the data foundation has a quiet integrity gap the marketing won't admit: order-state, customers, and marketing-spend Silver still read DERIVED Postgres ledgers (billing.realized_revenue_ledger, ad_spend_ledger, identity.customer) via JDBC read-shims — NOT raw Iceberg Bronze. So 'lakehouse-sourced revenue truth' is true for journey/order-line/shipment, but the money spine is still PG-derived. That seam is where 'reconcile to Shopify to the penny' claims can break.

**Challenge to Brain:** You are positioning as 'The AI Growth Operating System' but you have ZERO trained models, an online feature store that NOTHING reads in production (only test callers hit RedisOnlineStore.get()), attribution marts with ~0 rows because reconcileAttribution is never auto-triggered by finalization, and two unconnected feature definitions (dbt feature_customer_daily vs TS CUSTOMER_FEATURES). You are a best-in-class CDP wearing an AI costume. Stop selling the costume. If a Segment-shaped buyer pulls back the curtain in a POC and finds the 'AI' is a deterministic RFM CASE statement, you lose the deal AND the data-foundation credibility you actually earned.

**Must build:**
- **Close the attribution loop: auto-trigger reconcileAttribution on every realized_revenue_ledger finalization/reversal so gold_marketing_attribution and gold_attribution_paths actually populate (they're structurally complete, code-tested, but data-starved at ~0 rows today).** — brand: Brands finally see real multi-touch credit and ROAS by channel/campaign reconciled to verified revenue — the exact thing Triple Whale (15-25% Shopify discrepancy) and Klaviyo (inflated last-touch) get wrong. | Brain: Activates 3 already-built registry metrics (attribution_credit, attribution_reconciliation_rate, attribution_confidence) + computeChannelRoas/computeCampaignRoas — turns dormant code into demoable product with no new modeling. | revenue logic: Attribution is the headline reason brands buy Triple Whale/Northbeam ($129-$1,500+/mo). Lighting up populated, reconciled attribution is the single highest-leverage activation of existing assets and directly justifies a paid tier.
- **Unify the two feature definitions and close the online read loop: collapse feature_customer_daily/gold_customer_scores and the TS CUSTOMER_FEATURES into ONE definition, and make at least one production consumer (recommendation detector or serving route) actually call RedisOnlineStore.get() with the freshness sentinel.** — brand: Sub-second, fresh customer features power live decisions (segment targeting, churn flags) instead of stale dashboard reads. | Brain: Closes the offline/online parity loop the audit aimed for; eliminates the embarrassing 'write-only feature store' gap; one definition kills training/serving skew before any real model lands. | revenue logic: An online serving loop is the prerequisite for ANY paid predictive feature; without a reader, the entire feature-store investment is sunk cost producing zero revenue.
- **Penny-reconcile the money spine to source: build an explicit reconciliation oracle that proves billing.realized_revenue_ledger (and its Iceberg copy) matches Shopify/Razorpay payouts, and surface a per-brand reconciliation_rate + drift in the UI.** — brand: 'Reconciles to Shopify to the penny' becomes a provable claim, directly attacking the #1 trust complaint across Triple Whale/Klaviyo/Shopify-Magic (hallucinated/discrepant numbers). | Brain: Converts Brain's deterministic-truth thesis from a slogan into an auditable artifact; makes the PG-derived-Silver seam a feature (reconciled) instead of a hidden risk. | revenue logic: Revenue truth IS the billing basis — a reconciliation gap is literally a billing-integrity and churn risk; proving it protects the %-of-GMV model and underwrites every downstream insight.

**Avoid:**
- Do NOT turn on Neo4j dual-write or build probabilistic/ML identity stitching to 'match Segment Unify' — the deterministic PG graph is the differentiator; probabilistic merge destroys auditability and reversibility for marginal recall.
- Do NOT build a generic usage-metering pipeline or seat/tier SaaS billing to look like Klaviyo/Segment — the %-of-realized-GMV model is your trust wedge against their hated billing; don't dilute it.
- Do NOT claim 'lakehouse-sourced revenue truth' in sales until the money-spine Silver (order-state/customers/spend) is reconciled or flipped off the PG read-shims; that overclaim is exactly what burns a technical buyer in a POC.

### AI Product Leader
**Insights:**
- The recommendation engine is genuinely the most mature AI-adjacent surface and is underrated: 4 deterministic detectors (rto_risk, realization_gap, margin_erosion, scale_opportunity) backed by SQL signal functions, with dedup+expire, a confidence gate (Trusted/Estimated/Insufficient), an append-only decision_log + recommendation_action ledger (0082), and outcome measurement. That is a real, auditable insight->recommendation spine — which is MORE than Peel, Lifetimely, or Shopify Sidekick ship (they stop at the chart or hallucinate).
- The market has bifurcated and Brain's honest 'deterministic-first' label is a competitive weapon, not an apology. Shopify Sidekick is being publicly torched for hallucinating product specs/codes/tax facts (~95% hallucination in audits). Triple Whale/Klaviyo are accused of inflating their own attributed revenue. Brain's toleranceMinor=0, registry-as-SoR, 'numbers never from a model' rule is the exact antidote — explainability is the product, and the cost-routing discipline (deterministic >> ML) means you only pay for a model when it beats deterministic.
- Confidence + freshness as first-class UI is Brain's clearest white-space. EVERY competitor presents numbers without surfaced confidence or data-quality state. Brain already has the substrate (attribution_confidence A/C/D grades, FeatureStaleError SLO, data-foundation-health, entitlements gated on readiness). Productizing 'confidence before decisions' as a visible, consistent UX is a defensible wedge against the whole field.
- The agentic narrative (Triple Whale Moby 2 Autopilot, Klaviyo Composer, Rudder RudderAI) is coming whether Brain likes it or not — but Brain's advantage is that an ACTION on top of an immutable decision_log + reversible ledger can be auditable in a way Moby's black-box autopilot cannot. The decision layer is currently just an audit table, not a bounded context — that's the gap to close, carefully.

**Challenge to Brain:** Your roadmap implies 'PREDICTIONS' and 'trained models,' but there is no Python training service, no MLflow/BentoML, no embeddings, no drift monitoring — the ONLY registered model is a deterministic RFM scorer that serveCustomerScore reads from Gold and logs as a 'prediction.' That's not inference; it's a precomputed read with a logging side-effect. My pointed challenge: DO NOT rush to train an ML model to fill this gap. The deterministic detectors + confidence gating already out-trust the entire competitor set. If you ship a churn model now, you inherit every black-box-attribution complaint you're winning against — and you have no eval harness producing learned metrics (the eval gate is exempt for deterministic models, so nothing is actually gated). Earn the right to ML by first making the deterministic loop CLOSE (recommendation -> action -> measured outcome -> learning), then let measured outcome data justify the first model.

**Must build:**
- **Productize confidence + freshness as a first-class, consistent UI primitive across EVERY metric tile and recommendation — wire attribution_confidence grades, effective_confidence, FeatureStaleError, and data-foundation-health into a single visible 'trust badge' with drill-to-source.** — brand: Brands never act on a stale or low-confidence number unknowingly; 'no empty charts, no overconfident charts' becomes the felt experience vs Sidekick's hallucinations and Triple Whale's silent discrepancies. | Brain: Turns Brain's deterministic substrate into a visible, ownable category ('confidence before decisions') that no competitor surfaces; cheap to build (substrate exists), high differentiation. | revenue logic: Trust is the conversion lever in every competitor's hated column (attribution disputes, inflated revenue). A visible confidence layer is what converts a skeptical Triple-Whale-burned buyer and reduces churn.
- **Close the deterministic decision loop end-to-end: auto-run recommendation detectors on a schedule, let a brand approve a recommendation, write the action to recommendation_action (0082), and FEED measured outcomes back as labels into feature_customer_daily — a learning loop, still deterministic, no ML yet.** — brand: Recommendations become acted-upon decisions with measured lift, not advisory cards — the 'so what / now what' that Peel, Daasity, and Northbeam never deliver. | Brain: Generates the proprietary outcome-labeled dataset that is the ONLY honest justification for a future trained model; closes insight->action->outcome->learning with full audit (decision_log). | revenue logic: Outcome measurement lets Brain price on demonstrated lift, not promised dashboards — a structurally stronger upsell than seat/volume pricing and a defensible expansion path.
- **Build an explainable NL query copilot grounded STRICTLY in the metric registry (registry IDs -> computed values, never model-generated numbers), with citations to source marts and confidence — an 'Ask Brain' that cannot hallucinate a figure.** — brand: Natural-language answers (the table-stakes Moby/Sidekick set) WITHOUT the hallucinated specs/codes/tax-facts that Sidekick is being publicly torched for. | Brain: Matches the agentic-AI narrative on Brain's terms — the model orchestrates registry calls and narrates, it never invents the number; deterministic-before-ML routing keeps cost ~1:100 vs frontier-on-everything. | revenue logic: NL querying is now an expectation (Triple Whale, Klaviyo, Daasity all ship it); a non-hallucinating version is the only way to win the 'why not just use free Sidekick' objection and protect ARR against price-to-zero incumbents.

**Avoid:**
- Do NOT train and ship a churn/LTV/propensity ML model before the deterministic action->outcome loop produces labeled outcome data and before the eval harness actually gates a learned metric — a black-box model now forfeits your trust differentiator and has nothing to beat baseline against.
- Do NOT build agentic AUTOPILOT (autonomous spend/creative/email execution like Moby 2) — Brain's edge is auditable, reversible, human-approved decisions; autonomous write-back to ad platforms inherits Triple Whale's 'buggy/over-attributing' liability with worse blast radius.
- Do NOT let serveCustomerScore keep masquerading as 'inference' in any external claim — it reads a deterministic Gold row; calling it a prediction in marketing is the same self-grading-homework sin Brain rightly attacks Klaviyo for.

## Council: Growth & Conversion

**Council's sharpest challenge:** Brain's two most monetizable Growth & Conversion surfaces are both built and both inert: the attribution credit ledger is structurally complete but ~0 rows (reconcile is manual, not auto-triggered on finalization), and the CAPI passback + abandoned-cart 'recoverable GMV at risk' both stop at measurement with no live send and no recovery action. Brain has engineered the honest pipes for growth and conversion but has not turned a single one into a revenue-causal ACTION — so today it is a more-trustworthy Peel/Lifetimely (descriptive, better lineage), not the decision OS it claims. The make-or-break move is not more marts or ML; it is closing ONE loop end-to-end on data that already exists — pick abandoned-cart recovery (the recoverable GMV is already quantified, it flows through the very ledger Brain bills on, and lift is measurable against that ledger) — and prove 'action + measured lift,' before the attribution dashboard ships positional-model numbers that won't reconcile with Meta and reproduce the exact incumbent trust collapse Brain claims to fix.

### Ex-Meta Growth Scientist
**Insights:**
- The entire competitive set (Triple Whale, Northbeam, Klaviyo, Rockerbox) lives or dies on ONE question: 'where do I spend my next ad dollar?' Brain has the deterministic substrate to answer it honestly (gold_cac per acquisition_month, blended_roas via gold_revenue_ledger, gold_marketing_attribution), but the attribution credit marts are documented as ~0 rows — meaning the single most monetizable surface in growth tooling is structurally complete and empirically empty. A growth scientist does not buy a ROAS dashboard that says 'no_data' on the channel breakdown.
- Brain's confidence/freshness-first posture is a genuine wedge against Triple Whale's '15-25% discrepancy vs Shopify' and Klaviyo's inflated self-attribution. The strongest growth-science framing is not 'we have better attribution math' (you only have 4 deterministic positional models — first/last/linear/position, no Markov/Shapley/incrementality) but 'every number drills to a replayable Bronze event with a confidence grade.' That is defensible; 'better MTA' is not — Northbeam and Rockerbox will out-rigor you on causal measurement.
- The CAPI conversion-feedback loop (get-capi-feedback.ts) is the most undervalued asset in the codebase from a Meta-growth lens. Sonar (Triple Whale) and Elevar's whole business is signal enrichment back to Meta. Brain already has the passback log, consent-gated send boundary, match_key_count (em/ph/fbc/fbp), and retroactive deletion — but it is dev-boundaried ('would_send_dev', no live sends). A higher Meta Event Match Quality directly lowers CPA; this is a revenue-causal lever Brain treats as a compliance artifact rather than a growth product.
- The deterministic-before-ML doctrine is correct for revenue truth but is a liability for growth optimization. Meta's algorithm wins on probabilistic incrementality, not deterministic last-touch. Brain has NO incrementality testing, NO geo-holdout, NO MMM — the experimentation-holdouts skill exists in the OS but nothing is wired. Without a counterfactual, every 'this channel drove X' claim Brain makes is the same correlational sin it accuses Triple Whale of.

**Challenge to Brain:** You are positioning revenue-truth as the wedge, but a growth team's budget decision needs CAUSAL contribution, not just reconciled revenue. Your attribution is 4 deterministic positional models over a credit ledger that currently has zero rows, and you have no incrementality/holdout/MMM despite the skill existing. What, concretely, makes a $2M/mo-spend brand choose Brain's 'confident but correlational' attribution over Northbeam's weekly-retrained MMM+ — and how do you avoid being the very black-box-disagreeing-with-reality tool you mock, once your credit ledger fills with positional-model numbers that won't match Meta?

**Must build:**
- **Live Meta CAPI passback with Event Match Quality optimization — flip the existing capi_passback_log from 'would_send_dev' to live sends, surface EMQ trend, and actively enrich match keys (server-side fbc/fbp capture via the universal pixel) to raise match rate.** — brand: Directly lowers CPA/CAC by feeding Meta higher-match-quality conversions post-iOS14.5 — the exact 10-20% attributed-conversion lift Elevar and Sonar sell, but consent-gated and auditable. | Brain: Converts a compliance artifact into a causal revenue lever with a measurable outcome (EMQ %, CPA delta), and creates a defensible 'we improve your ad performance, not just report it' claim against pure-analytics incumbents. | revenue logic: Performance-causal features command performance pricing. A measurable CPA reduction justifies a % uplift on the existing %-of-GMV model or a per-conversion enrichment fee, and lowers churn because turning it off raises the brand's CAC.
- **Incrementality / geo-holdout testing wired to the existing experimentation-holdouts skill, writing every test to the decision_log and reconciling lift against gold_revenue_ledger.** — brand: Gives a true counterfactual ('would these sales have happened anyway?') — the single question deterministic attribution cannot answer and the reason brands distrust Triple Whale. | Brain: Neutralizes Northbeam/Rockerbox's only real moat (causal measurement) while keeping Brain's deterministic-revenue-truth advantage as the holdout's ground truth — incrementality measured against a penny-accurate ledger is more credible than against a pixel. | revenue logic: Incrementality is the highest-willingness-to-pay growth feature (Rockerbox charges ~$2k/feature/mo, $5M+ spend floor). Brain can serve it down-market because the ledger and holdout assignment already exist, expanding ARR per account and moving upmarket.
- **Channel/campaign budget-reallocation recommendation as a registered detector (extend the recommendation engine beyond rto/realization/margin/scale), driven by blended_roas + gold_cac + the populated attribution credit ledger, confidence-gated.** — brand: Answers 'shift $X from Google to Meta' with a confidence grade and a drill-to-source — the 'now what' Peel/Daasity/Shopify never deliver. | Brain: Closes Brain's own insight→recommendation→action loop on the highest-value surface (ad budget), using the exact deterministic detector pattern already proven for margin/RTO — no new architecture. | revenue logic: Reallocation recs tie Brain directly to spend efficiency; brands measure Brain in saved ad dollars, making the %-of-GMV fee look like a rounding error and driving expansion + retention.

**Avoid:**
- Do NOT build a Markov/Shapley/data-driven 'ML attribution' to match Northbeam — you have no trained models, no Python training service, and a deterministic-first doctrine. You will lose the rigor war and break your own explainability promise. Win on revenue-truth + incrementality ground truth instead.
- Do NOT ship the attribution dashboard with the credit ledger still at 0 rows — auto-triggering reconcileAttribution on finalization (it is currently manual/Argo) must precede any channel-ROAS UI, or you reproduce Triple Whale's 'buggy/empty attribution' reputation on day one.
- Do NOT chase Moby-style autonomous ad bidding (Autopilot). You have no action-execution layer, no Temporal workflow wired, and recommend-only governance. Autonomous bid changes on a 0-row credit ledger is a P0 trust-destroyer; stay copilot/approve-only until incrementality validates the recs.

### CRO Specialist
**Insights:**
- Brain has a genuinely strong, deterministic storefront funnel (computeStorefrontFunnel: sessions→product.viewed→cart.item_added→checkout.started→purchased, distinct-session reach, integer-only rates, honest no_data) — this is better-engineered than Triple Whale's funnel and grounded in a replayable pixel. But it STOPS at measurement. A CRO buys a tool to find WHERE and WHY conversion leaks and to TEST a fix; Brain shows the leak and walks away. The funnel has no segmentation (device/source/landing-path), no per-step drop diagnosis, and no experiment to close the loop.
- The abandoned-cart surface is the clearest revenue-on-the-floor gap. silver_checkout_signal captures Shopflo checkout_abandoned with abandonedValueMinor (recoverable GMV at risk), discountApplied, has_address — Brain literally computes the money left on the table and then does NOTHING with it. There is no recovery trigger, no audience export, no outbound channel wired to it. Klaviyo/Postscript monetize exactly this. 'Recoverable GMV at risk' surfaced as a number with no action is the inverse of Brain's own 'no empty charts' principle.
- The funnel reads silver_touchpoint where only touches WITH brain_anon_id sessionize (docs note 23/94 in dev) — so the conversion-rate denominator is structurally undercounted and the funnel will silently disagree with Shopify's session count. For a CRO, a funnel whose top number is wrong is worse than no funnel: it produces false 'improvements.' First-party pixel coverage (server-side, CNAME host already laid in Phase H) is the prerequisite the funnel quietly depends on.
- Brain's recommendation detectors are ALL brand-grain (rto_risk, realization_gap, margin_erosion, scale_opportunity) — none operate at the product, landing-page, or funnel-step grain where CRO actually happens. silver_product exists (units_sold, gross_revenue, discount) and the funnel has per-step rates, but no detector says 'product X has high cart-adds but low checkout-starts — investigate PDP/shipping-cost shock.' The detector architecture is the right pattern aimed at the wrong grain for conversion work.

**Challenge to Brain:** Your product sequence ends at 'Recommendations → Outcomes → Learning,' but on the conversion surface you measure the leak and the recoverable GMV and then stop — there is no test, no recovery trigger, no funnel-step recommendation. A CRO cannot act on a funnel chart and a number labeled 'recoverable GMV at risk.' If you won't close the loop from funnel-leak → hypothesis → A/B test → measured lift, you are Peel/Shopify Analytics with better lineage — descriptive, not decision-intelligence. Which conversion ACTION will Brain actually drive, and how is its lift measured against the ledger?

**Must build:**
- **Segmented funnel + per-step drop-off diagnosis on the existing computeStorefrontFunnel — split by traffic source (utm/channel already in silver_touchpoint), device, and landing_path/page_type, with the biggest-leak step auto-flagged.** — brand: Tells a CRO exactly WHERE conversion breaks and for WHOM (e.g. 'paid_meta mobile drops 60% at checkout.started') — the diagnosis Shopify/Peel/Lifetimely cannot produce. | Brain: Pure extension of an existing deterministic mart (silver_touchpoint already carries utm, page_type, landing_path) — high-value CRO surface at near-zero new architecture, deepening the analytics moat. | revenue logic: Segmented funnels are the daily-use surface that creates stickiness and seat expansion (CRO + growth + merchandising all open it); daily-active analytics is the strongest retention predictor against churn-prone incumbents.
- **Abandoned-cart recovery loop — turn silver_checkout_signal's recoverable-GMV-at-risk into a consent-gated audience/trigger exported to an outbound channel (the outbound-channels + integration-connectors skills exist), with recovery attributed back to gold_revenue_ledger.** — brand: Recovers real revenue that is currently only measured, not captured — the exact Klaviyo/Postscript value, but margin-aware and attributable. | Brain: Closes Brain's first true conversion ACTION loop (action→outcome→learning) on a surface where the recoverable money is already quantified, proving 'predictions and actions, not just dashboards.' | revenue logic: Recovered-cart GMV flows through the realized-revenue ledger Brain bills on — Brain's recovery feature literally increases the GMV base its %-fee is charged against, aligning Brain's revenue with the brand's recovered revenue.
- **Funnel-step / product-grain conversion detector (new registered detector) — e.g. 'high cart-add, low checkout-start on product X' or 'checkout-started→purchased collapse after a shipping/COD change', confidence-gated, paired with a one-click A/B test via the experimentation-holdouts skill.** — brand: Moves Brain from 'here is your funnel' to 'here is the specific leak, the likely cause, and a test to fix it' — the CRO core job-to-be-done. | Brain: Reuses the proven detector + decision_log + outcome-measurement pattern at the conversion grain, and the A/B pairing makes every recommendation self-proving (lift measured against the deterministic ledger). | revenue logic: Test-and-prove recs create a visible, attributable conversion-rate lift that justifies premium pricing and crushes churn — a brand will not cancel the tool that measurably raised its conversion rate.

**Avoid:**
- Do NOT ship more descriptive funnel/cohort breadth to match Peel's 150+ metrics — that is the trap (Peel is hated for charging more for descriptive metrics nobody acts on). Brain's differentiator is the action/test loop; breadth without action is undifferentiated.
- Do NOT trust the funnel's session denominator until first-party/server-side pixel coverage closes the brain_anon_id gap (23/94 in dev). Surfacing conversion rates off an undercounted top-of-funnel will produce false improvements and recreate the Triple-Whale 'disagrees with Shopify' trust collapse — gate the funnel UI on a coverage/confidence indicator.
- Do NOT build CRO recommendations on the data-starved attribution credit marts (0 rows) — anchor conversion detectors to the funnel + silver_product + checkout-signal marts that actually have data, or the recs will fire on emptiness and destroy trust.

## Council: Operators — a three-voice skeptical advisory council (DTC Founder, Ecommerce Director, Shopify Plus Consultant) stress-testing Brain's plan to become "The AI Growth Operating System for Commerce Brands." The personas were deliberately allowed to disagree; their disagreement is the product. The throughline they converge on: Brain's grounded reality (deterministic Bronze->Silver->Gold revenue ledger, metric registry with toleranceMinor=0, integer attribution credit math, RLS brand isolation, GST-grade billing) is a genuine trust-and-truth moat — but it is mostly invisible to a buyer, the AI/decision layer that every competitor is winning on is still deterministic-only with NO trained models and a write-only online feature store, and the entire revenue model is a single %-of-GMV rate with no automated month-close and no payment capture. The council's tension: the Founder wants Brain to ship a Triple-Whale-killing autonomous agent now; the Director refuses to trust any number that does not reconcile to Shopify/Razorpay to the penny first; the Consultant warns that Shopify-first incumbents (Elevar, Sidekick, Triple Whale) already own the install path and Brain's universal-pixel/Woo/Magento breadth is still external-credential-blocked vapor.

**Council's sharpest challenge:** Brain's only durable, uncopyable moat is penny-accurate, COD/RTO/settlement-aware, confidence-graded REVENUE TRUTH that reconciles to Shopify/Razorpay — yet that moat is invisible (no reconciliation receipt, attribution marts at 0 rows, confidence grades unwired to UI), structurally unclosed (Iceberg-serving flip bug-gated, billing seal manual, no payment reconciliation loop, two divergent feature definitions, Neo4j/Postgres doc drift), and being eclipsed in your own roadmap ambition by a deterministic-only, model-less AI/agent layer you cannot yet win. The unanimous council verdict: STOP racing the incumbents toward autonomous agents on an unclosed foundation, and instead make your truth moat VISIBLE and PRODUCTION-CLOSED — ship the reconciliation receipt + line-level profit + first-class confidence/freshness on a foundation whose own loop (auto-close, unified features, bug-free serving) is finished — because for every persona, trust is the conversion event and the fee-justifying basis, and an autonomous action built on a number a brand can't audit is not a feature, it's the exact black-box distrust that already makes them hate Triple Whale, Klaviyo, and Sidekick.

### DTC Founder ($8M revenue Shopify+Amazon brand, runs lean, no analyst, pays for Triple Whale + Lifetimely + Klaviyo and resents all three)
**Insights:**
- Every competitor's actual product I'm sold is an AGENT now — Moby 2 Autopilot, Lifetimely 'AI Profit Agent', Klaviyo Composer, Sidekick Pulse. Brain's grounded reality is brutally honest that there are ZERO trained models and the online feature store has no .get() caller. That means Brain today is a beautiful data warehouse with dashboards, which is exactly the category buyers have decided is commoditized (Shopify gives it free). I don't buy plumbing; I buy 'do my job.'
- The ONE thing I'd pay to switch for is the thing nobody else can do: a number that reconciles to my Shopify payout and my Razorpay settlement to the rupee. Brain actually has this — realized_revenue_ledger, toleranceMinor=0, GST invoices, COD/RTO terminal-class authority. Triple Whale's 15-25% discrepancy and Klaviyo's inflated attribution are open wounds. Brain has the cure and isn't selling it.
- Brain's COD/RTO/settlement-aware revenue truth (gokwik/shiprocket logistics, cod_rto_rate, silver_checkout_signal RTO risk) is an India/emerging-commerce superpower that Triple Whale, Northbeam, Lifetimely, Peel literally cannot represent — their revenue is gross Shopify top-line. For an India DTC brand bleeding 30% RTO, this is not a feature, it's survival.
- gold_marketing_attribution and gold_attribution_paths are data-starved (0 rows) and reconcileAttribution is manual/Argo, not auto-triggered. So Brain's headline 'attribution truth' story is structurally real but EMPTY in any demo — that is the fastest way to lose a founder in a trial: an empty chart, which violates Brain's own 'no empty charts' rule.

**Challenge to Brain:** You are trying to out-Triple-Whale Triple Whale on agents while sitting on ZERO trained models and an attribution mart with 0 rows. Stop. If you ship a half-baked autonomous agent on a deterministic RFM placeholder, you inherit every 'buggy/black-box/over-attributing' complaint your competitors have — without their distribution. Pick the fight you can actually win THIS quarter: penny-accurate, COD/RTO-aware profit truth that makes me fire Triple Whale, not a Moby clone that makes me distrust you.

**Must build:**
- **Reconciliation receipt: a one-screen, drill-to-source view that ties Brain's realized revenue to the brand's Shopify payout AND Razorpay settlement to the exact minor unit, with the delta explained line-by-line (refunds, RTO clawbacks, COD non-delivery, fees).** — brand: I finally trust ONE number and can fire the tool that's been lying to me by 20%; I see exactly why my 'revenue' isn't my 'payout'. | Brain: Turns Brain's invisible deterministic ledger + logistics-status authority into the single demoable wedge no competitor can copy; it is the 'capture truth -> build trust' product made visible. | revenue logic: Trust is the conversion event. A reconciled number is what justifies the %-of-GMV fee — a brand will not pay a fee computed on a basis it cannot audit. This screen directly underwrites the billing model.
- **Profit-per-order/customer/channel with REAL COGS lineage from order lines (silver_order_line already has unit_price/discount; wire cost_input/CM2 to line grain) — net contribution margin, not gross revenue.** — brand: I see which orders actually make money after COGS, shipping, RTO, and ad spend — the thing Klaviyo/Triple Whale structurally cannot show me. | Brain: Owns the 'profit truth' positioning Lifetimely charges for, but grounded in line-level lineage Lifetimely lacks; differentiates from every gross-revenue competitor. | revenue logic: Margin truth is what justifies acting on Brain's recommendations; brands expand spend with Brain when they can prove a recommendation grew PROFIT, not revenue — drives net-revenue-retention/expansion.
- **Auto-trigger reconcileAttribution on finalization + seed the attribution marts so journey/credit/ROAS surfaces are NEVER empty in a trial (close the 0-rows gap).** — brand: I see my real multi-touch journeys on day one, not a 'come back in 30 days' empty state. | Brain: Removes the single biggest demo-killer and honors Brain's own 'no empty charts' invariant; converts deterministic attribution from theory to visible product. | revenue logic: Trial-to-paid conversion lives or dies on a non-empty first session; populated attribution is the difference between a demo that closes and one that doesn't.

**Avoid:**
- Do NOT ship an autonomous 'Autopilot' agent that changes my Meta bids or sends Klaviyo campaigns on top of a deterministic RFM placeholder and 0-row attribution — that is the black-box, over-attributing trap your competitors are HATED for, and you'd own the blame with none of the distribution.
- Do NOT chase generative-AI feature count (40+ like Klaviyo). One reconciled, trustworthy number beats forty hallucinating ones — Sidekick's hallucination reputation is your gift; don't squander it.
- Do NOT bury the COD/RTO/settlement superpower under a generic 'analytics' nav; it's the wedge.

### Ecommerce Director (mid-market, $40M, has a data analyst, currently runs Northbeam + Segment, scar tissue from black-box attribution disputes)
**Insights:**
- Brain's metric registry (single definition, computed identically, parity-checked against an independent oracle, toleranceMinor=0) is the single most credible asset in the whole stack and it's the exact thing that ended my faith in Northbeam ('Meta drove 38%' with no derivation) and Rockerbox (credit opacity). NOBODY else has a CI-parity-checked single-source metric registry. This is the enterprise-trust differentiator and it's buried.
- The honest gaps in Brain's own grounding are disqualifying for me at procurement: ledger_source flip to Iceberg is BLOCKED on a dbt-StarRocks incremental-CTAS bug; billing seal is MANUAL-only with no scheduler; there's no payment capture and no meter<->invoice<->payment<->ledger reconciliation loop. I cannot put a vendor into production whose own books don't close automatically and whose lakehouse-serving flag is gated on a known bug.
- Two unconnected feature definitions (feature_customer_daily/gold_customer_scores from silver_customers vs CUSTOMER_FEATURES Redis from gold_customer_360) is training/serving skew waiting to happen. The moment Brain ships a real model, those two will disagree and re-create the exact 'tool disagrees with itself' distrust that kills analytics vendors. Unify the feature definition BEFORE any model.
- Brain markets identity on Neo4j but the running SoR is Postgres union-find and Neo4j is default-OFF and never read, and silver_customers.sql header still claims Neo4j mints brain_id. Doc/marketing drift like this is how a vendor loses a technical-eval; my analyst WILL grep the repo claims against reality.
- gold_revenue_analytics is built but ORPHANED (no reader) — that's dead code shipping as if it's a capability. Inventory discipline matters; I judge a vendor by whether what they claim maps to what runs.

**Challenge to Brain:** Your truth story is your moat, yet your OWN truth machinery isn't production-closed: lakehouse-serving is bug-gated, month-close is manual, there's no payment reconciliation loop, and you have two divergent feature definitions. You're selling 'confidence before decisions' while your back office runs on a manual seal button and a known dbt bug. Close YOUR loop before you ask me to trust YOUR decisions — productionize the data foundation (auto-seal, fix/route the Iceberg flip, unify features, fix the Neo4j doc drift) instead of adding a predictive layer on an unclosed base.

**Must build:**
- **Surface confidence + freshness as first-class on EVERY number — wire the existing cost_confidence/effective_confidence/attribution_confidence grades and a data-freshness/DQ state into the dashboard so every KPI shows its grade and as-of time (deterministic, no model).** — brand: I can defend every number to my CFO with its confidence grade and freshness — no more 'why does this disagree with the platform' fire drills. | Brain: Operationalizes Brain's stated 'confidence before decisions' principle and directly attacks the #1 enterprise complaint about Northbeam/Rockerbox/Triple Whale (opaque, over-confident numbers). | revenue logic: Confidence/freshness UI is the enterprise procurement unlock — it's what moves Brain from SMB tool to a $40M brand's system of record, enabling higher GMV tiers and multi-brand expansion.
- **Productionize the financial close: automated period seal (Argo cron over sealBillingPeriod) + the meter<->invoice<->payment<->ledger reconciliation loop, even before payment capture — with drift alerts.** — brand: I trust that Brain's billing of ME reconciles, which is the proof-of-competence that lets me trust Brain's billing-grade math on MY commerce. | Brain: Closes a glaring operational gap, makes revenue collection scalable/auditable, and is itself a reference implementation of the reconciliation rigor Brain sells. | revenue logic: No automated close = revenue leakage and manual ops cost per brand; auto-seal + reconciliation is the unit-economics fix that lets Brain scale brands without scaling ops headcount.
- **Unify the feature definition (one offline+online definition feeding both training and serving; eliminate the silver_customers-vs-gold_customer_360 split) AND fix the identity/Neo4j doc drift to match the Postgres-SoR reality.** — brand: The scores Brain shows me are internally consistent and the vendor's claims survive my analyst's audit — I can sign the security/tech review. | Brain: Kills training/serving skew before it ships, removes a procurement-killing credibility gap, and makes the eventual ML layer trustworthy by construction. | revenue logic: A passed technical eval is the gate to every enterprise/multi-brand contract; consistency-by-construction prevents the trust collapse that causes churn after the first wrong score.

**Avoid:**
- Do NOT flip ledger_source to Iceberg-default in production until the dbt-StarRocks incremental-CTAS bug is resolved or the marts are re-materialized as tables — shipping a known-bug-gated serving path is how you create a silent-data-incident.
- Do NOT add a predictive ML layer on top of two divergent feature definitions and an unclosed financial base — you'd be building the penthouse before the foundation is poured.
- Do NOT keep orphaned/aspirational code (gold_revenue_analytics) and drifted docs (Neo4j) presented as live capability; prune or wire it. Claim only what runs.

### Shopify Plus Consultant (implements tracking stacks for 30+ Plus merchants; lives in the Elevar/Triple Whale/Sidekick install reality)
**Insights:**
- The buying decision happens at the SHOPIFY INSTALL PATH, and that's where Brain is weakest in its own grounding: the pixel needs a Shopify RECONNECT for new scopes, Web Pixels checkout deploy is EXTERNAL-BLOCKED, and Woo/Magento installers are credential-blocked vapor. Elevar (official checkout-extensibility preferred partner, 6,500 merchants) and Sidekick (free, pre-installed) own this real estate. Breadth Brain can't yet ship is not a differentiator — it's a promise.
- Brain's actual deployed pixel + connector ingestion can look REDUNDANT to a brand already running Elevar for CAPI delivery + consent. My merchants won't rip out trusted conversion tracking. Brain must position as the layer ABOVE Elevar (ingest its server-side events, reconcile, decide) — NOT as a replacement pixel. The grounding even notes Brain has a feedback/CAPI route (/api/v1/feedback/capi) — lean into complement, not combat.
- Brain's consent/RLS/regional residency discipline (PII vault, KMS, FORCE-RLS, GDPR erase, consent suppressor) is genuinely better than the SMB tools — and post-iOS, post-consent-mode, Plus merchants are getting audited. This is a real, sellable Plus-tier differentiator that NONE of Triple Whale/Lifetimely/Peel emphasize. But it's framed as plumbing, not as the compliance shield a Plus merchant's legal team wants.
- The 'progressive unlock / data-foundation-health' entitlements model is a smart honest answer to the empty-chart problem and the setup-friction every competitor (Northbeam 29-day onboarding, Daasity weeks, Elevar setup-is-#1-complaint) is hated for. Brain's guided onboarding + 'data foundation before dashboards' is a real wedge against onboarding pain — IF the first-session time-to-trusted-value is days not weeks.
- Brain's single Kafka topic + Spark Iceberg sink with the SAME admission gate as the PG writer, replayable MERGE-on-(brand,event_id), is genuinely more robust than a client pixel — this is the Northbeam 'server-side, less iOS-fragile' argument, but Brain can ALSO show real-time, which Northbeam can't. Real-time + replayable + server-side is a triple Brain uniquely holds; it's not being told as a story.

**Challenge to Brain:** Your entire breadth narrative (universal pixel, Woo, Magento, marketplaces) is EXTERNAL-CREDENTIAL-BLOCKED and your Shopify pixel needs a reconnect — meanwhile Elevar and free Sidekick own the install path. You're selling platform-breadth you can't yet deploy against incumbents who own the one platform that matters. Win Shopify Plus DEFINITIVELY as the trust/decision layer ABOVE the existing tracking stack (ingest Elevar/Shopify, reconcile, decide) before spreading thin on Woo/Magento vapor — depth on the platform you have beats breadth you can only promise.

**Must build:**
- **Frictionless Shopify Plus install + a 'sits-above-your-stack' ingestion mode that ingests Elevar/Shopify server-side events and reconciles them, plus a one-click reconnect flow that completes scopes/Web-Pixel checkout without a consultant.** — brand: I get Brain live in a day without ripping out Elevar/Triple Whale, and it immediately reconciles what they're already sending — zero-risk adoption. | Brain: Removes the redundant-plumbing objection, exploits Elevar's #1 (setup) and Sidekick's (hallucination) weaknesses, and meets the merchant where they already are. | revenue logic: Time-to-trusted-value in days = trial conversion; coexisting with the incumbent stack lowers switching risk to zero, expanding the addressable base to every brand already running a tracking tool.
- **A Plus-tier compliance/trust shield: surface the existing consent/RLS/residency/PII-vault/audit machinery as a merchant-facing 'data governance & consent' report (consent coverage, residency, erase audit, WORM audit trail).** — brand: My legal/privacy team gets an auditable consent + residency posture for Shopify's checkout/consent-mode era — a thing my current SMB tools can't produce. | Brain: Converts invisible compliance plumbing into a Plus-tier differentiator and procurement asset that Triple Whale/Lifetimely/Peel structurally lack. | revenue logic: Compliance is a price-insensitive, legal-mandated buy — it justifies a premium Plus tier and shortens enterprise security review, lifting ACV and reducing sales-cycle friction.
- **Tell the real-time + replayable + server-side + reconciled story as the explicit anti-Northbeam/anti-Triple-Whale wedge: live decisions (StarRocks sub-second) on a server-side, replayable, penny-reconciled base — with confidence shown.** — brand: I get Northbeam's server-side rigor AND live intraday decisions AND a number I can trust — the three things I currently buy three tools to half-get. | Brain: Names a defensible position no single competitor holds (Northbeam=slow/server-side, Triple Whale=fast/client-pixel/discrepant) and grounds it in capabilities Brain actually runs today. | revenue logic: A clear category position is the marketing lever that justifies replacing a multi-tool stack with Brain — consolidation is the expansion/ARR story.

**Avoid:**
- Do NOT keep marketing Woo/Magento/marketplace breadth and 'universal pixel' as live capability while they're credential-blocked — overclaiming breadth you can't deploy is exactly the credibility hit that loses a Plus tech-eval.
- Do NOT position Brain as a replacement for Elevar/Shopify tracking; position ABOVE it — fighting the install incumbent for the pixel slot is an unwinnable, redundant-plumbing fight.
- Do NOT lead with Neo4j 'graph identity' to Plus buyers when the running identity SoR is Postgres — sophisticated buyers will catch the gap and discount everything else you claim.

## Council: Strategy & Success — a deliberately divided two-voice council. The McKinsey Consumer Partner argues from market structure, willingness-to-pay, and where defensible value accrues; the Customer Success Leader argues from adoption friction, trust formation, and what actually makes a merchant renew. They agree Brain's data foundation is genuinely strong (real medallion lakehouse, deterministic revenue ledger, identity graph in PG, metric registry with exact-integer money, 4 deterministic recommendation detectors). They DISAGREE sharply on what Brain should do next: the Partner wants Brain to pick a defensible wedge and monetize outcomes aggressively; the CS Leader warns that Brain has built a beautiful engine that no merchant has yet been made to trust or act on, and that 'truth' is not a feature a buyer pays for until it changes a decision.

**Council's sharpest challenge:** Brain has world-class proof of TRUTH and zero proof of VALUE. It can reconcile revenue to the penny on an immutable lakehouse, but it has no paying customer, no way to actually collect money (metering is a manual button with no payment rail), and not one recorded instance of a merchant acting on a recommendation and seeing an outcome. The Partner and the CS Leader disagree on the wedge — CFO-revenue-truth vs first-run found-money moment — but they converge violently on this: Brain's roadmap energy must STOP flowing into new marts, ML skeletons, and the dead Neo4j graph, and ALL of it must flow into the chain 'reconcile to the penny in front of a real brand -> surface one found-money finding -> close one recommendation-to-outcome loop -> charge a share of the GMV you proved.' Until that single end-to-end chain works with 10 real brands, Brain is the most architecturally honest product in the category that no one has been made to trust, act on, or pay for — and 'best data foundation' is an epitaph, not a moat.

### McKinsey Consumer Partner
**Insights:**
- Brain's only durable moat is REVENUE TRUTH, and it is real where every well-funded incumbent is structurally weak. Triple Whale ships 15-25% discrepancies vs Shopify; Klaviyo reports gross self-attributed revenue with no COGS/refunds/ad-spend; Shopify Sidekick literally hallucinates numbers. Brain has an immutable replayable Iceberg Bronze, a deterministic gold_revenue_ledger with toleranceMinor=0, and a metric registry with one definition per KPI. That is a category-of-one claim — but ONLY if it reconciles to Shopify/Razorpay to the penny in front of the buyer, on day one, as the demo.
- Brain's monetization model is its biggest strategic asset AND its biggest unforced error. %-of-realized-GMV billing (gmv_meter_snapshot, billing_plan rate_bps) is the most defensible pricing in the category — it aligns Brain's revenue to verified merchant revenue, the exact thing competitors can't measure. Triple Whale/Peel are hated for charging more for identical features as volume grows; Klaviyo for active-profile billing shock. Brain bills only on truth it can prove. But there is NO payment collection, NO automated sealing, NO admin console — the monetization engine is built but cannot actually charge anyone. ARR is currently $0-capable.
- The CAC/margin surface is where Brain wins the C-suite, not attribution. gold_cac, contribution-margin CM2 (cost_input 0055), and blended_roas tie acquisition cost to verified margin. Klaviyo, Postscript, Elevar, and Peel structurally cannot subtract COGS. A CFO buys 'real profit per channel/customer'; a performance marketer buys attribution. Brain should sell to the person who signs the check, where the moat is strongest, not chase Triple Whale's performance-marketer turf where Moby 2 has 60k-brand distribution Brain cannot match.
- India/emerging-commerce is an unclaimed category. Brain has COD/RTO logistics truth (silver_shipment, @brain/logistics-status, gokwik/shiprocket, cod_rto_rate metric), GST invoicing (CGST/SGST/IGST, gapless numbering, credit notes), and Razorpay. NO Western incumbent (Triple Whale, Northbeam, Klaviyo, Segment, Rockerbox) models COD/RTO settlement-aware revenue. This is a defensible geographic wedge with a real revenue-truth problem the West ignores.

**Challenge to Brain:** Brain is building horizontally — 28 dashboards, 85 BFF routes, 10 gold marts, an ML platform skeleton, a feature store, a Neo4j graph that nothing reads — as if it competes with all eight incumbents at once. It competes with NONE of them yet, because it has zero paying brands and the one thing it can charge for (GMV metering) has no payment rail. Pick ONE wedge (revenue-truth-for-the-CFO, India COD/RTO truth, or 'the auditable layer above Klaviyo') and prove it with 10 brands reconciling to the penny BEFORE adding a single new mart or an ML model. Horizontal breadth against funded incumbents with no customers is how Brain dies.

**Must build:**
- **Penny-reconciliation proof surface: a first-class 'Brain vs Shopify/Razorpay' reconciliation report that shows, per period, Brain's deterministic realized revenue next to the platform's reported number, the delta, and the drill-to-source for every discrepancy line. Built on the existing gold_revenue_ledger + realized_gmv_composition seam + metric registry — no new data infra, just a surfaced view.** — brand: Directly attacks the #1 documented pain across Triple Whale (15-25% discrepancies, 'buggy attribution') and Klaviyo (inflated attributed revenue). The merchant SEES Brain is right where their current tool is wrong — trust is demonstrated, not asserted. | Brain: This is the entire sales demo and the only un-fakeable differentiator. It converts 'we have a lakehouse' (which no buyer cares about) into 'we found the money your current tool is hiding' (which every buyer cares about). It is the wedge that justifies replacing an incumbent. | revenue logic: Reconciliation that recovers/explains even 5% of misattributed GMV pays for Brain's fee many times over; it is the proof that makes %-of-GMV pricing feel like a share of value created, not a tax.
- **Close the monetization loop: automated month-close (scheduled sealBillingPeriod via Argo/cron), payment collection (Razorpay/Stripe subscription + payment_status on invoice), and a Brain-internal billing admin to set billing_plan.rate_bps. Today metering/sealing is manual-button-only and there is no way to actually get paid.** — brand: Predictable, transparent, value-aligned billing — Brain charges a share of revenue it can prove, vs the mid-contract hikes (Triple Whale +30-50%) and billing-shock (Klaviyo active-profile, Postscript surprise charges) the market resents. | Brain: Without this, ARR is structurally impossible — Brain can issue a GST invoice but cannot collect a rupee or close a period without a human clicking. This is the difference between a product and a business. | revenue logic: Activates the already-built %-of-realized-GMV engine into actual recurring, auto-expanding revenue: as a brand grows verified GMV, Brain's revenue grows with zero sales motion — the cleanest net-revenue-retention story in the category.
- **A productized India COD/RTO revenue-truth pack: surface settlement-aware realized revenue (COD delivered vs RTO-clawed-back), RTO-risk-gated recommendations, and CAC-against-net-of-RTO margin — packaged as the headline offer for Indian D2C, built on the existing silver_shipment, cod_rto_rate, gokwik/shiprocket, and the rto_risk detector that already exist.** — brand: Indian brands lose 20-40% of COD orders to RTO; no Western tool models this, so their 'revenue' and 'ROAS' are fiction. Brain shows true net revenue and true CAC after RTO — a number they literally cannot get elsewhere. | Brain: An uncontested geographic + vertical wedge where Brain's logistics-truth assets are unique and incumbents have zero coverage. Defensible because the data problem (COD/RTO/settlement) is invisible to Shopify-first Western tools. | revenue logic: %-of-realized-GMV pricing is MORE honest in India because it bills on delivered-and-paid revenue, not gross orders — directly aligned with the merchant's actual cash, a wedge against gross-revenue-billed competitors.

**Avoid:**
- Do NOT build trained ML models or invest further in the ml.model_registry/prediction_log/feature-store skeleton yet. The deterministic RFM/churn/CM2 detectors are sufficient and MORE trustworthy as a wedge. No buyer pays for black-box predictions when they don't yet trust your deterministic numbers. ML is a post-trust, post-revenue investment.
- Do NOT chase Triple Whale's agentic/Moby-2 autonomous-action narrative. Brain has zero distribution, zero customers, and a recommend-only engine. Autonomous ad-bid execution against a 60k-brand incumbent is a losing fight that also undermines Brain's trust positioning (auditable > autonomous).
- Kill or fully retire the Neo4j identity graph as a roadmap item. It is default-OFF, non-authoritative, nothing reads it, and its brain_id scheme differs from the authoritative PG mint. It is pure carrying cost and doc-drift risk. PG is the identity graph — own that story.
- Stop adding gold marts. gold_revenue_analytics is already orphaned (no reader); gold_marketing_attribution/gold_attribution_paths are data-starved at ~0 rows. Breadth without populated data or a paying buyer is negative work.

### Customer Success Leader
**Insights:**
- Brain has built a superb engine and zero proof a human will trust or act on it. The recommendation layer is 4 deterministic, BRAND-level detectors that are recommend-only — nothing is executed, and there is no evidence any merchant has acted on one and seen an outcome. Every competitor that wins on retention (Lifetimely 4.9/5 over 493 reviews, 3-5yr tenure; Peel high-touch CSMs) wins because a human makes a daily decision on the tool. Brain's entire renewal thesis rests on a loop that has never closed with a real user.
- 'Truth' and 'confidence/freshness as first-class' are engineering values, not buyer values — UNTIL they change a decision the merchant was about to make wrongly. The data foundation rules ('no empty charts', 'confidence before decisions') are correct and rare, but a confidence badge on a chart does not drive renewal. The thing that drives renewal is: 'Brain told me to stop spending on Channel X because it's RTO-loss-making, I did, and I saved money.' Brain has the inputs (rto_risk + CM2 + blended_roas) but has not packaged a single before/after outcome story.
- Onboarding friction is where every competitor bleeds and where Brain can win or lose its first 10 customers. Northbeam (29-day onboarding, 3 months upfront), Daasity (weeks-months, 'worst implementation ever'), Elevar (74% of complaints are setup), Rockerbox (needs a full-time dev) — the entire category is hated for time-to-value. Brain's onboarding sequence is real (auto-login, soft-gate verify, website capture, progressive unlock) but the data-foundation-first philosophy means a merchant sees NOTHING until sync+health pass. The risk: Brain's principled 'no empty charts' becomes 'no value for the first two weeks' — the exact thing that kills activation.
- The two-Customer-360 problem and write-only feature store are symptoms of a deeper issue: Brain optimizes for architectural correctness over the user's first 'aha.' There are two getCustomer360 surfaces (identity-control-plane vs analytics), a feature store nothing reads, and an entitlements system gated purely on data-readiness with no plan input. A new merchant doesn't need correctness; they need ONE screen that says 'here is money you're losing and here's what to do.' That screen does not exist as a packaged first-run experience.

**Challenge to Brain:** Brain's CLAUDE.md says 'Capture Truth -> Build Trust -> Enable Decisions' but Brain has spent 100% of its effort on Capture and ~0% on the human side of Trust and Decisions. Trust is not an immutable ledger — trust is a merchant watching Brain catch one error their old tool missed, then acting on one recommendation and seeing the result. Decisions is not a decision_log audit table — it's a person changing behavior. Brain has confused building the substrate of trust with earning it. Name the FIRST decision Brain will change for a real merchant in week one, instrument the outcome, and make that the product — or Brain will have the best data foundation no one renews.

**Must build:**
- **A first-run 'Money Found' moment: within the first session after sync+health pass, surface ONE concrete, drill-to-source finding — e.g. 'Shopify reports X revenue; Brain's verified ledger shows Y; here is the Z delta and why', or 'Channel A's ROAS is 3.2 on gross but 0.9 after RTO+COGS.' Built from existing reconciliation + CM2 + cod_rto assets, packaged as the activation screen.** — brand: Collapses time-to-trust from weeks (Northbeam/Daasity pain) to one session. The merchant's first experience is Brain being demonstrably right about THEIR money, not an empty dashboard or a setup checklist. | Brain: This is the activation metric that predicts renewal. Brain's 'data foundation first' principle is a liability unless the first thing the merchant sees after the foundation is a payoff. This converts the principle into an asset. | revenue logic: Activation-to-first-value is the single biggest driver of trial conversion and 90-day retention in this category; a packaged 'aha' is the difference between Lifetimely-style 3-5yr tenure and churn-after-trial.
- **Close ONE recommendation-to-outcome loop end to end with measurement, for one detector (start with rto_risk or margin_erosion): merchant sees the rec, takes the action (even if executed manually/off-platform), and Brain measures and shows the outcome via the existing recommendation_outcome + recommendation_action ledger. Make the before/after visible in the UI.** — brand: Turns Brain from a dashboard into a decision partner — the merchant gets a measured win, the thing Peel/Daasity/Shopify-native explicitly do NOT provide (they stop at the chart). | Brain: Proves the core thesis (insights->action->outcome->learning) with real data instead of architecture. One measured outcome per merchant is the renewal story and the testimonial engine. The ledgers already exist — the gap is the human-facing loop, not the schema. | revenue logic: Documented outcomes (Rockerbox-style '10x spend at 2x ROAS' case studies) are what justify premium and expansion pricing; a measured saved-rupee per merchant is the expansion lever and the referenceable proof.
- **A guided, low-friction onboarding that delivers interim trusted value DURING sync, not after — show data-foundation-health honestly (confidence/freshness state) but pair every 'not ready yet' with a partial, already-trustworthy signal (e.g. order/revenue truth ready before journey/attribution). Plus a human-assisted white-glove path for the first 10 brands.** — brand: Avoids the category's universal onboarding death (Northbeam 29 days, Daasity 'worst ever', Elevar setup hell) while keeping Brain's honesty advantage — the merchant always knows what's trustworthy and never sees a fake chart. | Brain: First-10-customer activation is existential. White-glove + interim value de-risks the riskiest moment (the gap between connect and value) where Brain's principled patience could read as 'broken/empty'. | revenue logic: Onboarding completion rate is the top of the entire revenue funnel; every brand that stalls in setup is lost ARR. The high-touch path also generates the case studies that make %-of-GMV pricing defensible.

**Avoid:**
- Do NOT ship more dashboard surface area before one merchant has acted on one recommendation. 28 pages with no proven decision-change is breadth that increases cognitive load (the exact 'overwhelming for ops teams' complaint leveled at Triple Whale) without increasing renewal.
- Do NOT lean on 'confidence and freshness as first-class' as the marketing headline. It is a real differentiator but it is a SUPPORTING trust signal, not a reason-to-buy. The headline must be a found-money outcome; confidence is the thing that makes the merchant believe the outcome.
- Avoid the trap of treating the decision_log/recommendation ledgers as 'the decision layer done.' Audit tables are necessary plumbing, not the product. The product is a human changing behavior and seeing a result — invest there.
- Do not build a self-serve-only motion for the first cohort. Brain's value (revenue truth, RTO/margin) is non-obvious and requires interpretation; a pure self-serve trial against free Shopify Sidekick will lose on 'why pay.' High-touch first, productize the playbook after.

---

# Appendix D — Grounded Capability Inventory

> The factual backbone: what genuinely exists in the repo today, with real file/table/mart names and an honest maturity rating (production / partial / stub / absent).

## Gold marts & metric registry (db/dbt/models/marts + packages/metric-engine)

_METRIC_REGISTRY (registry.ts) is the genuine single-source-of-truth: 21 metric IDs at v1, each with a named readSeam, recognitionLabels, and toleranceMinor=0 (exact-integer money; money = BIGINT minor units + currency_code per I-S07). Registry-backed KPIs: realized_revenue, provisional_revenue, ad_spend, blended_roas, cod_rto_rate, cod_mix, checkout_funnel, order_status_mix, journey_first_touch_mix, journey_stitch_rate, journey_timeline, attribution_credit, attribution_reconciliation_rate, attribution_confidence, cost_confidence, effective_confidence, aov, cac, ltv, repeat_rate, top_products, cohort_retention. Architectural rule enforced consistently across marts (ADR-004): Gold stores ADDITIVE components only; non-additive ratios (AOV, LTV, RTO%, CAC, repeat_rate, retention) are derived AT READ in the metric-engine, never precomputed in dbt. The metric-engine is the SOLE Gold reader via withSilverBrand (I-ST01) with BRAND_PREDICATE injected at the seam — the web UI never queries StarRocks directly; it goes through apps/core BFF/analytics queries. All gold marts target StarRocks schema brain_gold (PRIMARY-key tables, distributed_by brand_id); feature_customer_daily lives in brain_feature (feature/analytics boundary, M10). 10 gold_* marts exist on disk; 7 are production-wired, 1 (gold_revenue_analytics) is orphaned, and 2 (gold_marketing_attribution, gold_attribution_paths) plus snap_attribution_credit are complete-but-data-starved. Maturity is high for revenue/customer/CAC/cohort surfaces (real readers + parity oracle + live tests) and stub for the predictive ML layer._

- **Metric Registry (single-source KPI definitions)** `[production]`
  - where: packages/metric-engine/src/registry.ts (METRIC_REGISTRY const + resolveMetric); tested in registry.test.ts + attribution-parity-oracle.test.ts
  - data: 21 registry-backed metric IDs keyed by (metricId, version='v1'): realized_revenue, provisional_revenue, ad_spend, blended_roas, cod_rto_rate, cod_mix, checkout_funnel, order_status_mix, journey_first_touch_mix, journey_stitch_rate, journey_timeline, attribution_credit, attribution_reconciliation_rate, attribution_confidence, cost_confidence, effective_confidence, aov, cac, ltv, repeat_rate, top_products, cohort_retention. Each row carries readSeam, recognitionLabels, toleranceMinor=0 (exact-integer money). Compile-time TS const is the M1 binding; Postgres metric_definition is the long-term SoR.
- **gold_executive_metrics — executive headline KPI components** `[production]`
  - where: db/dbt/models/marts/gold_executive_metrics.sql (schema brain_gold, table, PK brand_id+currency_code); read by computeExecutiveMetrics (executive-metrics.ts) via withSilverBrand; wired in apps/core/.../queries/get-executive-metrics.ts + bff.routes.ts:2609
  - data: Grain: 1 row per (brand_id, currency_code). Cols: total_orders, realized_value_minor (BIGINT), distinct_customers, terminal_orders, delivered_orders, rto_orders, cancelled_orders, refunded_orders, updated_at. Additive only; AOV/LTV ratios derived at read. Powers registry metrics aov, ltv (cohort-naive).
- **gold_cac — Customer Acquisition Cost components** `[production]`
  - where: db/dbt/models/marts/gold_cac.sql (brain_gold, PK brand_id+acquisition_month+currency_code); read by computeCac (cac.ts); wired get-executive-metrics.ts
  - data: Grain: 1 row per (brand_id, acquisition_month 'YYYY-MM', currency_code). Cols: new_customers (COUNT first_seen_at), acquisition_spend_minor (SUM spend_minor BIGINT), updated_at. Full-outer-joins silver_customers × silver_marketing_spend. Powers registry metric cac (ratio derived at read, null when new_customers=0).
- **gold_revenue_analytics — revenue rollup by month×lifecycle×currency** `[partial]`
  - where: db/dbt/models/marts/gold_revenue_analytics.sql (brain_gold, PK brand_id+period_month+lifecycle_state+currency_code)
  - data: Grain: 1 row per (brand_id, period_month, lifecycle_state, currency_code). Cols: order_count, realized_value_minor (BIGINT), terminal_order_count, updated_at. Reads silver_order_state. NOTE: mart builds but has NO non-test reader in apps/packages (orphaned — no metric-engine/BFF query references it).
- **gold_revenue_ledger — realized-revenue ledger served from lakehouse** `[production]`
  - where: db/dbt/models/marts/gold_revenue_ledger.sql (brain_gold, incremental, PK brand_id+ledger_event_id); read by get-revenue-metrics/get-cod-mix/get-blended-roas/get-settlement-summary via withSilverBrand
  - data: Grain: 1 row per (brand_id, ledger_event_id), append-only. Cols: order_id, brain_id, event_type, amount_minor (signed BIGINT), currency_code, fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, ingested_at, updated_at. var ledger_source default 'iceberg' (brain_bronze.revenue_ledger) reversible to 'pg'. Backs realized_revenue/provisional_revenue/cod_mix/blended_roas reads.
- **gold_marketing_attribution — attribution credit/clawback ledger (lakehouse)** `[partial]`
  - where: db/dbt/models/marts/gold_marketing_attribution.sql (brain_gold, PK brand_id+credit_id); read by get-channel-roas/get-campaign-roas/_attribution-credit via withSilverBrand
  - data: Grain: 1 row per (brand_id, credit_id) flat ledger. Cols: order_id, brain_anon_id, touch_seq, channel, campaign_id, model_id, row_kind, credited_revenue_minor (signed BIGINT), currency_code, realized_revenue_minor, reversed_of_credit_id, confidence_grade, attribution_confidence DECIMAL(4,3), model_version, occurred_at, economic_effective_at, billing_posted_period. Backs registry attribution_credit/attribution_reconciliation_rate/attribution_confidence + computeChannelRoas/computeCampaignRoas. var ledger_source default 'iceberg'. Doc notes 0 rows today (data-starved until attribution flows).
- **gold_attribution_paths — journey/path-grain attribution (M9)** `[partial]`
  - where: db/dbt/models/marts/gold_attribution_paths.sql (brain_gold, PK brand_id+brain_anon_id+stitched_order_id)
  - data: Grain: 1 row per CONVERTED journey. Cols: stitched_brain_id, channel_path (ordered ' > ' string), touch_count, distinct_channel_count, first_touch_channel, last_touch_channel, path_start_at, path_end_at, updated_at. Reads silver_touchpoint WHERE stitched_order_id IS NOT NULL. No money col. Not registry-backed (deterministic projection); populates only once journey-stitch+conversions flow.
- **gold_customer_360 — per-customer denormalized view** `[production]`
  - where: db/dbt/models/marts/gold_customer_360.sql (brain_gold, incremental, PK brand_id+brain_id); read by getCustomer360Summary (customer-360.ts) + computeExecutiveMetrics repeat_rate fold; wired get-customer-360.ts, bff.routes.ts:3143
  - data: Grain: 1 row per (brand_id, brain_id). Cols: lifetime_orders, lifetime_value_minor (BIGINT), currency_code, first_seen_at, first_identified_at, last_seen_at, delivered/rto/cancelled/refunded_orders, customer_watermark, updated_at. Joins silver_customers × silver_order_state lifecycle. Also the repeat_rate source (lifetime_orders>=2 fold).
- **gold_customer_scores — deterministic RFM + churn-risk scoring** `[production]`
  - where: db/dbt/models/marts/gold_customer_scores.sql (brain_gold, PK brand_id+brain_id); read by getCustomerScore (customer-score.ts) + apps/core/.../ml/serve-customer-score.ts
  - data: Grain: 1 row per (brand_id, brain_id). Cols: scored_on, lifetime_orders, lifetime_value_minor, days_since_last_order, recency_score (1-5), frequency_score (1-5), monetary_score (1-5), churn_risk (low/medium/high), computed_at. Reads LATEST feature_customer_daily snapshot. Rule-based CASE bands (explicitly NOT ML — placeholder until models land). Not in metric registry MetricId union.
- **gold_customer_segments — value-tier segments** `[partial]`
  - where: db/dbt/models/marts/gold_customer_segments.sql (brain_gold, PK brand_id+segment)
  - data: Grain: 1 row per (brand_id, segment). Cols: customer_count, segment_value_minor (BIGINT), updated_at. Deterministic CASE bucketing of silver_customers.lifetime_value_minor (high/mid/low/no_realized_value). Not registry-backed; no dedicated metric-engine reader found.
- **gold_cohorts — acquisition cohorts** `[production]`
  - where: db/dbt/models/marts/gold_cohorts.sql (brain_gold, PK brand_id+cohort_month+currency_code); read by computeCohortRetention (executive-metrics.ts); wired get-cohort-retention.ts
  - data: Grain: 1 row per (brand_id, cohort_month 'YYYY-MM', currency_code). Cols: cohort_size, cohort_value_minor (BIGINT), cohort_orders, updated_at. Reads silver_customers first_seen_at. Backs registry metrics repeat_rate + cohort_retention (ratios derived at read).
- **feature_customer_daily — daily point-in-time customer feature snapshot (history/SCD)** `[production]`
  - where: db/dbt/models/marts/feature_customer_daily.sql (schema brain_feature, incremental, PK brand_id+brain_id+snapshot_date)
  - data: Grain: 1 row per (brand_id, brain_id, snapshot_date). Cols: currency_code, lifetime_orders, lifetime_value_minor, days_since_last_order, customer_age_days, first_seen_at, last_seen_at, computed_at. First/only history table; point-in-time training substrate; feeds gold_customer_scores. Append-per-day, idempotent same-day upsert.
- **History/snapshot marts (snap_order_state, snap_attribution_credit)** `[partial]`
  - where: db/dbt/models/marts/snap_order_state.sql (brain_silver, PK brand_id+order_id+snapshot_date); snap_attribution_credit.sql (brain_silver, PK brand_id+credit_id+snapshot_date)
  - data: snap_order_state: daily order-lifecycle snapshot (lifecycle_state, is_terminal, order_value_minor, currency_code, state_effective_at). snap_attribution_credit: daily credit-as-of snapshot (channel, campaign_id, model_id/version, row_kind, credited_revenue_minor, confidence_grade). Both append-per-day for restatement; snap_attribution_credit empty until attribution flows.
- **Non-registry metric-engine compute functions (Gold/Silver readers)** `[production]`
  - where: packages/metric-engine/src: contribution-margin.ts (CM1/CM2), attribution-channel-roas.ts, attribution-campaign-roas.ts, settlement-summary.ts, shipment-outcomes.ts, customer-360.ts, customer-score.ts, customer-commerce.ts, top-products.ts, executive-metrics.ts cohort fn
  - data: Tier-0 deterministic compute fns reading Gold/Silver marts via withSilverBrand. Some (channel_roas, campaign_roas, contribution_margin CM2, settlement) are NOT discrete rows in METRIC_REGISTRY's MetricId union though they are SOLE-emitter computers wired to BFF/analytics queries. blended_roas/cac are both registry rows AND compute fns. CM2 reads PG cost_input config (0055) + lakehouse realized+spend.
- **ML platform (model_registry + prediction_log) and feature-store online layer** `[stub]`
  - where: db/migrations/0083_ml_platform_foundation.sql (ml.model_registry, ml.prediction_log partitioned + p2026_06 + pdefault); apps/core/src/modules/ml (list-models, promote-model, serve-customer-score); packages/feature-store/src (Redis online store + offline materializer over gold_customer_360)
  - data: ml.model_registry (model lifecycle/versioning) + ml.prediction_log (partitioned prediction store) + Models UI. feature-store: TS feature-definition registry, Redis online store (TTL 25h), offline materializer from gold_customer_360, FeatureStaleError freshness sentinel. Serving path currently returns deterministic gold_customer_scores (no trained model yet); predictive LTV/churn deferred.

**Gaps:**
- gold_revenue_analytics builds but is ORPHANED — no non-test reader in apps/ or packages/ references it (month×lifecycle×currency rollup unused; executive/revenue dashboards read gold_executive_metrics + gold_revenue_ledger instead).
- gold_customer_segments and gold_attribution_paths have no dedicated metric-engine compute reader found (segments has no wired query; paths is a structural path-spine awaiting journey/conversion data).
- gold_marketing_attribution + gold_attribution_paths + snap_attribution_credit are data-starved (docs state ~0 rows) — attribution-backed registry metrics (attribution_credit, attribution_reconciliation_rate, attribution_confidence) and channel/campaign ROAS are structurally complete but unpopulated until journey-stitch + finalized-conversion flows produce credits.
- Several SOLE-emitter compute functions (channel_roas, campaign_roas, contribution_margin/CM2, settlement_summary, shipment_outcomes, top_products, customer scores, storefront metrics) are wired and parity-protected but are NOT discrete rows in METRIC_REGISTRY's MetricId union — registry coverage is 21 IDs while the engine emits more metrics than the registry formally enumerates.
- ML predictive layer is foundation-only: ml.model_registry/prediction_log + feature-store exist, but serve-customer-score returns deterministic gold_customer_scores RFM bands; no trained churn/propensity/predictive-LTV model. LTV registry metric is explicitly cohort-naive (realized-rev-per-customer), not a forecast.
- cohort_retention is order-count cohorts only (orders_per_customer); true period-over-period retention curve beyond order count is deferred (noted in executive-metrics.ts).
- gold_revenue_ledger/gold_marketing_attribution default to ledger_source='iceberg' but Iceberg revenue_ledger must be pre-materialized+fresh; source flip requires a --full-refresh (PG↔Iceberg type change) per the model header — operational gotcha, not a code gap.

## Silver/Bronze tier + ingestion pipeline (Kafka topics, Spark Bronze sink, dbt staging/intermediate/silver models, Iceberg)

_Maturity is genuinely high: the Bronze->Silver spine is production code, not stubs. The defining fact is that PG bronze_events is fully DROPPED (migrations 0070 + 0085) and Iceberg brain_bronze.collector_events is the sole raw Bronze SoR — staging models default bronze_source='iceberg' with 'pg' as a legacy-only escape. ONE Kafka topic ({env}.collector.event.v1) carries every event type, fanned out to many consumer groups; the Spark sink replicates the exact stream-worker admission gate (R2/R3 + lane split) so Iceberg == the PG-era admission set. Everything is replay-safe: append-only Iceberg MERGE WHEN NOT MATCHED on (brand_id,event_id), staging dedup on the same key or the 0018 ledger natural key. Money is BIGINT minor units + currency_code everywhere (I-S07). The cleanest honest caveat for downstream phases: 'Silver flows from raw Iceberg Bronze' is true for journey/order-line/shipment/checkout-signal, but order-state/customers/marketing-spend Silver still source DERIVED Postgres ledgers (worker-written), read via StarRocks JDBC read-shim views — do not claim those marts are lakehouse-sourced. Key files: db/dbt/models/staging/_sources.yml (the read boundary + flip doc), db/iceberg/spark/bronze_materialize.py (the sink), db/iceberg/bronze_table.sql (Bronze DDL), apps/stream-worker/src/main.ts (consumer-group topology)._

- **Bronze raw event log (Iceberg, sole SoR)** `[production]`
  - where: Iceberg table brain_bronze.collector_events (DDL db/iceberg/bronze_table.sql; created/written by db/iceberg/spark/bronze_materialize.py). PG bronze_events table DROPPED (migrations 0070_drop_bronze_events.sql, 0085_drop_pg_bronze_events.sql).
  - data: Columns: event_id, brand_id, occurred_at, ingested_at, schema_name, schema_version, event_type, correlation_id, partition_key, payload (verbatim envelope JSON STRING), processing_flags, collector_version. Grain = 1 row per (brand_id, event_id), append-only. Partitioned bucket(16, brand_id)+days(occurred_at), format-v2 parquet/zstd, 24-month retention. Replayable: idempotent MERGE WHEN NOT MATCHED ON (brand_id,event_id), I-E02.
- **Kafka/Redpanda streaming backbone** `[production]`
  - where: Single live topic '{APP_ENV}.collector.event.v1' (apps/core/src/main.ts:725, apps/stream-worker/src/main.ts:83). Separate backfill topic '{env}.collector.order.backfill.v1'. Producers: webhook pipeline (Shopify/WooCommerce/Razorpay/Shopflo/GoKwik/Shiprocket) + collector pixel.
  - data: CollectorEventV1 envelope: event_id, brand_id, correlation_id, event_name, occurred_at, ingested_at, consent_flags, properties.*. Many consumer groups on the ONE live topic (stream-worker-live, identity-bridge-live, consent-suppressor, live-ledger-bridge, settlement-ledger, spend-ledger, gokwik-awb-ledger). Partition key = tenant. At-least-once + manual commit + retry/DLQ.
- **Spark Structured Streaming Bronze sink (Kafka->Iceberg)** `[production]`
  - where: db/iceberg/spark/bronze_materialize.py (continuous two-phase: availableNow drain then processingTime stream). Run scripts run-bronze-spike.sh.
  - data: Reads {env}.collector.event.v1, applies the SAME admission gate as PG writer (R2 install_token->brand via pixel_installation, R3 consent_flags present, lane split: SERVER_TRUSTED_BRONZE={order.live.v1, shopflo.checkout_abandoned.v1, gokwik.rto_predict.v1, gokwik.awb_status.v1, shiprocket.shipment_status.v1}; LEDGER_ONLY={settlement.live.v1, spend.live.v1} EXCLUDED). Idempotent MERGE, per-batch dedup.
- **dbt staging layer (typed/deduped Bronze projections)** `[production]`
  - where: db/dbt/models/staging/: stg_order_ledger_events, stg_order_line_events, stg_touchpoint_events, stg_shipment_events, stg_checkout_signal_events (all materialized=view). Sources in _sources.yml.
  - data: stg_touchpoint/order_line/shipment/checkout read raw Iceberg bronze_iceberg.collector_events (var bronze_source default 'iceberg'; 'pg' is legacy escape only). stg_order_ledger reads PG billing.realized_revenue_ledger (a DERIVED ledger, not raw Bronze). Each does per-event-type filter, JSON extraction via parse_json/get_json_string, dedup on (brand_id,event_id) or 0018 natural key. Touchpoint event types: page.viewed, product.viewed, collection.viewed, cart.viewed, cart.item_added, search.submitted, checkout.started, scroll.depth, element.clicked.
- **dbt intermediate layer** `[production]`
  - where: db/dbt/models/intermediate/: int_order_lifecycle, int_touchpoint_sessionized (views).
  - data: int_order_lifecycle normalizes each ledger event to canonical lifecycle_state (provisional_recognition/finalization/cancellation/rto_reversal/cod_rto_clawback/cod_delivery_confirmed/refund/chargeback) + state_rank for terminal-wins. int_touchpoint_sessionized sessionizes touches by brain_anon_id. Deterministic, no model.
- **silver_order_state (canonical order entity)** `[production]`
  - where: db/dbt/models/marts/silver_order_state.sql (incremental, unique_key brand_id+order_id).
  - data: 1 row per (brand_id, order_id) = latest lifecycle state. Incremental on ingestion watermark (max_ingested_at, M3). Money minor units. From int_order_lifecycle.
- **silver_order_line (line-grain)** `[production]`
  - where: db/dbt/models/marts/silver_order_line.sql (table) from stg_order_line_events.
  - data: 1 row per (brand_id, order_id, line_index). sku, title, quantity, unit_price_minor, line_total_minor, line_discount_minor, product_id, variant_id, currency_code, occurred_at. Unnested from payload.properties.line_items of latest order.* event.
- **silver_product** `[production]`
  - where: db/dbt/models/marts/silver_product.sql (table) from silver_order_line.
  - data: 1 row per (brand_id, product_key, currency_code); product_key=product_id|sku|'unknown'. order_count, units_sold, gross_revenue_minor, discount_minor, first/last_sold_at. Derived from order lines (no product-catalog connector feed).
- **silver_customers** `[production]`
  - where: db/dbt/models/marts/silver_customers.sql (incremental, unique_key brand_id+brain_id).
  - data: 1 row per (brand_id, brain_id): lifetime_orders, lifetime_value_minor, first_seen_at, last_seen_at; first_identified_at LEFT-joined from identity.customer (silver_customer_identity_src, H6). Built from silver_order_state.
- **silver_touchpoint + silver_sessions (journey)** `[production]`
  - where: db/dbt/models/marts/silver_touchpoint.sql (per-touch grain brand_id+brain_anon_id+touch_seq) + silver_sessions.sql (session rollup) from int_touchpoint_sessionized.
  - data: silver_touchpoint: every touch with utm.*, click_ids (fbclid/gclid/ttclid/msclkid/gbraid/wbraid/dclid), referrer, landing_path, page_type, product/collection_handle, first/last flags, stitched_brain_id from connector_journey_stitch_map (D-5). silver_sessions: COUNT/MIN/MAX additive rollup. HONEST gap: only touches WITH brain_anon_id sessionize; NULL-anon dropped+counted.
- **silver_shipment + silver_shipment_event (logistics)** `[production]`
  - where: db/dbt/models/marts/silver_shipment_event.sql (1 row per brand_id+event_id) + silver_shipment.sql (latest per brand_id+order_id) from stg_shipment_events.
  - data: Multi-source: gokwik.awb_status.v1 + shiprocket.shipment_status.v1. source, order_id, awb_number_hash, status, terminal_class (rto|delivered|other|none via @brain/logistics-status authority), is_terminal, payment_method, pincode, courier, status_changed_at.
- **silver_checkout_signal (payments/checkout signals)** `[production]`
  - where: db/dbt/models/marts/silver_checkout_signal.sql (1 row per brand_id+event_id) from stg_checkout_signal_events.
  - data: Multi-source: gokwik.rto_predict.v1 (risk_flag high|medium|low|control|unknown) + shopflo.checkout_abandoned.v1 (total_price_minor, total_discount_minor, has_address). signal_type discriminant. Reserved seams for gokwik.checkout_abandoned/otp (partner-gated, not wired).
- **silver_marketing_spend** `[production]`
  - where: db/dbt/models/marts/silver_marketing_spend.sql (table) from ad_spend_ledger (PG billing.ad_spend_ledger via JDBC read-shim).
  - data: 1 row per (brand_id, spend_event_id): platform (meta|google_ads), level/level_id/parent_id, campaign_id/name, stat_date (click-date anchored), spend_minor, currency_code, impressions, clicks. NOTE: derived from a PG ledger, NOT from raw Iceberg Bronze.
- **Iceberg-landed derived ledgers (H2)** `[partial]`
  - where: brain_bronze.revenue_ledger + brain_bronze.attribution_credit, written by db/iceberg/spark/revenue_ledger_materialize.py + attribution_credit_materialize.py (idempotent MERGE).
  - data: Iceberg copies of PG money ledgers so gold_revenue_ledger / gold_marketing_attribution can serve from lakehouse. gold ledger_source flag default 'pg' (iceberg flip gated on a dbt-StarRocks incremental-CTAS-from-external-catalog bug — these marts must be 'table' to flip). Parity oracle: db/iceberg/spark/bronze_parity_check.py + db/iceberg/parity/ledger_bronze_parity.sh.
- **PG->Iceberg parity oracle & Bronze maintenance** `[production]`
  - where: db/iceberg/spark/bronze_parity_check.py, validate_bronze.py, bronze_maintenance.py (compaction/snapshot-expire).
  - data: Parity check on (brand_id,event_id) set; runtime gate referenced by _sources.yml. Maintenance job for Iceberg compaction + retention.

**Gaps:**
- Iceberg is the sole Bronze SoR for browse/order/shipment/checkout-signal lanes, but FOUR Silver inputs still read PG (not raw Bronze): silver_order_state/silver_customers (billing.realized_revenue_ledger + identity.customer), silver_marketing_spend (billing.ad_spend_ledger), and the stitch map. Per _sources.yml these are DERIVED PG tables by design, but it means order/revenue/spend canonical Silver does NOT yet flow from raw Iceberg Bronze — only journey/order-line/shipment/checkout-signal do.
- H2 lakehouse-served money marts (gold_revenue_ledger, gold_marketing_attribution) default ledger_source='pg'; the Iceberg flip is BLOCKED on a dbt-StarRocks incremental-CTAS-from-external-catalog bug (marts need to be 'table' not incremental).
- silver_product is derived from order LINES only — there is no product-catalog connector feed, so product attributes beyond what appears in order line_items are absent.
- Journey coverage is honestly partial: only touchpoint events carrying payload.properties.brain_anon_id can sessionize; NULL-anon rows are dropped (counted). In dev only a subset (noted 23/94) carried anon_id.
- silver_checkout_signal has reserved-but-unwired seams (gokwik.checkout_abandoned.v1, gokwik.otp_verification.v1) pending partner access.
- bronze_materialize.py PG install_token lookup is re-read per micro-batch but the dev-spike default checkpoint is local file:// (prod needs durable s3a:// checkpoint for exactly-once across restarts — noted in code).
- No silver_settlement mart (deferred); settlement.live.v1 is consumed only into the PG ledger via the settlement-ledger consumer group, not into a Silver entity.

## Feature layer & ML platform

_Maturity is honest-by-design: the codebase explicitly labels everything deterministic and seeds the ML registry with a rule-based scorer 'until a trained model lands'. The ML platform is a real, RLS-isolated, partitioned, eval-gated lifecycle SKELETON (registry + append-only prediction log + gated promotion + Models UI + serving route) — production-quality plumbing with no learned model flowing through it. The feature layer has TWO real substrates: (1) the dbt offline/PIT layer (feature_customer_daily -> gold_customer_scores), and (2) a separate TS Redis online store (@brain/feature-store) materialized from gold_customer_360. The online store's write path and freshness contract are production-grade, but the online READ/serving loop is not closed (no consumer calls .get()), so 'is there an online feature path?' = yes for materialization, no for online serving. The recommendation/decision foundation is the most mature AI-adjacent surface: 4 deterministic detectors, dedup+expire, confidence gating, append-only decision_log + recommendation_action ledger, outcome measurement, and a UI — fully deterministic, recommend-only, nothing auto-executed. Any downstream phase claiming trained models, online feature serving, or unified offline/online feature definitions would be ungrounded today._

- **feature_customer_daily (offline feature store / point-in-time history substrate)** `[production]`
  - where: db/dbt/models/marts/feature_customer_daily.sql (schema brain_feature); contract db/dbt/models/marts/_feature_history.yml
  - data: INCREMENTAL append-per-day snapshot keyed (brand_id, brain_id, snapshot_date). Columns: currency_code, lifetime_orders, lifetime_value_minor (bigint minor), days_since_last_order, customer_age_days, first_seen_at, last_seen_at, computed_at. Sourced from ref('silver_customers'). Same-day re-run idempotent (PK upsert on full grain), prior days preserved.
- **gold_customer_scores (deterministic RFM + churn-risk scoring — NOT ML)** `[production]`
  - where: db/dbt/models/marts/gold_customer_scores.sql (schema brain_gold)
  - data: 1 row per (brand_id, brain_id). recency_score/frequency_score/monetary_score (1-5 rule-based tiers), churn_risk band (high/medium/low) computed purely from days_since_last_order, scored_on, lifetime_orders, lifetime_value_minor. Reads latest snapshot from feature_customer_daily. Explicitly rule-based until a trained model replaces it on the same grain.
- **ml.model_registry (versioned model registry + gated lifecycle)** `[production]`
  - where: db/migrations/0083_ml_platform_foundation.sql; app: apps/core/src/modules/ml/internal/application/promote-model.ts, queries/list-models.ts
  - data: Columns model_id, brand_id, name, version, stage(training/staging/production/archived CHECK), framework(default 'deterministic'), feature_set jsonb, metrics jsonb, trained_at, promoted_at. Partial-unique 'one production per (brand,name)' (model_registry_one_production). RLS FORCE brand-isolated. SEEDED honestly: customer_churn_rfm v0-deterministic as production per active brand pointing at gold_customer_scores. promoteModel does atomic archive-then-promote in one RLS txn.
- **Eval gate (production-promotion baseline guard)** `[production]`
  - where: apps/core/src/modules/ml/internal/application/promote-model.ts (runEvalGate, EVAL_GATE_METRIC_FLOORS, DEFAULT_EVAL_BASELINES); test apps/core/src/modules/ml/tests/eval-gate.unit.test.ts
  - data: Blocks promotion to production unless metrics jsonb meets floors (auc>=0.5 etc.) + configurable baselines (EVAL_GATE_BASELINES_JSON env). framework='deterministic' models are EXEMPT (no learned metric). So in practice nothing is gated today because the only registered model is deterministic.
- **ml.prediction_log (append-only inference log)** `[production]`
  - where: db/migrations/0083_ml_platform_foundation.sql; written by apps/core/src/modules/ml/internal/application/serve-customer-score.ts
  - data: RANGE(created_at)-partitioned, PK (brand_id, prediction_id, created_at). Columns model_id, subject_type, subject_key, prediction jsonb, score double. brain_app has SELECT+INSERT only (append-only). Auto-maintained by public.maintain_time_partitions (0080). One row written per serveCustomerScore call.
- **serveCustomerScore (model-serving path)** `[production]`
  - where: apps/core/src/modules/ml/internal/application/serve-customer-score.ts; route GET /api/v1/ml/customer-score in apps/core/src/modules/frontend-api/internal/bff.routes.ts
  - data: Reads gold_customer_scores via metric-engine getCustomerScore (packages/metric-engine/src/customer-score.ts), resolves production model from ml.model_registry, logs a prediction_log row, returns {model, score}. Honest no_data (writes nothing). This is a precomputed-Gold read, NOT a live model inference — @effort deterministic.
- **@brain/feature-store — Redis ONLINE feature store + offline->online materializer** `[partial]`
  - where: packages/feature-store/src/index.ts (RedisOnlineStore, CUSTOMER_FEATURES, materializeCustomerFeatures); job apps/stream-worker/src/jobs/feature-materialization/run.ts
  - data: 3 DETERMINISTIC customer features: ltv_minor, purchase_probability (delivered/lifetime orders), rto_risk. Key feat:{brand_id}:{feature}:{entity_id}, 25h TTL, freshness sentinel + checkFeatureFreshness/FeatureStaleError SLO (26h). Materializer reads brain_gold.gold_customer_360 from StarRocks and writes Redis. Intended for Argo cron. WRITE path complete; NO consumer reads the online store yet (no .get() caller in recommendation/decision/serving).
- **Recommendation engine (deterministic detectors + decision_log + outcome measurement)** `[production]`
  - where: apps/core/src/modules/recommendation/internal/{application,domain}; tables db/migrations/0044_recommendation_decision_log.sql, 0045_recommendation_outcome.sql, 0082_recommendation_action_ledger.sql; job apps/core/src/jobs/recommendation-detectors.ts
  - data: 4 registered deterministic detectors (registry.ts): rto_risk, realization_gap, margin_erosion, scale_opportunity — all subject='brand', backed by SQL fns (rto_risk_signal_for_brand, realization_signal_for_brand, cm2_signal_for_brand). generateRecommendations upserts recommendation (dedup brand+detector+subject) + appends decision_log; expires when detector stops firing. confidence-gate.ts (Trusted/Estimated/Insufficient). measure-recommendation-outcomes.ts + record-recommendation-action.ts (append-only ai_config.recommendation_action, M7). Recommend-only, nothing auto-executed.
- **ML + Recommendations dashboard UI** `[production]`
  - where: apps/web/app/(dashboard)/ml/{page.tsx,ml-content.tsx}; apps/web/app/(dashboard)/recommendations/{page.tsx,recommendations-content.tsx}
  - data: Models UI lists ml.model_registry (via GET /api/v1/ml/models) and promotes (POST /api/v1/ml/models/:id/promote). Recommendations UI surfaces the detector recs.

**Gaps:**
- NO real/trained ML models exist. Every 'model', 'score', 'prediction' and 'feature' in the stack is DETERMINISTIC/rule-based. The only registry row is customer_churn_rfm v0-deterministic (framework='deterministic', eval-gate-exempt). framework, feature_set, metrics columns exist but no learned model populates them.
- No Python ML / training service exists. Only Python present is the dbt venv (.dbt-venv). No training, embeddings, BentoML/FastAPI/MLflow serving, drift monitoring, or retrain trigger code despite ml-lifecycle reference skill.
- Online feature path is WRITE-ONLY / half-wired. packages/feature-store + the stream-worker materializer write 3 deterministic features to Redis with TTL+freshness sentinel, but NOTHING reads the online store (no RedisOnlineStore.get() caller in recommendation, decision, or serving). serveCustomerScore reads Gold (StarRocks) directly, not the online store. So offline/online parity machinery exists but the online serving loop is not closed.
- Two parallel, unconnected feature definitions: feature_customer_daily/gold_customer_scores (dbt, brain_feature/brain_gold, from silver_customers) vs CUSTOMER_FEATURES (TS, Redis, from gold_customer_360). They compute different features (RFM/churn vs ltv/purchase_prob/rto) from different sources and are not unified into one definition.
- serveCustomerScore is not true inference — it serves a precomputed Gold score row and logs it as a 'prediction'. The train/serve loop the audit aimed to close is structurally present (registry + prediction_log) but only exercises a rule-based scorer.
- feature_customer_daily / gold_customer_scores populate only once orders carry a resolved brain_id (depends on C2 identity stitching) — per the contract yml, structurally complete but data-dependent.
- No 'decision' module directory in apps/core/src/modules — the decision layer is the decision_log audit table (audit schema, partitioned 0076) written by the recommendation engine, not a separate bounded context. Recommendations are advisory only; no action execution / Temporal-style decisioning.
- No model lineage to the actual deterministic compute beyond a metrics jsonb note pointing at source_mart='gold_customer_scores'; no automated promotion of trained models (no producer of training/staging rows).

## Identity graph, Customer 360 & journey/attribution

_Maturity is high for the DETERMINISTIC PG identity engine, journey/touchpoint reconstruction, and the 4-model attribution credit math + ledger writer/reconciler — all real, tested (live tests + e2e specs), RLS/brand-isolated, no-float money discipline. The headline correction for downstream phases: the identity GRAPH that actually resolves customers is PostgreSQL (migration 0017), not Neo4j. The Neo4j package is production-quality code but parked as an off-by-default, never-read projection. Journey channel attribution is a fixed deterministic CASE ladder (click-id→utm→referrer→direct), confidence is a frozen A/C/D grade, and multi-touch credit is integer largest-remainder apportionment — strictly deterministic, replay-safe, no ML anywhere in identity/journey/attribution today._

- **Identity resolution (deterministic union-find) — the REAL authoritative engine** `[production]`
  - where: apps/stream-worker/src/application/ResolveIdentityUseCase.ts + apps/stream-worker/src/domain/identity/IdentityResolver.ts + apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts; tables in db/migrations/0017_identity_graph.sql
  - data: Extracts email/$email, phone/phone_number/$phone, customer_id/storefront_customer_id, device_id, brain_anon_id/anon_id, plus connector pre_hashed_email/pre_hashed_phone from Bronze events. Per-brand salted SHA-256 (raw PII never stored except contact_pii vault). Outcomes minted/linked/merged/suppressed/skipped. brain_id is a randomUUID minted in Postgres; canonical=lowest UUID on merge; deterministic merge_id=sha256(brand‖canonical‖merged‖'v1-deterministic'). Strong ids (email/phone/storefront) are the only merge keys; device_id/anon_id are tier='medium' resolve-only (never merge); phone-guard threshold(10)/suppression-window(30d). NO probabilistic/ML merge (D-5).
- **Identity PG schema (the system-of-record graph)** `[production]`
  - where: db/migrations/0017_identity_graph.sql (+0037 contact_pii_ciphertext, 0038 erase_customer, 0039 identity_merge_admin, 0079 first_identified_at)
  - data: Tables: customer (brand_id,brain_id,lifecycle_state,consent flags), identity_link (hashed identifier_value, tier, is_active; unique-partial active-strong index), identity_merge_event (deterministic merge_id PK), brain_id_alias (read-time re-pointing/union-find live pointer), shared_utility_identifier (phone-guard), merge_review_queue (insert-only, M1 unworked), contact_pii (raw PII vault, elevated RLS app.role='send_service'), identity_audit (append-only). All ENABLE+FORCE RLS, brand-scoped, fail-closed two-arg GUC.
- **Neo4j identity graph (@brain/identity-graph)** `[stub]`
  - where: packages/identity-graph/src/index.ts; apps/stream-worker/src/application/Neo4jIdentityWriter.ts; wired in apps/stream-worker/src/main.ts (lines ~226-258)
  - data: Full Cypher engine: (:Identifier{brand_id,type,hash})-[:IDENTIFIES]->(:Customer{brand_id,brain_id}); bootstrap constraints, resolve() with mint/link/merge union-find, deterministicBrainId, lookupBrainId, purgeBrand. BUT it is NON-AUTHORITATIVE & DEFAULT-OFF: gated by env IDENTITY_NEO4J_DUAL_WRITE=true; Postgres is the declared SoR (ADR-0003); dual-write RETIRED; nothing in the app READS this graph; best-effort mirror, a Neo4j error never affects PG resolution. Its deterministicBrainId differs from PG's randomUUID mint, so the two are not value-identical.
- **Identity control-plane reads/admin (Customer-360 identity view, list, merge-admin, erase, PII vault)** `[production]`
  - where: apps/core/src/modules/identity/internal/application/queries/get-customer-360.ts + list-customers.ts; merge-admin.ts; erase-customer.ts; contact-pii-vault.service.ts; UI apps/web/app/(dashboard)/identity/{customers,customer-360,merge-review,pii-vault}/
  - data: getCustomer360(brandId,brainId) reads PG customer + identity_link (hash PREFIX only, 12 chars) + identity_merge_event → profile + linked identifiers + merge history. Manual merge-admin, GDPR erase-customer, KMS-backed PII vault. Real dashboard pages exist; e2e specs (customer-360.spec.ts, identity-compliance.spec.ts).
- **gold_customer_360 mart (analytics 360)** `[production]`
  - where: db/dbt/models/marts/gold_customer_360.sql; reader packages/metric-engine/src/customer-360.ts (getCustomer360Summary); core apps/core/src/modules/analytics/.../get-customer-360.ts; UI analytics/customer surfaces
  - data: 1 row per (brand_id,brain_id): lifetime_orders, lifetime_value_minor (BIGINT minor), currency_code, first_seen_at, first_identified_at, last_seen_at, delivered/rto/cancelled/refunded order counts, watermark. Incremental upsert on StarRocks PRIMARY. Joins silver_customers spine to a silver_order_state lifecycle rollup. ADDITIVE only — scores live elsewhere. Read solely via metric-engine withSilverBrand seam.
- **Customer scoring / segmentation / cohorts (deterministic, not ML)** `[production]`
  - where: db/dbt/models/marts/gold_customer_scores.sql (RFM+churn band), gold_customer_segments.sql, gold_cohorts.sql, feature_customer_daily.sql, silver_customers.sql
  - data: gold_customer_scores: deterministic rule-based RFM tiers + churn-risk band per (brand_id,brain_id) from latest feature_customer_daily snapshot (explicitly NOT ML — placeholder until models land). Segments/cohorts are deterministic labeling marts.
- **Journey reconstruction (sessionization + touchpoint timeline)** `[production]`
  - where: db/dbt/models/intermediate/int_touchpoint_sessionized.sql → db/dbt/models/marts/silver_touchpoint.sql; readers packages/metric-engine/src/journey-mix.ts; UI apps/web/app/(dashboard)/analytics/journey/
  - data: Per-(brand_id,brain_anon_id,touch_seq) touches. Server-side 30-min inactivity sessionization (session_seq, murmur_hash3_32 session_key), touch_seq + is_first/is_last flags, deterministic channel CASE ladder (fbclid→paid_meta; gclid/gbraid/wbraid/dclid→paid_google; ttclid→paid_tiktok; msclkid→paid_bing; utm.medium cpc/email/social/referral; referrer→referral; else direct), utm/click-id fields, landing_path/page_type/product_handle. Deterministic cart-stitch read-back via connector_journey_stitch_map → stitched_order_id/stitched_brain_id (NULL=un-stitched, honest). metric-engine emits computeFirstTouchMix, computeStitchHitRate, computeTouchpointTimeline. Replay-safe, NO money column, NO ML.
- **Attribution models (credit math) — pure deterministic** `[production]`
  - where: packages/metric-engine/src/attribution-models.ts (+ attribution-credit.ts, attribution-clawback.ts, attribution-confidence.ts, attribution-channel-roas.ts, attribution-campaign-roas.ts)
  - data: 4 models: first_touch, last_touch, linear, position_based (default). Integer 1e8-scale weights, largest-remainder closed-sum apportionment to BIGINT minor units (no float ever; Σcredit=realized exactly). Deterministic attribution_confidence grade strong/partial/weak (A=1.000/C=0.700/D=0.400) from stitch+channel-determinism. NO probabilistic/Markov/Shapley/ML models.
- **Attribution credit ledger (write + reconcile pipeline)** `[production]`
  - where: packages/attribution-writer/src/index.ts (AttributionCreditWriter writeCredit/writeClawback); apps/core/src/modules/attribution/internal/reconcile-attribution.ts; table db/migrations/0032_attribution_credit_ledger.sql; UI analytics/attribution + attribution-model-selector.tsx
  - data: reconcileAttribution loops ALL 4 models over realized_revenue_ledger finalizations (credit pass) + reversals rto/refund/chargeback/cancellation/concession (clawback, mirrors SAVED weights). Resolves journey via silver_touchpoint.stitched_brain_id; un-stitched/no-journey → unattributed (honest). Idempotent deterministic credit_ids, ON CONFLICT. PG is write SoR. Reconcile is invoked via Argo job / BFF route, NOT auto-triggered by finalization.
- **gold_marketing_attribution & gold_attribution_paths marts** `[partial]`
  - where: db/dbt/models/marts/gold_marketing_attribution.sql; gold_attribution_paths.sql; snap_attribution_credit.sql
  - data: gold_marketing_attribution: flat credit/clawback ledger (1 row per credit_id) served from lakehouse (var ledger_source default 'iceberg' from brain_bronze.attribution_credit, 'pg' escape). gold_attribution_paths: 1 row per converted journey (brand_id,brain_anon_id,stitched_order_id) with ordered channel_path string, touch_count, distinct_channel_count, first/last_touch_channel, path span — only stitched (converted) journeys. NOTE per the mart header these are largely DATA-STARVED (0 rows) today pending live ledger population.

**Gaps:**
- Neo4j identity graph is NOT in production use: it is a fully-coded but default-OFF, non-authoritative projection (env IDENTITY_NEO4J_DUAL_WRITE), explicitly RETIRED as a dual-write (ADR-0003). Nothing reads it. Postgres is the real identity graph/SoR. Claims that 'identity runs on Neo4j' are FALSE for the running system.
- DOC DRIFT: silver_customers.sql header still says brain_id is 'minted by the identity graph / @brain/identity-graph on Neo4j' — but the code (IdentityResolver) mints brain_id as a randomUUID in Postgres; Neo4j's deterministicBrainId is a different scheme and is not the source.
- Attribution path/credit marts (gold_attribution_paths, gold_marketing_attribution) are DATA-STARVED (0 rows) per their own headers until the live attribution ledger is populated; reconcileAttribution is not auto-triggered by finalization (manual/Argo).
- Identity resolution is DETERMINISTIC-ONLY by design — no probabilistic/ML stitching exists (D-5). merge_review_queue is insert-only/unworked (M1).
- Attribution models are the 4 deterministic position/linear/first/last only — no Markov, Shapley, or data-driven/ML attribution.
- Two distinct 'Customer 360' surfaces exist and should not be conflated: identity control-plane getCustomer360 (PG identity tables, hashed identifiers + merge history) vs analytics getCustomer360Summary (gold_customer_360 mart, LTV/orders/lifecycle).
- gold_customer_scores RFM/churn are deterministic rule-based placeholders, NOT predictive ML, despite living next to the ML platform.

## UI, API & monetization (apps/web dashboards/pages + apps/core API surface + billing/metering tables)

_Monetization is real and well-engineered but narrow: the entire revenue model is %-of-realized-GMV, implemented end-to-end (seal → inspectable bill → GST invoice → credit note) with strong integrity guarantees (immutable append-only snapshots, gapless GST numbering via SECURITY DEFINER fn, RLS ENABLE+FORCE on every billing table, banker's-rounding money math, drift reconciliation). The UI surface is broad: 28 dashboard pages across Overview/Analytics/Identity/Billing/Data/Settings, backed by ~85 BFF /api/v1 routes, all BFF-only with server-side brand RLS. The 'plan' and 'entitlements' words are present but neither is a SaaS subscription system — billing_plan is just a rate, entitlements is data-readiness feature-unlock. Everything claimed here was read directly: billing tables in db/migrations/0040-0046, billing module apps/core/src/modules/billing/, routes in bff.routes.ts (lines ~1865-2130), and the Billing UI in apps/web/app/(dashboard)/billing/billing-content.tsx. Sealing has no automated scheduler (verified — sealBillingPeriod has only the BFF caller). No Stripe/Razorpay/subscription/seat/usage-event tables exist (verified by grep over all migrations + billing module)."_

- **Dashboard pages (Next.js App Router)** `[production]`
  - where: apps/web/app/(dashboard)/ — 28 page.tsx files; nav defined in apps/web/app/(dashboard)/layout.tsx (lines 81-135)
  - data: Sections wired into the sidebar: Overview (/dashboard, /recommendations, /ml [Models], /ask [Ask Brain]); Analytics (/analytics/{revenue,orders,spend,settlements,cod-rto,order-status,logistics,behavior,funnel,abandoned-cart,engagement,journey,attribution,conversion-feedback}); Identity (/identity/{customers,customer-360,merge-review,pii-vault}); Monetization (/billing); Data (/settings/connectors,/data/health,/data/quality); Settings (/settings/pixel,/settings/members,/settings/consent,/settings). Also: /analytics/{margin,revenue,orders/[order_id]} and /analytics/cod-rto exist as pages; auth + onboarding route groups complete.
- **BFF API surface (single Fastify route module)** `[production]`
  - where: apps/core/src/modules/frontend-api/internal/bff.routes.ts — ~85 routes under /api/v1/*
  - data: Route families: /api/v1/analytics/* (~35 endpoints: executive-metrics, revenue/orders/ad-spend timeseries, attribution by-channel/campaign-roas/reconciliation, funnel, checkout-funnel, cohort-retention, contribution-margin, cod-rto, settlements, logistics, journey, etc.); /api/v1/dashboard/* (brand-summary, data-foundation-health, realized-revenue, onboarding-progress); /api/v1/billing/* (6 routes); /api/v1/identity/*, /api/v1/ml/* (models, customer-score, promote), /api/v1/recommendations/*, /api/v1/consent/*, /api/v1/feedback/capi/*, /api/v1/entitlements, /api/v1/costs, /api/v1/data-quality/summary; /api/v1/bff/* (session/auth/onboarding). BFF-only: all figures read server-side under session brand RLS.
- **GMV metering — sealed snapshot** `[production]`
  - where: migration db/migrations/0040_billing_meter_snapshot.sql (table gmv_meter_snapshot); apps/core/src/modules/billing/internal/application/seal-billing-period.ts; route POST /api/v1/billing/periods/seal + GET /api/v1/billing/periods
  - data: One immutable row per (brand_id, billing_period 'YYYY-MM'): metered_gmv_minor (bigint minor units) + currency_code, as_of_date, ledger_row_count, sealed_at. Metered via realized_gmv_for_period()/realized_gmv_as_of() seam over realized_revenue_ledger (realized GMV only, provisional excluded, floored at 0). Append-only by GRANT (SELECT+INSERT, no UPDATE/DELETE); ON CONFLICT DO NOTHING idempotent; RLS ENABLE+FORCE.
- **Billing plan / rate** `[production]`
  - where: migration db/migrations/0041_billing_plan_and_composition.sql (table billing_plan)
  - data: Per-brand row: rate_bps (basis points, 0-10000), effective_from. ONE plan per brand (PK brand_id). No plan row → app falls back to DEFAULT_RATE_BPS=100 (1.00%) with rate.source='default'. This is the ONLY 'plan' construct — a single GMV rate, NOT subscription tiers/seats/feature gates.
- **Inspectable bill (derivation + reconciliation)** `[production]`
  - where: apps/core/src/modules/billing/internal/application/queries/get-inspectable-bill.ts; route GET /api/v1/billing/bill; UI BillDetail in apps/web/app/(dashboard)/billing/billing-content.tsx; seam realized_gmv_composition_as_of()/realized_gmv_composition_for_period() (migrations 0041/0043)
  - data: fee = sealed basis × rate_bps, banker's rounding (@brain/money), rounding_adjustment_minor surfaced. Per-event_type composition lines that reconcile to the sealed basis; explicit drift/reconciles block when backdated rows land post-seal (bills on sealed figure).
- **GST invoice issuance + tax ledger** `[production]`
  - where: migrations db/migrations/0042_invoice_issuance.sql + db/migrations/0046_gst_split_and_credit_notes.sql (tables invoice, invoice_line, tax_ledger, invoice_number_counter; fn issue_invoice SECURITY DEFINER); apps/core/src/modules/billing/internal/application/{issue-invoice.ts,gst.ts,invoice-config.ts}; routes POST /api/v1/billing/invoice/issue + GET /api/v1/billing/invoice
  - data: Atomic gapless invoice_number per (legal_entity, FY); CGST/SGST (intra-state) vs IGST (inter-state) split by place_of_supply; SAC/HSN; immutable (brain_app SELECT-only, writes via definer fn); invoice tax JSONB + tax_ledger output rows. Idempotent per (brand_id, billing_period).
- **Credit notes** `[production]`
  - where: migration db/migrations/0046_gst_split_and_credit_notes.sql (tables credit_note, credit_note_number_counter; fn issue_credit_note); apps/core/src/modules/billing/internal/application/issue-credit-note.ts; route POST /api/v1/billing/invoice/credit-note; UI CreditNoteAction
  - data: Immutable, gapless-numbered own series, references corrected invoice, posts reversing (negative) tax_ledger rows; partial + multiple allowed capped at invoice total. UI does full-reversal-with-reason only.
- **Entitlements / progressive unlock** `[production]`
  - where: apps/core/src/modules/analytics/internal/application/entitlements.ts; route GET /api/v1/entitlements; apps/web/lib/hooks/use-entitlements.ts
  - data: Readiness-driven (data-foundation-tier + signals) eligibility per product center (identity/journey/attribution/decision) and per connector category. This is feature UNLOCK gating, NOT plan-based monetization entitlements — purely a function of data readiness, no billing/plan input.
- **Cost inputs / contribution margin (monetization-adjacent analytics)** `[production]`
  - where: migrations db/migrations/0055_cost_input.sql + db/migrations/0056_cm2_signal_for_brand.sql; route /api/v1/costs + /api/v1/analytics/contribution-margin; UI /analytics/margin
  - data: Per-brand cost inputs feeding CM2/contribution-margin analytics (brand-economics for the merchant), distinct from Brain's own billing of the merchant.

**Gaps:**
- NO subscription/seat/tier model: monetization is single-dimension %-of-realized-GMV only. billing_plan holds one rate_bps per brand; no plan tiers, no feature-gating-by-plan, no seat/user-count pricing, no platform-fee floors/caps (grep for subscription/seat/tier_limit/plan_tier returns nothing).
- NO generic usage-metering pipeline: no usage_event/meter ingestion table; metering = a single monthly GMV roll-up from the revenue ledger, not idempotent per-event usage records (contrast with billing-and-metering reference pattern).
- Metering/sealing is MANUAL only: sealBillingPeriod is invoked solely via POST /api/v1/billing/periods/seal from the Billing UI button ('Meter & seal'). No scheduled/cron/job-orchestration trigger seals periods automatically — no automated month-close.
- NO payment collection: no Stripe/Razorpay subscription or payment-gateway integration for charging brands; the system issues invoices but there is no payment capture, dunning, or payment-status tracking (invoice has no paid/payment_status field).
- NO meter↔invoice↔payment↔ledger reconciliation loop: bill-level reconciliation (sealed basis vs live composition drift) exists, but there is no payment-side reconciliation since payments are absent.
- Single-currency-per-brand assumption (M1): inspectable bill filters composition to the basis currency; multi-currency brands bill separately, not a unified invoice.
- Billing UI is functional but operator-grade: brand users self-seal/self-issue/self-credit-note from /billing — no separate Brain-internal admin/back-office billing console; plan rate (billing_plan) has no UI to set it (only DB), so all non-default rates are DB-seeded.
