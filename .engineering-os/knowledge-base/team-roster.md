# TEAM ROSTER — Brain, Phase 1 (Advisor-Determined)

> Maps the Engineering OS fixed roles to Brain's RACI (doc 11 §2) and the advisor-
> determined Phase-1 team shape. The team SIZE is not locked to any single scenario —
> it is framed as a minimum viable configuration for the data-critical path, with
> explicit room to grow toward Scenario C as surfaces parallelize (doc 10 §4).
>
> ADVISOR DECISION (2026-06-15): Team shape for Phase-1 GA is a minimum of Scenario B
> (Founder + 5, data-heavy) — Scenario A (Founder + 2) is insufficient for GA in 6 months
> per doc 10 §22 ("too thin for GA in 6 mo"). The roster is expressed as a minimum
> Scenario-B configuration with named optional additions toward Scenario C; the team is
> not fixed at 6 heads. Hire order: data engineer first, then platform/SRE, backend,
> frontend. Beyond ~7 engineers, the hard dependency chain (not staffing) becomes the
> limit — Brooks's law applies (doc 10 §4).
>
> ADVISOR DECISION (2026-06-15): Principal Architect authority is assigned to the
> Staff/Lead Data Engineer (Data-1), not the Founder. Rationale is in the Architect
> row below.
>
> **Use role names below, not individual names.** Any entry where a specific individual's
> name is known is marked `> ASSUMPTION:` because the canonical source documents use
> role/function names only, not named personnel.
>
> Sources: doc 11 §2 (RACI + authorities), doc 11 §9 (capacity plan); doc 12 §2 (app/package
> ownership), §11 (architecture change process); doc 10 §3/§4 (critical path + team scenarios);
> STACK.md; ESCALATION-RUBRIC.md.

---

## Stakeholder

**Stakeholder = Founder.**

The Founder holds:
- The deploy gate (final go/no-go authority on GA and major milestones — doc 11 §2 RACI: Gate sign-off, Accountable for design-partner commitments).
- The design-partner relationship (doc 11 §6 — the Founder is the white-glove escalation line for the design partner).
- Product vision (doc 11 §2: Product scope / cut, Consulted; design-partner commitments, Accountable).
- Frontend execution in Phase 1 (the Founder owns `web/` and the Web workstream — doc 12 §2 app ownership).

The Founder is **not** the Principal Architect and is **not** the sole authority on architecture, engineering risk, or compliance decisions — those route through the Engineering Advisor before reaching the Founder as Stakeholder.

> ASSUMPTION: The Founder is a single individual who holds the product vision and the design-partner relationship, consistent with doc 11 §1 framing. The specific name is not recorded here.

---

## OS role → Brain RACI mapping

