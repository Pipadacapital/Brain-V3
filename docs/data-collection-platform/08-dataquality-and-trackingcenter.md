# 08 — Data Quality Platform (D8) & Tracking Center Product Experience (D9)

> Trust layer for Brain's AI-Native Commerce OS. Everything here exists to feed the **Decision Engine** with a **first-class confidence signal**: a metric whose inputs fail the gate is rendered *Estimated*, high-stakes recommendations are blocked, and the slice is excluded from model training (METRICS.md §Rules "70 line"). This is **not** a BI/observability product — it is the substrate that lets Brain say *"I trust this number this much, and here is why."*
>
> Grounding date: 2026-06-18. Read against `.engineering-os/knowledge-base/{METRICS.md,INVARIANTS.md,COMPLIANCE.md,HLD.md}`, `packages/contracts/src/dq/index.ts`, `packages/metric-engine/src/registry.ts`, the empty `apps/core/src/modules/data-quality` bounded context, and `docs/ui-data-analytics-plan.md` (the analytics UI just built).

**Hard-constraint posture for this cluster:** the DQ *execution engine*, the `dq_grade` store, and the four coverage metrics are **genuinely Missing** (canon-specified, zero code). The *seams to fill them* all already exist. **No new deployable, no new topic, no new RLS pattern, no second consent/identity authority.** Every recommendation below extends one of: the empty `data-quality` bounded context, `packages/contracts/src/dq`, the metric-engine registry, the stream-worker consumer pattern, the existing pixel/connector health surfaces, or the analytics BFF + UI.

---

# PART D8 — The Data Quality Platform (Trust Layer)

## D8.0 The trust model (how the nine signals compose)

Brain's trust layer has **two tiers** that must not be conflated:

1. **Coverage** = *how much of the funnel can we even see?* Four chain-stage rates — Collection → Identity → Journey → Attribution — each a percentage of the stage that survives into the next. Coverage answers "is the pipe wired up?"
2. **Quality** = *given what we see, how good is it?* Four dimensional checks — Freshness, Completeness, Consistency, Accuracy — already declared as categories in `packages/contracts/src/dq/index.ts` (Freshness/Completeness/SchemaValidity/Reconciliation).

The **Trust Score** is the composite that the Decision Engine consumes, and it is deliberately the sibling of the already-specified `brand_readiness_score` (METRICS.md row 31) — **not a duplicate**. `brand_readiness_score` answers "is this brand *set up* to be decisioned on" (sources connected, pixel healthy, consent configured); **Trust Score answers "is the data *flowing right now* trustworthy enough to act on."** They share inputs (`dq_grade`, `identity_match_rate`, `health_state`) but differ in purpose: readiness is an onboarding gate, trust is a live decision gate.

**Confidence linkage (the load-bearing rule):** the metric engine already stamps `cost_confidence` and `effective_confidence = min(cost_confidence, attribution_confidence)` (METRICS.md row 19, §Rules). D8 supplies the **third leg** the canon names but never builds: `dq_grade` (data-quality confidence). The end-state is:

```
effective_confidence = min(cost_confidence, attribution_confidence, dq_confidence)
```

where `dq_confidence` derives from the Trust Score's letter grade. The "70 line" (below C grade / `Insufficient`) is the kill-switch: numbers render *Estimated*, high-risk recommendations blocked.

> **Reject — do NOT widen `min()` without an ADR.** Adding a third leg to `effective_confidence` changes every CM2/attribution number the Decision Engine sees. This is the **single highest-risk decision** in this cluster (see D8.10). It must land behind a metric-registry version bump + parity-oracle fixture, never as a silent change.

---

## D8.1 Collection Coverage

| Field | Value |
|---|---|
| **Tag** | **Equivalent (signal)** + **Missing (metric)** |
| **Definition** | `(events_persisted_to_bronze / events_expected) × 100` per brand per window. "Expected" is the hard part — see calculation. |
| **Unit** | `NUMERIC(5,2)` percentage |
| **Business meaning** | "Is the pixel/connector actually sending us what the storefront generated?" A storefront doing 1,000 orders/day that yields 300 `order.placed` Bronze events has ~30% collection coverage — Brain is blind to 70% of revenue truth. |

