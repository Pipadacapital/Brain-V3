# THE MOAT — Brain's compounding asset

> Source of truth for what Brain's durability rests on. The OS treats this as a high-stakes trigger
> surface: any requirement that would weaken, bypass, or degrade what is described here routes to
> the Engineering Advisor and is escalation-eligible before implementation begins.
>
> Sources: BRD §20 (the five wedge strengths); BRD §10 (measurement platform); BRD §16
> (pricing); doc 12 §1 (engineering principles); METRICS.md (parity oracle, `decision_log`).

---

## What compounds

The brand-owned, continuously reconciling **realized-revenue + True-CM2 truth layer** — built on an
open Iceberg lakehouse — combined with an accumulating **Decision Log** (every recommendation,
every brand response, every measured outcome) that sharpens subsequent decisions.

Concretely: every day a brand runs on Brain, the following accumulates:

1. A richer, more accurate realized-revenue ledger (more settled COD cycles, more RTO outcomes
   finalized, more settlement data reconciled with Razorpay).
2. A deeper attribution history (more finalized-weight credit rows, more clawback events, a more
   representative unattributed residual across channels).
3. A longer Decision Log: `detector condition → brand action → measured outcome` tuples that make
   the next recommendation both more precise and more credible.
4. A maturing cost-confidence score (more per-SKU COGS data approaches `Trusted`, which unlocks
   the CM2 billing cap and higher-confidence recommendations).
5. A growing first-party identity graph (more `strong`-tier identity links, higher
   `identity_match_rate`, less of the denominator falling into the anonymous bucket).

None of this is replicable by a competitor on day one. It is not proprietary data in the
traditional sense — the brand owns it on an open format (Iceberg). What compounds is the
**calibration** of Brain's numbers against that specific brand's realized reality.

---

## Why it is defensible

**1. Realized-revenue CM2 as the headline number** (not ROAS, not placed revenue).
Brain bills on money that hit the bank, and every number on the dashboard reflects the same
definition. The ledger is append-only and hash-chained — the realized-revenue figure is not a
dashboard calculation but a durable, auditable sum over finalized signed rows. Competitors who
show placed/gross revenue require the brand to mentally discount for RTO/refund; Brain's number
already is the net.

**2. Realized-time attribution with proportional clawback**, keyed to India's COD/RTO reality.
Credit moves as revenue moves: a COD order that RTOs within 25 days triggers proportional
negative rows using the saved `weight_fraction` from the original credit — so the channel's
attribution falls with the revenue, not just with a blanket "return rate" adjustment applied
post-hoc. No competitor has implemented this in the India COD context. Triple Whale's "Total
Impact" credits at conversion with no clawback.

**3. Honest-when-degraded confidence** — the 70 line, `min(cost_confidence, attribution_confidence)`,
and the always-visible unattributed bucket.
Brain surfaces the confidence of every number and blocks high-risk recommendations when below
the 70 line (`effective_confidence < C grade / Insufficient`). The unattributed residual
(`realized_gmv − attributed_gmv`) is always rendered — never silently spread across channels.
This is more honest than any competitor's calibration framing. Brands that have been burned by
platform ROAS inflation trust Brain precisely because it volunteers the limits of its own
certainty.

**4. Brand-owned open lakehouse** (Iceberg on S3 + Glue Data Catalog, per-brand prefix).
No lock-in: the brand can run Athena/Trino/Spark directly on its own Bronze tables; the
full-brand export is raw + normalized + Decision Log in open formats. This is the inverse of the
Triple Whale closed ecosystem. An agency operating multiple brands under Brain has an
agency-safety guarantee (isolation is structural — one brand can never see another's data) while
retaining ownership of the underlying data asset.

**5. %-of-realized-GMV pricing with a CM2 affordability cap.**
Brain's fee aligns its incentive with the brand's actual profit: Brain makes more only when the
brand realizes more revenue and more margin. The CM2 cap (`fee ≤ cap% × CM2`, active only when
cost data is Trusted) means Brain cannot extract a fee that exceeds an affordable share of the
brand's contribution margin. This creates a structural commercial trust that a per-seat or
per-MAU pricing model cannot replicate.

**The compound effect:** each of the five wedge strengths feeds the others. More accurate
attribution sharpens recommendations; acted recommendations generate Decision Log entries; Decision
Log maturity makes future recommendations more credible; higher credibility → more recommendations
acted on → more revenue recovered and CM2 protected → a higher `recovered_cm2_to_fee_ratio`
(the value-proof metric) → stronger commercial retention → more brands → a larger design-partner
and outcome dataset. The moat is the loop, not any single feature.

---

## How the OS protects it

**It is a trigger surface.** Any requirement touching the following is routed to high-stakes
rigor (Engineering Advisor intake + escalation-eligible to Stakeholder):

- The realized-revenue ledger schema or its finalization logic.
- The attribution credit/clawback model (`weight_fraction` semantics, clawback triggers).
- The parity oracle (the "same finalized number everywhere" guarantee; METRICS.md Rules).
- The confidence model (`effective_confidence = min(cost_confidence, attribution_confidence)`,
  the 70 line, the always-visible unattributed bucket).
- The Decision Log schema, its append-only invariant, or its binding to `recommendation_outcome`.
- The billing meter (fee formula, the CM2 cap logic, the `Trusted` gate for cap applicability).
- The Iceberg Bronze layer's immutability, open format, or per-brand S3 prefix.
- The open-export path (full-brand export in open formats — the anti-lock-in guarantee).

**The escalation rubric flags anything that would:**
- Weaken measurement honesty (e.g. a proposal to blend provisional and finalized revenue in a
  headline metric, or to hide the unattributed bucket).
- Bypass the parity oracle (e.g. a dashboard that computes a metric independently of the metric
  engine).
- Break the attribution closed-sum invariant (`Σ channel_contribution + unattributed = realized`).
- Change the pricing model's realized-revenue basis or remove the CM2 affordability cap.
- Convert the Iceberg lakehouse to a proprietary closed format.

**Product-specific guardrails:**
- The LLM narrates the Decision Log and metric outputs; it may not alter, re-derive, or replace
  them (I-S08).
- The billing meter reads only finalized ledger rows; provisional/settling rows never enter the
  fee computation (METRICS.md Rules — finalized-only for decisions and billing).
- The unattributed residual is a first-class column in every attribution-bearing mart — it is never
  a nullable or optional field.
- Below the 70 line (`effective_confidence < C`), Brain explicitly labels numbers "Estimated" and
  blocks high-risk recommendations. A requirement to suppress these labels or lower the threshold
  without a full confidence-model review is a Challenge-Back.

> ASSUMPTION: The Decision Log's compound value (condition → action → outcome learning loop) is
> asserted here as a moat component based on BRD §20 and doc 09 (decision engine). The actual
> compounding rate depends on brand recommendation-acceptance rate and the horizon at which outcomes
> are measurable. The moat is real but its speed of compounding is an empirical question; the first
> quantitative evidence should appear in the M4 "Beta" cohort outcome data (W17–20, doc 11 §8).