| OS role (agent file) | Brain role / function (doc 11 §2) | Phase-1 minimum-viable reality | Notes |
|---|---|---|---|
| **Engineering Advisor** (`cto-advisor` / `final-reviewer`) | **CTO** | Intake: Sonnet tier. Final review: Opus tier. | Sole escalation path to Stakeholder (rubric-gated). Owns Canon amendments. Frozen-decision **approval** authority (Architecture change — doc 12 §11: the CTO approves ADRs after Principal Architect review). Also serves as final-reviewer agent at the go/no-go gate (Stage 6). |
| **Architect** (`architect`) | **Principal Architect = Staff/Lead Data Engineer (Data-1)** | The Staff/Lead Data Engineer holds Principal Architect authority for Phase 1. | > ADVISOR DECISION (2026-06-15): Architectural risk concentrates entirely in the data foundation — medallion/parity, identity graph, metric engine, and the realized-revenue ledger are the frozen decisions most likely to require ADR review (doc 12 §11). Doc 11 §4 names "Staff Data" as the Data Foundation umbrella owner and doc 11 §10 assigns "Medallion/parity hardest surface" risk to "Staff Data." The person who owns parity oracle integrity and whose lakehouse/identity/metric-engine decisions are the frozen decisions that gate the entire critical path (doc 10 §3) is the natural ADR reviewer. The CTO (Engineering Advisor) retains final approval authority per doc 12 §11; the Principal Architect holds the Responsible reviewer role. Architecture change review (doc 12 §11 — R on frozen ADRs). Binding plan for every medium+ feature. CODEOWNERS sign-off on contract changes + 2-approval migrations. |
| **Backend Engineer** (`backend-developer`) | **Backend-1 / Backend-2** | Minimum 2 backend engineers (Scenario B). A third backend can be added for connector throughput (Scenario C). | App ownership: `collector`/`stream-worker`/`pixel-sdk` → Backend-1; `core` → Backend-2 (doc 12 §2). Connectors stream → Backend-2. Decision engine → Backend-2 + Founder. |
| **Frontend / Web Engineer** (`frontend-web-developer`) | **Founder / FE** | Founder covers frontend in Phase 1 at Scenario B. A dedicated FE engineer (the "6th" role noted in doc 11 §9) is an explicit de-risk option for web throughput — activate if the Founder's frontend bandwidth proves the bottleneck on W15/W19 dashboards. | Owns `web/` app and the Web workstream. Reads only via the Analytics API (no business logic in the frontend). |
| **Mobile Engineer** (`mobile-developer`) | **Dormant — Phase 1** | No native app in Phase 1. Mobile surface = responsive web + PWA push (STACK.md ADR-015). | This role has no active Phase-1 scope. It activates only if a native iOS/Android app is added (requires an ADR + Stakeholder approval). |
| **AI / ML Engineer** (`intelligence-engineer`) | **AI/ML function** (shared with Backend-2 and Data-1 in Phase 1) | No dedicated AI/ML headcount at Scenario B. AI work in Phase 1 is narration-only via LiteLLM (STACK.md ADR-013). | Owns the NLQ resolution eval gate, prompt caching audits, and the large-model-creep >1% incident response. In Phase 1, this function is shared — Backend-2 (decision engine) + Data-1 (metric engine integrity). Dedicated AI/ML Engineer activates in Phase 3 (Python ML service / Feast / predictions / MMM / incrementality — STACK.md Deferred). |
| **Security Reviewer** (`security-reviewer`) | **Security function** | Not a named headcount at Scenario B. Security controls are embedded in the CI pipeline and in CODEOWNERS reviews. | Holds a VETO on any invariant-breaking PR (INVARIANTS.md). Runs the quarterly chain-walk, the erasure drill, and the KMS restore drill. Owns the SOC2 readiness backlog (COMPLIANCE.md §5). In Scenario B, this function is covered by the Platform/SRE role for operational controls, with periodic external security review. A dedicated Security Reviewer FTE activates at SOC2 readiness phase (Phase 5). |
| **QA Engineer** (`qa-agent`) | **QA function** (embedded in streams) | No dedicated QA headcount at Scenario B. Testing is stream-owned per doc 12 §5 strategy. | Holds a VETO on a feature that lacks the non-negotiable test coverage (isolation, parity/reconciliation, contract, no-PII — doc 12 §5). In Scenario B, QA is owned by the CODEOWNER of the affected stream. A dedicated QA Engineer FTE activates if load/scale/certification testing outgrows the embedded model. |
| **Platform / SRE** (`platform-devops`) | **Platform / SRE** | 1 platform/SRE engineer (Scenario B). | Deploy + monitor + rollback. Owns the IaC (Terraform), EKS + ArgoCD, CI/CD matrix, SLO dashboards, DR drills, on-call process, and cost impact assessments. Front-loaded in Sprint 0, back-loaded at GA hardening (doc 11 §9 allocation). |
| **Delivery Coordinator** (`product-manager`) | **TPM / Eng Director** | No dedicated TPM headcount at Scenario B. Delivery coordination is shared between the Founder (product scope) and the Engineering Advisor (risk + escalation). | Owns the risk register (doc 11 §10). Mirrors pending escalations into `pending-stakeholder-attention.md` within 1 business day. Raises cross-cut blockers within 24h (doc 11 §2). Gate sign-off coordination (Consulted on all gates — doc 11 §2 RACI). A dedicated TPM activates when program complexity outgrows the Founder + Engineering Advisor model (likely Phase 3+ when stream and partner count grow). |

---

## Data engineers (not a standard OS role name — recorded for Brain specificity)

| Function | Phase-1 ownership | Notes |
|---|---|---|
| **Data-1 (Staff/Lead Data Engineer — Principal Architect)** | Lakehouse (Bronze→Silver→Gold), measurement (CM2/True CM2), metric engine, attribution (position-based + clawback), parity oracle. | Holds Principal Architect authority (see Architect row above). The Data Foundation umbrella stream owner (doc 11 §4). |
| **Data-2** | Identity core (deterministic alias graph), Customer 360, journey (`silver.touchpoint`), RLS migrations (`packages/db`), schema registry wiring. | Second data engineer; activates together with Data-1 at Scenario B. |