**Calculation.** The numerator already exists: `events_captured_count` is a defined metric (METRICS.md row 24) counting raw events accepted into Bronze, by brand, by event_type, including quarantined. The **denominator** is the genuinely Missing piece — there is no ground-truth "expected" count. Two deterministic proxies (no ML):
- **Connector-anchored:** for order events, expected = Shopify/Razorpay connector's own order count for the window (we already pull `connector_sync_status` + the ledger). `collection_coverage_orders = bronze order events / connector order count`. This is a **reconciliation** check — exactly the `DqReconciliationCheckSchema` category already declared (`packages/contracts/src/dq/index.ts:58`).
- **Pixel-anchored (page/cart events):** expected = sessions × expected-events-per-session baseline (a registry constant, tier-0). Below baseline ⇒ pixel mis-fire / consent-blocked drop.

**Dependencies:** `bronze_events` (count), `connector_sync_status` + `realized_revenue_ledger` (order ground truth), `pixel_status` (is the pixel even live).

**Impact on confidence:** Collection Coverage is the **floor of the whole chain** — if you didn't collect it, no downstream stage can recover it. Below threshold it caps `dq_confidence` regardless of how clean the events that *did* arrive are.

| Sub-capability | Tag | Ref / seam |
|---|---|---|
| Numerator (`events_captured_count`) | **Present (defined)** | METRICS.md row 24 (defined; engine emitter to be wired) |
| Raw Bronze events to count | **Present** | `db/migrations/0016_bronze_events.sql` |
| Connector order ground-truth | **Present** | `connector_sync_status`, `realized_revenue_ledger` |
| Reconciliation check category | **Present (contract stub)** | `packages/contracts/src/dq/index.ts:58` `DqReconciliationCheckSchema` |
| Expected-count denominator + coverage % | **Missing** | extend `data-quality` module + new `dq_grade`/`dq_coverage` table |

---

## D8.2 Identity Match Rate

| Field | Value |
|---|---|
| **Tag** | **Present (defined in canon)** + **Missing (computable inputs)** |
| **Definition** | `(resolved_sessions_count / total_sessions_count) × 100`. A session is resolved if its `observed_brain_id` has ≥1 active strong-tier `identity_link` (`tier IN ('strong','strong_on_link')`). Bot sessions excluded from both legs. (METRICS.md row 23 — **already fully specified**.) |
| **Unit** | `NUMERIC(5,2)` percentage |
| **Business meaning** | "Of the visitors we saw, how many do we actually *know*?" Directly bounds attribution and CAC truth — an anonymous session can't be credited to a customer. |

**Calculation:** numerator and denominator both depend on `silver.behavior_event` (sessions) which **does not exist yet** (Journey gap, ground-map identity-journey). The identity graph half is **Present and live** (`identity_link` with active strong-tier partial unique index, `apps/stream-worker/src/domain/identity/IdentityResolver.ts`). So the metric is **definition-complete but not yet computable** until sessionization lands in stream-worker.

**Dependencies:** `silver.behavior_event` (Missing — gated on the Silver tier), `identity_link` (Present), the bot-filter flag (Missing — listed in HLD pipeline, unbuilt).

**Impact on confidence:** Identity Match Rate is a `brand_readiness_score` sub-score (`w4`, METRICS.md row 31) **already**. For Trust Score it is the Identity-stage coverage. Low match rate ⇒ attribution operating on mostly-anonymous traffic ⇒ `attribution_confidence` should be discounted (Brain is guessing who converted).

| Sub-capability | Tag | Ref |
|---|---|---|
| Metric definition | **Present** | METRICS.md row 23 |
| Identity graph + strong-tier links | **Present (live)** | `IdentityResolver.ts`, `db/migrations/0017_identity_graph.sql` |
| Session denominator (`silver.behavior_event`) | **Missing** | gated on Silver tier + sessionize step (HLD pipeline) |
| Bot-filter exclusion | **Missing** | stream-worker pipeline step (HLD, unbuilt) |

---

## D8.3 Journey Coverage

