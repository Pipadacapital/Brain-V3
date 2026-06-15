# Brain — Program Execution Plan (Day 1 → GA)

**Product:** Brain — AI-native commerce OS for DTC brands (India launch).
**Document type:** the executable **delivery program** — governance, workstreams, critical-path management, the design-partner program, a week-by-week plan, go/no-go gates, dashboards, and commercialization. Turns doc 10 (engineering execution) into something a **VP Eng / CTO / EM / TPM / founding team can run from Day 1 to GA without further planning artifacts.**
**Status:** Final v1. **Date:** 2026-06-15.
**Frozen (immutable inputs):** docs 01–10 + the Attribution Engine Spec. **No architecture/requirements/services/deployables/databases/ledgers/platforms change** — 3 deployables + web. This is delivery only.
**Anchors:** doc 10 (roadmap, milestones M0–M5, Scenario-B team), doc 04 §O.3 (phase exits), doc 09 (detectors). **Horizon: 24 weeks (6 months).**

---

## 1. Program executive summary
**Fastest realistic path Day 1 → GA (24 weeks):**
`Sprint 0 (W1–2) → M1 spine + Internal Alpha (W3–8) → M2 measurement + Design-Partner onboard (W9–12) → M3 attribution + billing live → First Paying Customer (W13–16) → M4 decision engine + Beta → First Recommendation (W17–20) → M5 hardening → GA (W21–24).`
- **Design Partner (Sugandh Lok) onboarded:** W10–11; **success-validated:** W14.
- **First paying customer:** ~W16 (billing on realized GMV — does *not* wait for the moat).
- **First recommendation (real data, impact+confidence+evidence):** ~W19–20.
- **GA:** W24.
**The program's single organizing principle:** *charge on trustworthy measurement early; let the recommendation/learning moat compound after.* The critical path is **data**, so the program is run to protect the data engineers' throughput above all else.

## 2. Delivery governance model + RACI
**Authorities:** Architecture = **Principal Architect** (decides), **CTO** (final accountable; frozen-decision waiver only on proven critical flaw). Product scope = **VP Product**. Release = **VP Engineering**. Risk = **TPM** (owns the register), **CTO** (escalation). Staffing = **Eng Director**. Founder = vision + design-partner relationship + product.
**Escalation:** Engineer → EM/Staff → Eng Director → VP Eng → CTO; product trade-offs → VP Product → CTO; cross-cut blockers → TPM raises within 24h.

| Decision | CTO | VP Eng | VP Prod | TPM | Eng Dir | Prin Arch | Founder |
|---|---|---|---|---|---|---|---|
| Architecture change (frozen) | **A** | C | C | I | C | **R** | C |
| Product scope / cut | C | C | **A/R** | C | I | I | C |
| Release go/no-go | **A** | **R** | C | C | C | C | I |
| Risk acceptance | **A** | R | C | **R** | C | C | I |
| Staffing / allocation | C | **A** | I | C | **R** | I | C |
| Design-partner commitments | I | C | **R** | I | I | I | **A** |
| Gate sign-off | **A** | R | R | R | C | R | C |
*(R=Responsible, A=Accountable, C=Consulted, I=Informed.)*

## 3. Program structure (hierarchy)
```
PROGRAM: Brain Phase-1 to GA
 ├─ STREAM (15, §4)  e.g. Data Foundation, Decision Engine, Platform…
 │   ├─ EPIC        e.g. "Collector + durable spool", "Realized-revenue ledger"
 │   │   ├─ WORK PACKAGE   e.g. "Spool durability + retry", "Ledger event_type writer"
 │   │   │   └─ TASK       2–5 day unit, one owner, one acceptance check (doc 05 writing-plans)
```
Cadence: 2-week sprints; weekly program review; daily stream stand-ups. Every task maps 1:1 to a contract/spec line (no orphan work).

