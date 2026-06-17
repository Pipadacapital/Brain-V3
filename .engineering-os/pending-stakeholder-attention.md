# Pending Stakeholder Attention

> Items here require Stakeholder review. Agents add lines; the Stakeholder acts and strikes them through.
> Each line names the issue, the artifact path, and the slash command to act.

- ~~[feat-realized-revenue-ledger / Stage-6 PASS] **F-SEC-01 (HIGH) conscious-accept** — `revenue-finalization` Argo job no-ops under `brain_app` FORCE-RLS brand enumeration ... Act: accept at the Stage-7 gate or bounce to fix.~~ **[RESOLVED 2026-06-17 — fixed via 0019 `list_active_brand_ids()`; codified by durable rule `system-job-force-rls-enumeration`.]**
- ~~[RULE-PROPOSAL recommended — recurring pattern, 2nd occurrence] **Cross-tenant system/Argo jobs MUST enumerate tenants via a SECURITY DEFINER function ...** Act: `/adopt-rule` to codify.~~ **[SUPERSEDED → adopted 2026-06-17 as durable rule `system-job-force-rls-enumeration`.]**
- ~~[RULE-PROPOSAL — **3rd occurrence, auto-candidate bar CROSSED**] **System/cron/worker jobs MUST enumerate tenants via a SECURITY DEFINER fn ...** Act: `/adopt-rule system-job-force-rls-enumeration`.~~ **[ADOPTED 2026-06-17 by stakeholder → `.engineering-os/durable-rules/2026-06-17T09-59-08Z__system-job-force-rls-enumeration.md`.]**
- ~~[feat-connector-backfill / Stage-6 PASS] **APPROVE → Stakeholder gate, 0 blocking.** ... Act: accept + commit + advance at the Stage-7 gate.~~ **[SHIPPED 2026-06-17 (PR #31). Residual tracked debt remains open: SEC-BF-M2 (dual LedgerWriter, post-M1), SEC-BF-L1 (dual repo), DEV-TOKEN-REACH (live worker token reachability).]**

- [feat-shopify-live-connector / Stage-6 PASS] **APPROVE → Stakeholder gate, 0 blocking.** Deep Shopify live connector (webhooks + 35-day re-pull + live recognition). ORCH-LV-H1 (wired-to-nothing) fixed + re-proven LIVE (ledger 19,488→20,285, 49 rto_reversal). Tracked non-blocking debt: SEC-LV-M1 (MED, re-pull lock-window → double API calls, M1+), SEC-LV-L1 (LOW, NaN-date guard). Artifacts: `11-final-review.md`, `final-review.verdict.json`, `pending-stakeholder-commit.md`. Act: accept + commit + advance at the Stage-7 gate.
- [WATCH — wired-to-nothing pattern, **2nd occurrence**, NOT yet at the /adopt-rule bar] A new Kafka consumer / recognition-writer built + unit-tested in isolation but NOT subscribed/`.start()`-ed in the deployable (`main.ts`) — order/recognition effect doesn't run; caught only by live verification, not the unit-tested reviews. #1 = ADR-BF-9 (backfill), #2 = ORCH-LV-H1 (this run). Proposed rule (END-TO-END wiring test: real produce → real subscribe → observed sink effect) is drafted in `11-final-review.md` + `lessons-learned.md`. Act: NO action now; the final reviewer recommends raising `/adopt-rule` at occurrence #3 (matches the system-job-force-rls 3-occurrence precedent).

(no other open items)