| Field | Value |
|---|---|
| **Tag** | **Missing** (Journey itself is absent — ground-map identity-journey) |
| **Definition** | `(converted_orders_with_reconstructable_journey / total_converted_orders) × 100`. A journey is reconstructable if the order's `brain_id` has ≥1 pre-purchase touchpoint (session/UTM/click-id) stitched to it. |
| **Unit** | `NUMERIC(5,2)` percentage |
| **Business meaning** | "When a sale lands, can we see the path that led to it?" Journey Coverage is the bridge metric: it is exactly the **cart-stitch close-rate** — what fraction of orders we recovered `brain_anon_id`/click-ids/UTMs for from `cart.attributes` (ground-map connectors-commerce). |

**Calculation:** numerator = orders whose `silver.order_state.stitched_anon_id IS NOT NULL` (those stitch columns are **Missing** — docs-08 §35, unbuilt). Denominator = finalized orders in the ledger (Present). This metric is the **direct output signal of the cart-stitch slice** — it cannot be computed before that slice ships, and once it does, it is nearly free.

**Dependencies:** cart-stitch parser + `silver.order_state` stitch columns (Missing), `realized_revenue_ledger` (Present, denominator).

**Impact on confidence:** Journey Coverage is the **gate on attribution itself** — Journey-before-Attribution is a Brain principle. Low journey coverage ⇒ attribution falling back to last-touch/platform-truth ⇒ lower `attribution_confidence`. This is the metric that quantifies the moat: deterministic journey recovery vs competitors' probabilistic stitching.

> **Reject:** do not build a Journey/sessions service or OLTP touchpoint table to source this (HLD.md:54/98 — Journey is a DERIVED Silver layer OWNED BY the attribution module, "never a service, deployable, or store"). Journey Coverage reads the Silver projection; it does not own journey state.

---

## D8.4 Attribution Coverage

| Field | Value |
|---|---|
| **Tag** | **Present (defined as `attribution_reconciliation_rate`)** |
| **Definition** | `(attributed_gmv_minor / realized_gmv_minor) × 100`. The unattributed residual (`realized − attributed`) is **always rendered alongside** — closed-sum invariant `Σ channel_contribution + unattributed = realized_revenue` (METRICS.md row 21 — **already fully specified**, parity-oracle enforced). |
| **Unit** | `NUMERIC(5,2)` percentage |
| **Business meaning** | "Of the revenue we know is real, how much can we assign a cause to?" This is the honesty metric — Brain never spreads the residual silently across channels (revenue-truth-over-platform-truth). |

**Calculation:** depends on `gold.attribution_credit_ledger` + `gold.realized_revenue_ledger`. The ledger half is **Present and mature**; the attribution module is an **empty stub** (`apps/core/src/modules/attribution` — `export{}`). So Attribution Coverage is **definition-complete, denominator-live, numerator-pending** on the attribution build.

**Impact on confidence:** this metric IS `attribution_confidence`'s observable surface. The closed-sum parity oracle is already CI-blocking (METRICS.md row 21) — so when attribution lands, this coverage number is trustworthy by construction.

| Sub-capability | Tag | Ref |
|---|---|---|
| Metric definition + closed-sum invariant | **Present** | METRICS.md row 21 |
| `realized_revenue_ledger` (denominator) | **Present (live)** | `db/migrations/0018_realized_revenue_ledger.sql` |
| `attribution_credit_ledger` (numerator) | **Missing** | `apps/core/src/modules/attribution` is `export{}` stub |

---

## D8.5 Freshness

| Field | Value |
|---|---|
| **Tag** | **Equivalent (contract stub)** + **Missing (runtime)** |
| **Definition** | Data arrived within the SLA window. `DqFreshnessCheckSchema` already declares it: `{table, max_age_minutes, timestamp_column='ingest_at'}` (`packages/contracts/src/dq/index.ts:17`). Check = `now() − max(timestamp_column) ≤ max_age_minutes`. |
| **Unit** | boolean pass/fail + lag minutes; rolled up to a per-window % |
| **Business meaning** | "Is the data current, or am I deciding on yesterday's truth?" A 6-hour-stale ledger means provisional/realized revenue is understated — Brain must label, not pretend. |