## 4. Workstream definitions (15)
| Stream | Owner | Key dependencies | Success criteria | Top risk |
|---|---|---|---|---|
| **Data Foundation (umbrella)** | Staff Data | all below | reconciling lakehouse, parity green | medallion complexity |
| Pixel (`pixel-sdk`) | Backend-1 | Sprint 0 | events→collector, cart-stitch works | ITP/consent edge cases |
| Collector | Backend-1 | Sprint 0, Redpanda | accept+ack 99.95%, spool durable | spool durability |
| Connectors | Backend-2 | connector SDK | Shopify+Meta+Google+Razorpay+logistics ingest | API quirks, rate limits |
| Identity | Data-2 | Bronze | deterministic resolve, phone-guard, replayable | false merges |
| Lakehouse | Data-1 | Bronze | Bronze→Silver→Gold, dbt tests pass | small-files/perf |
| Measurement | Data-1 | metric engine | CM2/True CM2, parity green | cost-confidence |
| Customer 360 | Data-2 | identity, ledger | derived 360, rebuildable | profile completeness |
| Journey | Data-2 | identity, touchpoints | `silver.touchpoint` timeline | derived-only discipline |
| Attribution | Data-1 | journey, ledger | position-based + clawback, reconciles | honesty vs platforms |
| Decision Engine | Backend-2 + Founder | metric engine, attribution | detectors + confidence + Morning Brief | false positives/fatigue |
| Platform/SRE | Platform | Sprint 0 | IaC, CI/CD, SLOs, DR | infra yak-shaving |
| Web | Founder/FE | Analytics API | dashboards + Morning Brief + onboarding | API readiness |
| Billing | Backend-2 | ledger, settlement | meter+snapshot+invoice | settlement timing |
| Operations | TPM/Platform | all | observability, runbooks, support | on-call readiness |

## 5. Critical-path management
**True critical path:** `Sprint 0 → Collector/Bronze → Identity → Ledger → Metric engine → Analytics API → [Billing | Attribution → Decision Engine] → GA`.
**Near-critical:** connector SDK → Razorpay settlement → billing meter (gates first revenue); attribution → decision engine (gates first recommendation).
**Parallel streams:** pixel+collector ∥ Shopify connector ∥ control-plane (auth/RLS/billing scaffold) ∥ web shell (against mocked contracts).
**Blocked-until:** attribution **blocked until** identity reconciles; decision engine **blocked until** parity green; billing **blocked until** settlement connector.
| Item | Must finish before | Can run parallel with | Go/No-Go gate |
|---|---|---|---|
| Bronze | identity, Silver | pixel, connectors, web shell | M1 |
| Identity (deterministic) | attribution, C360 | lakehouse Silver | M1 |
| Metric engine + parity | Analytics API, attribution | control plane | M1 |
| Razorpay settlement | billing meter | logistics connector | M2 |
| Attribution (reconciles) | decision engine | billing | M3 |
| Decision detectors | first recommendation | hardening | M4 |

## 6. Design-partner program (Sugandh Lok)
| When | Milestone | Activities | Success criteria |
|---|---|---|---|
| **W0** | Agreement | scope, success metrics, data-sharing + consent, white-glove SLA | signed; access to Shopify+Meta+Razorpay |
| **W1** | Connect | OAuth Shopify+Meta; pixel install via Web Pixel extension on CNAME; consent configured | events flowing to Bronze |
| **W2** | Baseline | identity resolving; honest-but-immediate Day-0 surface | match-rate visible; "building baseline" shown |
| **W4** | Measurement | realized revenue + CM2 (Estimated) + rule-based attribution + unattributed bucket | numbers reconcile to Shopify within tolerance |
| **W8** | Truth | finalized recognition cycle, True CM2, Customer 360, first Morning Brief (watch-level) | partner agrees the numbers are *more honest* than their stack |
| **W12** | Decisions + bill | deterministic recommendations w/ impact+confidence+evidence; inspectable bill on realized GMV | partner acts on ≥1 rec; agrees to be billed |
**Feedback loops:** weekly partner review; an in-product feedback path; the Decision Log captures accept/reject. **Risk mitigation:** white-glove onboarding, honest "data delayed/insufficient" states (never fake a number), a fast escalation line to the founder. **Validation framework:** reconciliation tolerance + match-rate + partner-reported trust + rec acceptance.

## 7. Design-partner success metrics
| Dimension | "Success" means |
|---|---|
| Technical | events→Bronze 99.95% accept+ack; isolation passes; parity green |
| Data/Measurement | Brain-attributed revenue reconciles to Shopify order ledger **net RTO/refund** within tolerance (spec §15); match-rate tracked |
| Attribution | platform-vs-Brain-vs-self-reported triangulation shown; unattributed bucket honest |
| Decision | ≥1 recommendation surfaced with impact+confidence+evidence; ≥1 acted on |
| Business | partner reports Brain's CM2/realized view is *more trustworthy* than their current tool |
| Commercial | partner agrees to be billed on realized GMV |
**Brain can claim success only when:** reconciliation holds, the partner trusts the numbers over their incumbent, and they act on a recommendation **and** agree to pay.

