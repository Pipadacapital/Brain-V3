<!-- SPEC: 0.4 -->
# AMD-17 — CM1/CM2/CM3 naming collision (C.3)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** Wave C (C.3 gold_order_economics)

## Conflicting spec text
> §C.3 "CM1 = net revenue − COGS; CM2 = CM1 − shipping(fwd+rev) − packaging − payment/platform fees; CM3 = CM2 − allocated marketing spend."

## Ground truth (delta-plan evidence)
The live `gold_contribution_margin` (+ its served TS twin `contribution-margin.ts` in metric-engine) uses shifted numbering: **live CM1 = spec CM2; live CM2 = spec CM3**. These are SERVED metrics — silently changing their meaning would corrupt every existing consumer's interpretation.

## Candidate resolutions
### R1 — Spec numbering in the NEW gold_order_economics; live mart untouched (adopted)
- The NEW `gold_order_economics` (and `gold_product_economics`) adopt **spec CM1/CM2/CM3** (industry convention) from day one.
- The live `gold_contribution_margin` + TS twin are **left untouched** — no rename, no re-labelling of served values in Wave C.
- An **explicit mapping doc** ships with gold_order_economics (live CM1 ≙ spec CM2; live CM2 ≙ spec CM3), and the live mart is **deprecation-mapped in Wave D** (`knowledge-base/semantic/deprecation-map.md`), where the semantic layer becomes the single naming authority.
- Trade-offs: during Waves C–D two numbering schemes coexist; mitigated by the mapping doc + Wave D deprecation lint blocking NEW consumers of the old mart.

### R2 — Keep live numbering; amend the spec
- Trade-offs: locks the platform to non-standard CM semantics forever; every external benchmark/operator convention would need translation.

## RECOMMENDED resolution (BINDING)
**R1.** Additive (new mart only; zero change to served live metrics — never a silent re-labelling), with convergence handled by Wave D's governed deprecation path.