**Calculation:** per-table max-timestamp vs SLA. Bronze freshness = `now() − max(bronze_events.received_at)`. Ledger freshness = lag of latest `occurred_at`. Connector freshness = `connector_sync_status.last_synced_at` age. The **contract exists** (`DqFreshnessCheckSchema`); the **runtime that executes it does not** ("No live DQ logic ships in Sprint 0" — same file header).

**Dependencies:** `bronze_events.received_at`, `connector_sync_status.last_synced_at`, ledger `occurred_at` — all **Present**.

**Impact on confidence:** stale inputs ⇒ metric marked *Estimated* (METRICS.md §Rules quality-gate). Freshness is a **hard fail-closed** dimension: a missing/stale FX rate already "fails closed (no computation proceeds)" (METRICS.md §Rules) — Freshness generalizes that posture to all inputs.

---

## D8.6 Completeness

| Field | Value |
|---|---|
| **Tag** | **Equivalent (contract stub)** + **Missing (runtime)** |
| **Definition** | Required fields populated. `DqCompletenessCheckSchema` declares it: `{table, required_columns[], max_null_rate=0}` (`packages/contracts/src/dq/index.ts:31`). |
| **Unit** | per-column null rate (0–1); rolled to a % |
| **Business meaning** | "Are the fields I need to compute actually there?" An order event with no `currency_code` or no `amount_minor` can't enter the ledger; a session with no UTM can't be attributed. |

**Calculation:** null-rate over required columns per table. Money completeness is non-negotiable (`amount_minor` + `currency_code` both present — I-S07). Identity completeness = fraction of events carrying ≥1 strong identifier. **Contract present, runtime Missing.**

**Dependencies:** all Bronze/ledger/identity tables — **Present**. The check runner — **Missing**.

**Impact on confidence:** incomplete required fields ⇒ row excluded or metric discounted. Completeness on identifiers directly feeds Identity Match Rate.

---

## D8.7 Consistency

| Field | Value |
|---|---|
| **Tag** | **Equivalent (maps to SchemaValidity + Reconciliation)** + **Missing (cross-store runtime)** |
| **Definition** | Two forms: (a) **schema consistency** — payload matches the registered Avro schema (`DqSchemaValidityCheckSchema`, `:44`, FULL_TRANSITIVE already enforced at the registry); (b) **cross-store consistency** — aggregate counts agree across stores (`DqReconciliationCheckSchema`, `:58` — Bronze vs StarRocks row delta). |
| **Unit** | schema: valid/invalid %; reconciliation: row delta (target 0, ±2–3% tolerance for connector-vs-ledger reconciliation per METRICS.md §ASSUMPTION) |
| **Business meaning** | "Do my stores agree with each other and with the contract?" The two-envelope divergence (Zod `event_name`/ISO vs Avro `event_type`/millis — ground-map collection) is a live consistency risk this check would catch. |

**Calculation:** schema validity = sample N events off the topic, validate against the Apicurio subject (`@brain/events` `validateSchemaCompatibility` is **Present** — `packages/events/src/index.ts`). Reconciliation = Bronze aggregate vs StarRocks aggregate (StarRocks is **Missing** — M1 is Bronze-only, so cross-store reconciliation is **premature** until the Silver/Gold tier lands; only Bronze-vs-connector reconciliation is runnable today).

**Impact on confidence:** a reconciliation breach >±5% is "stop-and-fix" (METRICS.md §ASSUMPTION) — it hard-blocks, because if Bronze and the marts disagree, no metric is trustworthy.

---

## D8.8 Accuracy

| Field | Value |
|---|---|
| **Tag** | **Equivalent (the parity oracle IS accuracy)** + **Missing (DQ-surfaced)** |
| **Definition** | Computed values match an independent recomputation. This is **already the parity oracle** (METRICS.md §Rules: "TS engine vs independent SQL recompute on the same ledger snapshot → exact integer equality"). Accuracy at the DQ layer = surfacing the oracle's pass/fail + the reconciliation tolerance as a trust signal, not re-implementing it. |
| **Unit** | exact-equality pass/fail (money, tolerance 0); reconciliation %-delta |
| **Business meaning** | "Is the number *right*?" Distinct from Freshness (is it current) and Completeness (is it there). |