## 8. Weekly delivery plan (W1–24)
| W | Objective | Key deliverable | Dep | Acceptance |
|---|---|---|---|---|
| 1 | Sprint 0 | repo, CI, Terraform, contracts, RLS migration #1 | — | CI builds; RLS on |
| 2 | Sprint 0 exit | local-dev stack; hello-event pixel→Bronze in CI | W1 | event in Bronze behind RLS |
| 3 | Collector+pixel | spool + accept-before-validate; `pixel-sdk` v0 | W2 | event accepted+spooled |
| 4 | Shopify + Bronze | Shopify connector (orders); Bronze tables | W3 | orders in Bronze |
| 5 | Identity core | deterministic alias graph + async resolve | W4 | anon→known resolves |
| 6 | Ledger | `realized_revenue_ledger` (provisional) | W5 | realized revenue computed |
| 7 | Metric engine | metric engine + parity oracle (spine metrics) | W6 | parity green on fixtures |
| 8 | **M1 / Alpha** | Analytics API + web shell + Meta; **Internal Alpha** | W7 | reconciling number on screen; isolation passes |
| 9 | Measurement | Google Ads; CM waterfall + CM2 | W8 | CM2 shown w/ confidence |
| 10 | Settlement + DP | Razorpay settlement; **Design Partner connect** | W9 | settlement ingested; DP live |
| 11 | True CM2 + DQ | True CM2; DQ grades + gating + FX; identity review-queue | W10 | True CM2; grades gate behavior |
| 12 | **M2 exit** | billing meter + sealed snapshot scaffold; Customer 360 | W11 | snapshot reproducible |
| 13 | Attribution | rule-based position-based + clawback | W12 | credit reconciles to ledger |
| 14 | Journey + DP validate | `silver.touchpoint`; channel-contribution; **DP success check** | W13 | reconciliation within tolerance |
| 15 | Surfaces | dashboards + Morning Brief (watch-level); tracking-plan | W14 | Morning Brief renders w/ evidence |
| 16 | **M3 / Billing live** | inspectable bill + GST invoice; **First Paying Customer** | W15 | brand billed on realized GMV |
| 17 | Decision engine | detector framework + 3 detectors + confidence | W16 | a detector fires w/ confidence |
| 18 | Decision engine | +3 detectors; recommendation contract + Decision Log | W17 | rec persisted w/ evidence |
| 19 | First rec | Morning Brief recommendations; feedback capture | W18 | **real-data rec: impact+confidence+evidence** |
| 20 | **M4 / Beta** | MCP read-only; NLQ (descriptive); **Beta (~10 brands)** | W19 | beta brands onboarded |
| 21 | Hardening | SLOs; load test (festival EPS) | W20 | SLOs met under load |
| 22 | Hardening | DR drill; security review; isolation fuzz at scale | W21 | DR drill passes; sec clean |
| 23 | Pre-GA | runbooks; status page; on-call; cost review | W22 | ops ready |
| 24 | **GA** | GA readiness checklist; launch | W23 | all gates green |

## 9. Engineering capacity plan (Founder + 5)
Team: 2 backend, 2 data, 1 platform/SRE; founder = product + frontend (FE thin; a 6th FE accelerates web). Allocation by phase (% of team-effort):
| Phase | Data | Backend | Platform | Frontend | Product |
|---|---|---|---|---|---|
| Sprint 0 (W1–2) | 25 | 25 | **40** | 0 | 10 |
| M1 (W3–8) | **45** | 30 | 10 | 5 | 10 |
| M2/M3 (W9–16) | **45** | 25 | 5 | 15 | 10 |
| M4 (W17–20) | 25 | **35** | 5 | 20 | 15 |
| M5 GA (W21–24) | 20 | 20 | **35** | 10 | 15 |
**Constant truth:** data is the bottleneck through M3 — protect it; platform front-loads (Sprint 0) and back-loads (GA hardening); frontend ramps as the API stabilizes.