Data is the critical-path bottleneck through M3 (doc 11 §9 — 45% of team effort in M1 and M2/M3). **Hire order: data engineer first (doc 10 §4).** Protect data engineer throughput above all else.

---

## Team shape summary (advisor-determined, not fixed)

| Scenario | Headcount | Phase-1 viability | When to use |
|---|---|---|---|
| **A — Founder + 2** | 3 total | Insufficient — slips GA past 6 months (doc 10 §22) | Not recommended for the 6-month plan |
| **B — Founder + 5 (minimum for Phase 1)** | 6 total (+ optional 6th FE) | GA in ~6 months; data is the constraint | Start here; data engineer hired first |
| **C — Founder + 10** | 11 total | Faster surfaces; coordination overhead; data foundation still gates | Add when surfaces parallelize and coordination overhead is manageable |

> ADVISOR DECISION (2026-06-15): Scenario B is the minimum viable team for Phase-1 GA
> on the 6-month plan. The roster must not assert Scenario B as the permanent or only
> valid headcount — it is the floor. The team should grow toward Scenario C
> incrementally as the hard dependency chain (not staffing) becomes the gating factor
> after M3. The optional 6th FE de-risks web throughput (W15, W19 dashboards) and
> should be activated if the Founder's frontend bandwidth is the measured bottleneck.

---

## Dormant roles in Phase 1 (activate only via ADR + Stakeholder approval)

| OS role | When it activates |
|---|---|
| Mobile Engineer | A native iOS/Android app is added to scope. Requires ADR + Stakeholder. |
| Dedicated AI/ML Engineer | Phase 3 Python ML service (Feast / predictions / MMM / incrementality). STACK.md Deferred. |
| Dedicated Security Reviewer (FTE) | SOC2 readiness phase (Phase 5). COMPLIANCE.md §5. |
| Dedicated QA Engineer (FTE) | Load / scale / certification testing phase, if the embedded QA model proves insufficient. |
| Dedicated TPM | If program complexity outgrows the Founder + Engineering Advisor model (likely Phase 3+ when stream count and partner count grow). |
| Dedicated Frontend / Web Engineer | If the Founder's frontend bandwidth is the measured bottleneck on W15/W19 surfaces — this is an explicit optional de-risk at Scenario B, not a Phase-3 addition. |

---

## RACI summary (key decision types, doc 11 §2)

| Decision | CTO (Eng Advisor) | VP Eng | VP Prod | TPM | Eng Dir | Prin Arch (Staff Data Eng) | Founder (Stakeholder) |
|---|---|---|---|---|---|---|---|
| Architecture change (frozen ADR) | **A** | C | C | I | C | **R** | C |
| Product scope / cut | C | C | **A/R** | C | I | I | C |
| Release go/no-go | **A** | **R** | C | C | C | C | I |
| Risk acceptance | **A** | R | C | **R** | C | C | I |
| Staffing / allocation | C | **A** | I | C | **R** | I | C |
| Design-partner commitments | I | C | **R** | I | I | I | **A** |
| Gate sign-off | **A** | R | R | R | C | R | C |

> ASSUMPTION: In Scenario-B (Founder + 5), the "VP Eng" role is a function that may be
> performed by a senior engineer or the Founder, not necessarily a titled VP Engineering
> hire. The RACI table above reflects the role authority as documented in doc 11 §2,
> independent of whether a VP Eng title is filled in Phase 1.

> ASSUMPTION: "Eng Director" in doc 11 §2 refers to a staffing/allocation authority.
> In Scenario-B, this function may be absorbed by the Founder or a senior engineer.
> The role is recorded here as it appears in the source document; Brain should designate
> who holds this authority explicitly before Sprint 0.

> ADVISOR DECISION (2026-06-15): **Principal Architect = Staff/Lead Data Engineer (Data-1).**
> The Founder is Stakeholder only. The Architecture change process (doc 12 §11) now has
> its required named reviewer for every frozen-decision ADR: Principal Architect (R =
> Staff/Lead Data Engineer) + CTO (A = Engineering Advisor). The Founder is Consulted,
> not Responsible, on frozen architecture decisions.