**Calculation:** the parity oracle is **Present and CI-blocking** (`packages/metric-engine` golden fixtures, METRICS.md row 16/§Rules). Accuracy as a DQ dimension = lifting that pass/fail into the live `dq_grade` so a brand-period whose oracle drifted is auto-marked untrusted. **No new oracle** — that would duplicate the metric-engine's sole-truth role (Reject).

**Impact on confidence:** Accuracy is the hardest gate — a money metric that fails exact-integer parity is never shown as authoritative, full stop.

---

## D8.9 Trust Score (the composite)

| Field | Value |
|---|---|
| **Tag** | **Missing** (composite + `dq_grade` store unbuilt; pattern mirrors `brand_readiness_score`) |
| **Definition** | A weighted composite letter grade per brand-period: `TrustScore = Σ(w_i × subscore_i)` over {Collection Coverage, Identity Match Rate, Journey Coverage, Attribution Coverage, Freshness, Completeness, Consistency, Accuracy}, each sub-score ∈ [0,1]. Mapped to a letter grade (A/B/C/D/F) with the **"70 line"** at the C boundary (METRICS.md §Rules). |
| **Unit** | `NUMERIC(4,3)` ∈ [0,1] + a letter grade enum (matches `cost_confidence` grade vocabulary: `Trusted`/`Estimated`/`Insufficient`) |
| **Business meaning** | The **one number the Decision Engine reads** to decide whether to act, estimate, or stay silent. |