## 10. Risk management plan
| Risk | Type | Prob | Impact | Mitigation | Contingency | Owner |
|---|---|---|---|---|---|---|
| Medallion/parity hardest surface | Technical | High | High | data engineer first; parity gate from M1 | slip M1, cut connectors to 1 | Staff Data |
| Cross-brand leak | Data | Low | **Critical** | RLS day-1 + isolation fuzz everywhere | halt launch | Platform |
| Identity false-merge | Identity | Med | High | phone-guard, suppression, review queue | tighten thresholds, manual review | Data-2 |
| "Brain's number < Meta's" | Attribution | High | High | honest-reconciliation view; unattributed bucket | partner education | VP Product |
| Settlement delay blocks billing | Delivery | Med | High | Razorpay named W10 dep | bill on provisional w/ true-up | Backend-2 |
| Data engineer attrition/SPOF | People | Med | High | 2 data engineers; document pipeline | contractor backfill | Eng Dir |
| Festival load | Platform | Med | Med | load test W21; tiered storage | throttle backfill | Platform |
| Design partner churns | DP | Med | High | white-glove, weekly value | second partner in pipeline | Founder |
| Scope creep into ML/recs early | Delivery | High | High | deferrals in doc 10; recommend-only | TPM cut-scope authority | TPM |
| Can't prove rec value | Commercial | Med | High | outcome on finalized ledger; honest "directional" | hold rec claims until evidence | VP Product |

## 11. Go/No-Go gates
| Gate | Required evidence | Required metrics | Sign-off |
|---|---|---|---|
| **Sprint 0 exit** | event pixel→Bronze in CI behind RLS; contracts generate | CI green; RLS on | VP Eng + Platform |
| **M1 exit** | reconciling realized-revenue number; isolation + parity | parity green; isolation 0 leaks | CTO + Prin Arch |
| **M2 exit** | bill reproducible from ledger; CM2 w/ confidence; settlement ingested | snapshot reproducible | VP Eng + VP Product |
| **M3 exit** | attribution reconciles net RTO/refund (spec §15); Morning Brief renders | reconciliation ≤ tolerance | CTO + VP Product |
| **M4 exit** | real-data recommendation w/ impact+confidence+evidence | detector precision ≥ threshold | CTO + VP Product |
| **Beta exit** | ~10 brands; SLOs; DR drill; security review | 99.9%/99.95%; DR pass | CTO + VP Eng |
| **GA exit** | full Phase-1 checklist (§15) | all SLOs + load + isolation | CTO (final) |

## 12. Program dashboard (weekly leadership review)
- **Executive:** milestone status vs plan, critical-path slip (days), gate readiness, design-partner health, burn vs runway.
- **Engineering:** velocity, PR cycle time, build/deploy health, open Sev-1/2, test coverage on critical paths.
- **Data:** parity-oracle status, reconciliation tolerance, match-rate (anon→known), DQ grades, freshness SLOs.
- **Delivery:** % tasks on-plan, blocked streams, dependency risk, next-gate ETA.
- **Customer:** design-partner activation funnel (connect→baseline→truth→decision), recs surfaced/accepted.
- **Commercial:** billable GMV under measurement, first-bill readiness, conversion status.
**Review weekly:** critical-path slip, parity/reconciliation, design-partner health, gate readiness — the four that predict GA.

## 13. Design-partner commercialization plan
- **When to charge:** at **M3/billing-live (~W16)** — realized-GMV meter + sealed snapshot + inspectable bill + a value-proving surface exist. Design partner may be free/discounted through validation (W12), then converts.
- **Proof required:** reconciliation to the order ledger net RTO/refund within tolerance; CM2/realized-revenue honesty the platforms can't show; ≥1 acted-on recommendation.
- **Expected objections → answers:** *"Brain's revenue is lower than Meta's"* → the honest-reconciliation view (Brain shows realized, de-duplicated truth); *"why % of GMV?"* → Brain surfaces *profit* (True CM2) and *honest* attribution incumbents don't; *"data looks delayed"* → transparent freshness + it never fakes a number.
- **Pricing validation:** confirm the design partner accepts `max(tier% × realized GMV, min-fee)` against the value shown; sanity-check per-brand cost-to-serve vs the min-fee (doc 01 §23.1).
- **Conversion:** Alpha (free) → Design Partner (free/discounted, white-glove) → **Paid at billing-live**, contingent on the W14 success check.

