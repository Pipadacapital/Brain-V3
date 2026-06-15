# ESCALATION RUBRIC — Brain, Phase 1

> When any role must stop and escalate. Escalation is **Advisor-gated and last-resort** — the
> Engineering Advisor answers from the Canon + lessons-learned first, and escalates to the
> Stakeholder only when the Canon cannot resolve the decision alone.
>
> The Delivery Coordinator mirrors every pending escalation into `pending-stakeholder-attention.md`
> and logs it to the audit trail within 1 business day of the escalation being raised.
>
> Sources: doc 12 §10 (escalation chain), §11 (architecture change process); doc 11 §2 (RACI);
> INVARIANTS.md; THE-MOAT.md; COMPLIANCE.md.

---

## Escalation threshold table

| Category (OS-fixed) | Brain's threshold — escalate when a change would… |
|---|---|
| **Irreversible / high-blast-radius decision** | (1) Run a destructive or hard-to-reverse migration on `bronze.*`, any ledger table (`realized_revenue_ledger`, `attribution_credit_ledger`, `invoice`, `decision_log`), or `audit_log`. (2) Break or narrow the Analytics API public contract (a breaking change to any endpoint in `frontend-api`, the read-only MCP surface, or the metric registry's `(metric_id, version)` key). (3) Change the tenancy or security boundary: RLS policy, `brand_id` scoping at any layer, per-brand S3 prefix structure, or KMS key topology (any change that could allow cross-brand data access — even transiently). (4) Modify the billing meter formula, the CM2 cap logic, or the `Trusted` gate condition for cap applicability. (5) Convert or migrate the Iceberg Bronze layer to a non-open or closed-proprietary format. |
| **Compliance / regulatory ambiguity the Canon does not resolve** | (1) Activating a new geographic jurisdiction (GCC/UAE or KSA) before the data-residency, DPA sub-processor list, and breach-notification controls for that jurisdiction are fully confirmed by legal counsel (COMPLIANCE.md Open decisions). (2) Any DPDP 2023 / UAE PDPL / KSA PDPL control that COMPLIANCE.md marks as an open legal decision — SAC code, IRN threshold, PDPL breach-notification window, cross-border transfer mechanism. (3) A proposed feature that would require Brain to act as a data **controller** (not processor) for any data subject. (4) An interpretation of the DPDP Rules 2025 Consent Manager framework that conflicts with the current `consent_record.source` design. (5) Any request to store, process, or transmit data that is in or near the PCI scope boundary (PANs, CVVs, raw bank credentials, full UPI secrets — these are a Security VETO before the escalation path; the escalation is to confirm scope change). |
| **Threatens a cost / performance / reliability budget** | (1) Any change that puts the collector availability SLO (99.95% accept+ack, 30-day rolling) at risk — a new synchronous dependency on the hot path, a producer swap, a schema-registry coupling that blocks the accept before validate guarantee. (2) Any change that puts the product surfaces SLO (99.9%) at risk — a new mandatory synchronous call into a third-party system on the read path, a cache invalidation strategy that forces full re-computation under load. (3) A proposed model call that would cause large-model spend to exceed 1% of total calls (the high-priority incident threshold in METRICS.md cost-routing section) — or a per-tenant model-spend overage that a gateway virtual-key budget cannot contain. (4) A new workload that is projected to increase monthly AWS infrastructure cost by more than 20% without a corresponding increase in billable GMV (requires a cost-routing audit and Platform/SRE sign-off before the Engineering Advisor escalates). |
| **Cross-team pattern / contract conflict the Architect cannot reconcile** | (1) A contract change proposed by one stream that would break a confirmed contract consumed by another stream, where both streams cannot agree on a migration path within one sprint. (2) A new module in `core` whose bounded-context boundary cannot be agreed between the module owner and the data CODEOWNER (e.g. a new module that reads the metric engine output but also writes to a ledger table). (3) A dependency direction conflict between streams (e.g. the decision engine stream wanting to pull identity-graph data synchronously from the identity module, breaking the async-idempotent-writer invariant). |
| **Changes an invariant or the moat** | Any proposed requirement, design, or PR that would: (1) Weaken, bypass, or remove an invariant in INVARIANTS.md. (2) Degrade measurement honesty — blend provisional and finalized revenue in a headline metric; suppress the unattributed residual; lower the 70-line threshold without a full confidence-model review; allow the LLM to surface a number not in `ai_provenance.metric_binding`. (3) Break the attribution closed-sum invariant (`Σ channel_contribution + unattributed = realized_revenue`). (4) Weaken the parity oracle guarantee (the "same finalized number everywhere" assertion). (5) Add a write tool to the MCP registry. (6) Cause a cross-brand data exposure — even in staging. (7) Alter the Decision Log's append-only property or break the `recommendation → outcome` binding that feeds the moat. |

---

## Architecture change process (frozen decisions)

The 13 locked ADRs in STACK.md are **frozen decisions**. They change **only** through this process
(doc 12 §11):

1. Anyone may propose an ADR documenting the context, the change, the consequences, and the
   revisit trigger.
2. The **Principal Architect** reviews the ADR — confirms it addresses a **proven critical flaw**
   or a **fired scale-trigger** (not a preference, not a "nice to have").
3. The **CTO** approves (the accountable authority per doc 11 §2 RACI).
4. The ADR is committed to `docs/adr/` before any implementation begins.

**Criteria for a frozen-decision change (conjunctive — all must hold):**
- There is a proven critical flaw (a bug, a security gap, or a correctness failure demonstrated
  in production or in a CI gate), OR a documented scale-trigger has fired (e.g. the Go collector
  producer trigger: KafkaJS throughput measured below the stated festival EPS threshold).
- The cost of the change (blast radius, migration complexity, retest burden) has been assessed
  and accepted by the CTO.
- The alternative of absorbing the flaw or trigger within the existing architecture has been
  explicitly ruled out.

**Not a valid reason for a frozen-decision change:**
- A preference for a different technology.
- A new feature that would be easier in a different architecture.
- A phase-N capability being pulled forward without firing its documented graduation trigger.

**ADRs live in `docs/adr/`.** Each records: context / decision / consequences / revisit-trigger.
The Engineering Advisor's journal references the ADR number on any intake that touches a frozen
decision.

---

## Escalation flow

```
Any role identifies a situation matching the threshold table above
    ↓
Raise to Engineering Advisor (not to Stakeholder directly)
    ↓
Engineering Advisor answers from Canon + lessons-learned (INVARIANTS.md / THE-MOAT.md /
COMPLIANCE.md / STACK.md / prior ADRs / journal) — resolves the majority of cases here
    ↓
If the Canon does not resolve it:
    Engineering Advisor escalates to Stakeholder (Founder) with:
      - the specific threshold category
      - the Canon gap that prevents resolution
      - a recommendation (not a neutral hand-off)
    ↓
Delivery Coordinator mirrors the pending item into `pending-stakeholder-attention.md`
within 1 business day and logs it to the audit trail
    ↓
Stakeholder decision is recorded in the audit log and fed back into the Canon as an
amendment (the Engineering Advisor owns the Canon update)
```

**Escalation to Stakeholder is last resort, not a status ping.**
The Engineering Advisor must be able to state which Canon gap prevents resolution before
escalating. "I'm not sure" or "the team disagrees" are not escalation triggers — they are
signals to re-read the Canon.

**Escalation chain for operational incidents (doc 12 §10):**
On-call engineer → Engineering Manager → VP Engineering → CTO.
The escalation rubric above is for **design and compliance decisions**, not for runtime incidents.
Runtime incidents follow the severity matrix in PLAYBOOK-incident.md.

> ASSUMPTION: The "Engineering Manager" and "VP Engineering" roles in the doc 12 §10 escalation
> chain map to the Founder + 5 Scenario-B team as follows: on-call = the owning engineer for the
> affected stream (doc 12 §2 app/package ownership); EM = Eng Director (doc 11 §2 RACI —
> Staffing/Allocation owner); VP Eng = VP Engineering (Release go/no-go authority). In Scenario-B,
> these may resolve to the same 1–2 people. The CTO is the final escalation for all
> frozen-decision and compliance matters regardless of team size.