**Calculation:** registry-defined weights (tier-0 deterministic, mirroring `brand_readiness_score`'s `w1..w5` pattern, METRICS.md row 31). Accuracy and Freshness are **fail-closed gates** (a hard F on either caps the whole score below the 70 line regardless of the weighted sum) — coverage dimensions are weighted, quality dimensions can veto.

**Impact on confidence — the wiring:**
```
dq_confidence            = grade(TrustScore)          # Trusted | Estimated | Insufficient
effective_confidence     = min(cost_confidence, attribution_confidence, dq_confidence)
```
Below the 70 line: render *Estimated*, block high-risk recommendations, exclude from training, suspend the CM2 affordability cap for billing (METRICS.md §Rules).

**Build seam (exact):** new additive migration `db/migrations/00NN_dq_grade.sql` creating:
- `dq_grade(brand_id, dimension, period, subscore NUMERIC, grade TEXT, computed_at)` — **reuse the NN-1 two-arg fail-closed RLS template verbatim** (the locked pattern, ground-map quality-db-security; a one-arg form or new GUC is rejected by construction). brain_app SELECT+INSERT only, append-only-by-GRANT (mirror `realized_revenue_ledger`).
- Register two new metric IDs in `packages/metric-engine/src/registry.ts` (`trust_score`, `dq_grade`) as new keys — **never mutate** existing keys; the registry version-bump discipline is enforced (`registry.ts:8`).
- Add the four coverage metrics (`collection_coverage`, `journey_coverage` + already-defined `identity_match_rate`, `attribution_reconciliation_rate`) to METRICS.md with parity fixtures.

---

## D8.10 D8 build plan — seams, not deployables

| Capability | Tag | Exact seam to extend (NO new deployable) |
|---|---|---|
| DQ check **execution runtime** | **Missing** | stream-worker **consumer/job pattern** (same as `phase-guard-reeval.ts`, `revenue-finalization.ts`) running the `DqCheck` contracts on a schedule. NOT a new app (ground-map quality-db-security Reject). |
| DQ check **contracts** | **Present (stub)** | `packages/contracts/src/dq/index.ts` — already has all four categories; extend with the coverage checks. |
| `dq_grade` store | **Missing** | new additive migration, NN-1 RLS template verbatim, append-only-by-GRANT. |
| Trust Score + coverage metrics | **Missing** | `packages/metric-engine/src/registry.ts` new keys + METRICS.md rows + parity fixtures. |
| `data-quality` bounded context | **Equivalent (empty shell)** | `apps/core/src/modules/data-quality/index.ts` (`export{}`) — fill it; expose read queries for the Tracking Center BFF. DDD: `domain/quality/`, `application/queries/`, no logic in routes. |
| Confidence wiring (`min()` 3rd leg) | **Missing** | metric-engine `effective_confidence` computation — **behind a registry version bump + parity fixture** (highest-risk; see below). |
| Parity oracle (Accuracy) | **Present** | `packages/metric-engine` golden fixtures — surface, don't rebuild. |
| Schema-validity check | **Present (capability)** | `@brain/events` `validateSchemaCompatibility` (`packages/events/src/index.ts`) — call it from the runtime. |

### Highest-risk decision (D8)
**Widening `effective_confidence = min(cost_confidence, attribution_confidence)` to include `dq_confidence`.** This single change re-grades **every** CM2, CAC, and attribution number the Decision Engine consumes — a brand that was "Trusted" can drop to "Estimated" the moment DQ grading goes live, silently suppressing recommendations and changing billing's affordability cap. It must ship as a **metric-registry version bump** (new key, never a mutation — `registry.ts:8`) gated by a **parity-oracle fixture** that proves the new `min()` is correct on golden data, and it must be **dark-launched** (computed and logged but not enforced) for at least one billing period before it gates anything. Getting this wrong doesn't show a wrong number — it makes Brain go *quiet* on revenue it should be acting on, which is invisible until a brand asks why Brain stopped recommending.

> **What I rejected:** a standalone DQ service/deployable (ground-map Reject — drift); a second confidence model parallel to `effective_confidence` (Reject — one canonical confidence); re-implementing accuracy outside the parity oracle (Reject — duplicates the metric-engine SoR); cross-store Bronze↔StarRocks reconciliation runtime today (premature — StarRocks/Silver not in migrations yet); a new RLS pattern for `dq_grade` (Reject — NN-1 two-arg template is locked).

---

# PART D9 — Tracking Center Product Experience

> One product surface that makes the entire collection→confidence chain **legible and fixable** to a non-technical brand operator. The competitive thesis: Triple Whale / Northbeam show *a pixel-health dot*; Brain shows *the whole trust chain with a Trust Score and a one-click fix path*, because Brain owns the deterministic ledger that lets it say "you're missing 12% of orders and here is the connector that's behind."

## D9.0 Where it lives (no drift)

The Tracking Center is a **new sidebar section in the existing `apps/web` Next.js app**, reading **only** through the existing **BFF → metric-engine sole-read-path** (ADR-002, `bff.routes.ts`). It is the build-out of the `DATA → Data Health` node the analytics UI plan already reserved as "[phased]" (`docs/ui-data-analytics-plan.md` §3, §5 row "Data Health / DQ → phase later"). **No new app, no new edge.** Charts reuse the shadcn/Recharts primitive the analytics plan adopted (§2).

```
DATA
  └ Connectors          ← Present (analytics plan Phase 3)
  └ Tracking Center     ← NEW: the D9 surface, fills the reserved "Data Health" node
        Setup & Install · Health (Tracking/Connector/Identity/Journey) ·
        Coverage & Trust · Event Explorer · Diagnostics & Resolution
```

## D9.1 Capability-by-capability

| # | Capability | Tag | Seam / file ref |
|---|---|---|---|
| 1 | **Setup wizard** | **Present** | `apps/web/components/pixel/pixel-wizard.tsx` + onboarding-steps BFF (`bff.routes.ts:809` — the 5-step checklist incl. `pixel_installed`). Extend the wizard into a multi-source flow; reuse the existing step contract. |
| 2 | **Installation (pixel snippet)** | **Present** | `pixelRoutes.ts` GET `/api/v1/pixel/installation` (idempotent get-or-create snippet + `install_token`). Note: `install_token` is a **public** id (0007) — Reject any secret-handling around it. |
| 3 | **Verification (real presence check)** | **Present** | `pixelRoutes.ts` POST `/api/v1/pixel/verify` — **real HTTP HEAD/GET** against the storefront, not simulated; emits `pixel.verified`. |
| 4 | **Tracking health** | **Present** | `pixel_status` 4-state (`connected`/`syncing`/`waiting_for_data`/`error`, `0007_pixel.sql:48`) surfaced via `bff.routes.ts:727`. Status shown icon+label, **never color-only** (accessibility bar, analytics plan §7). |
| 5 | **Connector health** | **Present** | `connector_instance.health_state` (7-state) + `safety_rating` (`0021_connector_health.sql`); dispatch logic `connector/catalog/healthSafety.ts`. Surface the 7-state timeline. |
| 6 | **Identity health** | **Equivalent → Missing surface** | identity graph is live (`IdentityResolver.ts`); the *surface* (match-rate, merge-review-queue depth, phone-guard suppressions) needs the BFF read + Identity Match Rate metric (D8.2, gated on sessions). |
| 7 | **Journey health** | **Missing** | gated on cart-stitch + Silver (D8.3). Shows Journey Coverage + stitch close-rate once those land. Honest empty state until then (analytics plan §7 "never a fabricated 0"). |
| 8 | **Data-quality + coverage dashboards** | **Missing** | reads `dq_grade` + Trust Score (D8.9) via the filled `data-quality` module → BFF. The four coverage rates as a **funnel**: Collection → Identity → Journey → Attribution, each stage's % shown as the drop-off. |
| 9 | **Event Explorer** | **Raw-Only → new read surface** | events land raw in `bronze_events` (`0016`). Explorer = a **brand-scoped read** (RLS-enforced, `brain_app`) over Bronze: recent events, by `event_type`, with the quarantine/DLQ count broken out (`events_captured_count` reports quarantine separately, METRICS.md row 24). NOT a new store — a read view. |
| 10 | **Diagnostics center** | **Missing** | composes existing signals: pixel `last_error` (`0007:51`), connector `health_state`+`safety_rating`, DLQ depth (`dev.collector.event.v1.dlq`), freshness lag, failed DQ checks. Each diagnostic carries a **deterministic cause + fix** (tier-0, no model). |
| 11 | **Failure resolution** | **Missing** | the differentiator: each diagnostic maps to a **one-click or guided fix** (re-verify pixel → existing verify endpoint; connector behind → existing re-pull job; schema drift → flagged event_type). Reuses existing verify/re-pull seams; adds **no action engine** (Reject — order-recovery/campaign actions are Decision-Engine concerns, not collection). |
| 12 | **Why it's a competitive advantage** | n/a | see D9.3 |

## D9.2 The diagnostics → resolution model (the moat surface)

Each diagnostic is a deterministic rule over signals Brain **already owns** — no model, tier-0:

| Symptom (signal) | Deterministic diagnosis | Resolution (existing seam) |
|---|---|---|
| `pixel_status='error'` + `last_error` | snippet missing / mis-placed | "Re-verify" → POST `/api/v1/pixel/verify` (Present) |
| Collection Coverage < threshold (D8.1) | pixel firing but dropping events / consent-blocked | guided: check consent config, snippet placement |
| `connector_instance.health_state` degraded + freshness lag | connector behind / token expired | "Re-pull" → existing repull job (`shopify-repull/run.ts`); re-auth via existing OAuth |
| Schema-validity fail (D8.7) | event_type drifted from Avro subject | flag the offending `event_type`; FULL_TRANSITIVE blocks the break |
| DLQ depth rising | poisoned messages | surface forensic headers (already preserved, `DlqProducer.ts`); no data lost (accept-before-validate) |
| Reconciliation delta >±5% | Bronze vs ledger disagree | "stop-and-fix" banner (METRICS.md §ASSUMPTION); blocks trust |

This is the product expression of **Accept-Before-Validate**: because no event is ever lost (it's in the spool/Bronze/DLQ), every failure is *diagnosable and replayable* — Brain can always tell the brand exactly what's wrong and prove nothing was dropped.

## D9.3 Why this is a competitive advantage (benchmarked)

I benchmarked against the public patterns of Triple Whale, Northbeam, Elevar, and Littledata (server-side GTM). What they ship:
- **Elevar** ships a genuinely strong *Data Layer* + tag-health monitor and a "tracking accuracy" reconciliation against Shopify orders — the closest competitor to Collection Coverage. But it stops at *tag health*; it has no identity/journey/attribution coverage chain and no single Trust Score feeding a decision engine.
- **Triple Whale / Northbeam** surface a pixel-connected indicator and attribution coverage, but treat data quality as an *ops dashboard*, not a *first-class confidence input* — their attribution numbers don't visibly downgrade when collection is poor.
- **Littledata** does server-side accuracy reconciliation well but is a *pipe*, not a trust layer.

**Brain's structural edge (each grounded in something already built):**
1. **It owns the deterministic revenue ledger** (`realized_revenue_ledger`), so Collection/Journey/Attribution Coverage are measured against *revenue truth*, not platform-reported counts — competitors reconcile against the same ad platforms they're auditing.
2. **One Trust Score gates the Decision Engine.** Coverage isn't a vanity dashboard; below the 70 line Brain *visibly goes quiet* and tells the brand why — no competitor closes that loop because none has a deterministic decision engine downstream.
3. **Accept-Before-Validate means every failure is provable and replayable** — the diagnostics center can guarantee "nothing was lost, here's the exact fix," which a lossy edge cannot.
4. **Confidence is a first-class output** (the `min()` wiring), so a brand sees *"Estimated — Identity Match Rate 41%, below threshold"* on the actual number, not buried in a settings page.

**Sources:**
- [Elevar — Server-Side Tracking & Data Layer](https://www.getelevar.com/)
- [Littledata — Server-side tracking accuracy](https://www.littledata.io/)
- [Triple Whale — Data & attribution](https://www.triplewhale.com/)
- [Northbeam — Measurement](https://www.northbeam.io/)

---

## D9.4 D9 build plan — seams

| Capability | Seam (NO new deployable) |
|---|---|
| Tracking Center pages | new sidebar section in `apps/web` (`DATA → Tracking Center`), fills the reserved "Data Health" node (analytics plan §3). |
| All reads | existing BFF → metric-engine sole-read-path (`bff.routes.ts`); RLS brand-scoped, verified under `brain_app`. |
| Health surfaces | already-Present `pixel_status` / `connector_instance.health_state` / verify endpoint — surface, don't rebuild. |
| Coverage/Trust dashboard | reads `dq_grade` (D8) via the filled `data-quality` module. |
| Event Explorer | new brand-scoped read view over `bronze_events` (no new store). |
| Diagnostics + resolution | deterministic rules composing existing signals → existing verify/repull fix seams. |
| Charts | shadcn/Recharts primitive (analytics plan §2). |

---

# 10-Line Summary

1. **D8/D9 are mostly Missing-by-design but Present-by-seam:** the security/isolation/ledger substrate is mature; the DQ *execution engine*, `dq_grade` store, Trust Score, and coverage metrics are canon-specified with zero code.
2. **Net-new (Missing):** a **DQ check-execution runtime** (stream-worker job pattern, not a new app) running the four already-declared `DqCheck` contracts.
3. **Net-new:** a **`dq_grade` store** (new additive migration, NN-1 two-arg RLS template verbatim, append-only-by-GRANT).
4. **Net-new:** **Collection Coverage** + **Journey Coverage** metrics (Identity Match Rate and Attribution Coverage are already *defined* in METRICS.md; Journey/Identity are gated on the Silver tier + cart-stitch).
5. **Net-new:** the **Trust Score** composite (sibling of, not duplicate of, `brand_readiness_score`) + its mapping to a letter grade at the "70 line."
6. **Net-new:** wiring **`dq_confidence` into `effective_confidence = min(cost, attribution, dq)`** — the third leg the canon names but never built.
7. **Net-new (D9):** **Event Explorer** (read view over Bronze), **Diagnostics center**, and **deterministic failure-resolution** that reuses existing verify/repull seams — no action engine.
8. **Everything else is Present** (pixel install/verify/health, connector 7-state health, parity oracle = Accuracy, schema-validity capability) — surface it, don't rebuild it.
9. **Rejected:** standalone DQ deployable, second confidence model, re-implemented oracle, new RLS pattern, Journey/sessions service, order-recovery actions, cross-store reconciliation runtime (StarRocks not yet in migrations).
10. **Single highest-risk decision:** widening `effective_confidence` to include `dq_confidence` — it silently re-grades every CM2/CAC/attribution number and can make Brain *go quiet* on real revenue; must ship as a registry version-bump + parity fixture, **dark-launched** for one billing period before it gates anything.