## 14. First-recommendation validation plan
- **How Brain proves recommendations create value:** every acted recommendation's outcome is **measured on the finalized ledger** (`recommendation_outcome`, doc 09) — realized ΔCM2 vs baseline, at the realization horizon (never provisional).
- **Evidence requirements:** the recommendation card's evidence (signals + metric values + provenance) + the post-action outcome + the Decision Log entry.
- **Measurement requirements:** finalized realized CM2; directional in Phase 1 (true incrementality/holdouts are Phase 2, reserved).
- **Validation framework:** acceptance rate + measured realized-CM2 movement + design-partner-confirmed usefulness; aggregated into `recommendation_effectiveness` per detector.
- **Failure criteria:** a detector below precision threshold for K periods → **auto-mute** (doc 09 Part 10); Brain withholds the rec rather than assert unproven value. *Phase-1 claims are "directional," not "causal" — stated honestly.*

## 15. Launch readiness framework
| Stage | Checklist | Approval | Rollback | Owner |
|---|---|---|---|---|
| **Internal Alpha (W8)** | spine + 1–2 connectors + 1 dashboard; isolation passes | VP Eng | feature-flag off | Eng Dir |
| **Design Partner (W10)** | measurement + attribution + Morning Brief; white-glove ready | Founder + VP Product | pause partner, fix, resume | Founder |
| **Beta (W20)** | + decision engine + billing; SLOs; DR drill; security review | CTO + VP Eng | flag-off recs/billing per brand | VP Eng |
| **GA (W24)** | full Phase-1; load tested; on-call; status page; runbooks | CTO (final) | canary/flag rollback (Phase-4 infra not required for flag-off) | CTO |

## 16. Negative review (break the plan)
- **Where it slips:** M1 (medallion+parity) is the most likely slip — if it slips, **cut to one connector (Shopify) and one metric**, don't add people. M2 settlement is subtle.
- **Wrong assumptions:** that founder+5 holds — if the FE is *only* the founder, web/dashboards (W15, W19) slip; **a 6th FE de-risks the surfaces**. That the design partner stays engaged 12 weeks — line up a second.
- **Overbuilt:** identity review-queue UI and full 9-sub-score confidence before first revenue — ship thin. NLQ-diagnostic, MCP polish — defer.
- **Underbuilt:** observability + isolation testing if rushed (existential); reconciliation tolerance definition (define it W4, not W14).
- **Cut/delay:** everything Phase-2/3 (MMM, holdouts, probabilistic identity, multi-model, view-through, WhatsApp connector, progressive-delivery, multi-region).
- **What prevents first revenue:** settlement/billing-meter slip — sequenced early (W10/W16) precisely for this.
- **What prevents first recommendation:** building the full catalog/learning loop — **one detector end-to-end is the bar (W19)**; TPM enforces.
- **Biggest failure mode:** chasing attribution sophistication before the foundation reconciles — the gates structurally block it (M1 parity before M3 attribution before M4 decisions).

## 17. Final program recommendation
- **Timeline:** 24 weeks, gated (Sprint0 → M1 W8 → M2 W12 → M3/billing W16 → M4/beta W20 → GA W24).
- **Staffing:** Founder + 5 (2 data, 2 backend, 1 platform), **hire data first**; add a 6th FE if web throughput matters.
- **Sequencing:** layer the foundation, slice the surfaces; **bill on measurement at W16, recommend at W19** — don't couple them.
- **Success criteria:** M1 parity green + isolation; M3 reconciliation within tolerance; M4 a real-data rec; design-partner trust + conversion.
- **Launch strategy:** Internal Alpha (W8) → Design Partner white-glove (W10) → Beta ~10 brands (W20) → GA (W24).
- **Most likely failure modes:** medallion/parity slip; FE under-staffing; scope creep into early ML; design-partner churn.
- **Most important leadership focus (weekly):** protect data-engineer throughput; watch the parity/reconciliation gate; keep the design partner trusting the numbers; ruthlessly defer Phase-2/3. **Everything else is detail.**

---

*End of Program Execution Plan. Immutable inputs: docs `01`–`10` + `Brain_Attribution_Engine_Spec`. No architecture changed. Engineering basis: doc 10; phase exits: doc 04 §O.3.*
