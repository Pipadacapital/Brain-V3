# TEAM ROSTER — Brain, Phase 1 (Founder + 5, Scenario-B)

> Maps the Engineering OS fixed roles to Brain's RACI (doc 11 §2) and the Phase-1
> Scenario-B team reality (doc 11 §9: 2 backend, 2 data, 1 platform/SRE, founder =
> product + frontend). Several OS roles are dormant in Phase 1 and are noted as such.
>
> **Use role names below, not individual names.** Any entry where a specific individual's
> name is known is marked `> ASSUMPTION:` because the canonical source documents use
> role/function names only, not named personnel.
>
> Sources: doc 11 §2 (RACI + authorities), §9 (capacity plan); doc 12 §2 (app/package
> ownership); STACK.md; ESCALATION-RUBRIC.md.

---

## Stakeholder

**Stakeholder = Founder.**

The Founder holds:
- The deploy gate (final go/no-go authority on GA and major milestones — doc 11 §2 RACI: Gate sign-off, Accountable for design-partner commitments).
- The design-partner relationship (doc 11 §6 — the Founder is the white-glove escalation line for the design partner).
- Product vision (doc 11 §2: Product scope / cut, Consulted; design-partner commitments, Accountable).
- Frontend execution in Phase 1 (the Founder owns `web/` and the Web workstream — doc 12 §2 app ownership).

The Founder is **not** the sole authority on architecture, engineering risk, or compliance decisions — those route through the Engineering Advisor before reaching the Founder as Stakeholder.

> ASSUMPTION: The Founder is a single individual who holds the product vision and the design-partner relationship, consistent with doc 11 §1 framing. The specific name is not recorded here.

---

## OS role → Brain RACI mapping

| OS role (agent file) | Brain role / function (doc 11 §2) | Phase-1 Scenario-B reality | Notes |
|---|---|---|---|
| **Engineering Advisor** (`cto-advisor` / `final-reviewer`) | **CTO** | Intake: Sonnet tier. Final review: Opus tier. | Sole escalation path to Stakeholder (rubric-gated). Owns Canon amendments. Frozen-decision approval authority (Architecture change — doc 12 §11). Also serves as final-reviewer agent at the go/no-go gate (Stage 6). |
| **Architect** (`architect`) | **Principal Architect = the Founder** (Stakeholder-designated, 2026-06-15) | The Founder holds Principal Architect authority for Phase 1. | Architecture change review (doc 12 §11 — R on frozen ADRs). Binding plan for every medium+ feature. CODEOWNERS sign-off on contract changes + 2-approval migrations. |
| **Backend Engineer** (`backend-developer`) | **Backend-1 / Backend-2** | 2 backend engineers. | App ownership: `collector`/`stream-worker` → Backend-1; `core` → Backend-2 (doc 12 §2). Also owns connectors stream (Backend-2) and decision engine (Backend-2 + Founder). |
| **Frontend / Web Engineer** (`frontend-web-developer`) | **Founder / FE** | Founder covers frontend in Phase 1. A 6th FE engineer is noted as an accelerator (doc 11 §9) but is not in the base Scenario-B count. | Owns `web/` app and the Web workstream. Reads only via the Analytics API (no business logic in the frontend). |
| **Mobile Engineer** (`mobile-developer`) | **Dormant — Phase 1** | No native app in Phase 1. Mobile surface = responsive web + PWA push (STACK.md ADR-015). | This role has no active Phase-1 scope. It activates only if a native iOS/Android app is added (requires an ADR + Stakeholder approval). |
| **AI / ML Engineer** (`intelligence-engineer`) | **AI/ML function** (shared with Backend-2 or a data engineer in Phase 1) | No dedicated AI/ML headcount in Scenario-B. AI work in Phase 1 is narration-only via LiteLLM (STACK.md ADR-013). | Owns the NLQ resolution eval gate, prompt caching audits, and the large-model-creep >1% incident response. In Phase 1, this function is shared — likely Backend-2 (decision engine) + Data-1 (metric engine integrity). |
| **Security Reviewer** (`security-reviewer`) | **Security function** | Not a named headcount in Scenario-B. Security controls are embedded in the CI pipeline and in CODEOWNERS reviews. | Holds a VETO on any invariant-breaking PR (INVARIANTS.md). Runs the quarterly chain-walk, the erasure drill, and the KMS restore drill. Owns the SOC2 readiness backlog (COMPLIANCE.md §5). In Scenario-B, this function is likely the Founder or Platform/SRE for operational controls, with periodic external security review. |
| **QA Engineer** (`qa-agent`) | **QA function** (embedded in streams) | No dedicated QA headcount in Scenario-B. Testing is stream-owned per doc 12 §5 strategy. | Holds a VETO on a feature that lacks the non-negotiable test coverage (isolation, parity/reconciliation, contract, no-PII — doc 12 §5). In Scenario-B, QA is owned by the CODEOWNER of the affected stream. |
| **Platform / SRE** (`platform-devops`) | **Platform / SRE** | 1 platform/SRE engineer. | Deploy + monitor + rollback. Owns the IaC (Terraform), EKS + ArgoCD, CI/CD matrix, SLO dashboards, DR drills, on-call process, and cost impact assessments. Front-loaded in Sprint 0, back-loaded at GA hardening (doc 11 §9 allocation). |
| **Delivery Coordinator** (`product-manager`) | **TPM / Eng Director** | No dedicated TPM headcount in Scenario-B. Delivery coordination is shared between the Founder (product scope) and the Engineering Advisor (risk + escalation). | Owns the risk register (doc 11 §10). Mirrors pending escalations into `pending-stakeholder-attention.md` within 1 business day. Raises cross-cut blockers within 24h (doc 11 §2). Gate sign-off coordination (Consulted on all gates — doc 11 §2 RACI). |

---

## Data engineers (not a standard OS role name — recorded for Brain specificity)

| Function | Phase-1 ownership |
|---|---|
| **Data-1** | Lakehouse (Bronze→Silver→Gold), measurement (CM2/True CM2), metric engine, attribution (position-based + clawback), parity oracle. |
| **Data-2** | Identity core (deterministic alias graph), Customer 360, journey (`silver.touchpoint`), RLS migrations (`packages/db`), schema registry wiring. |

Data is the critical-path bottleneck through M3 (doc 11 §9 — 45% of team effort in M1 and M2/M3). Protect data engineer throughput above all else.

---

## Dormant roles in Phase 1 (activate only via ADR + Stakeholder approval)

| OS role | When it activates |
|---|---|
| Mobile Engineer | A native iOS/Android app is added to scope. Requires ADR + Stakeholder. |
| Dedicated AI/ML Engineer | Phase 3 Python ML service (Feast / predictions / MMM / incrementality). STACK.md Deferred. |
| Dedicated Security Reviewer (FTE) | SOC2 readiness phase (Phase 5). COMPLIANCE.md §5. |
| Dedicated QA Engineer (FTE) | Load / scale / certification testing phase, if the embedded QA model proves insufficient. |
| Dedicated TPM | If program complexity outgrows the Founder + Engineering Advisor model (likely Phase 3+ when stream count and partner count grow). |

---

## RACI summary (key decision types, doc 11 §2)

| Decision | CTO (Eng Advisor) | VP Eng | VP Prod | TPM | Eng Dir | Prin Arch (Architect) | Founder (Stakeholder) |
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

> RESOLVED (Stakeholder, 2026-06-15): **Principal Architect = the Founder.** The Architecture
> change process (doc 12 §11) now has its required named reviewer for every frozen-decision ADR.
