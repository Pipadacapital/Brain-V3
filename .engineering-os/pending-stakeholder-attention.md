# Pending Stakeholder Attention

> Items here require Stakeholder review. Agents add lines; the Stakeholder acts and strikes them through.
> Each line names the issue, the artifact path, and the slash command to act.

- ~~[feat-realized-revenue-ledger / Stage-6 PASS] **F-SEC-01 (HIGH) conscious-accept** — `revenue-finalization` Argo job no-ops under `brain_app` FORCE-RLS brand enumeration ... Act: accept at the Stage-7 gate or bounce to fix.~~ **[RESOLVED 2026-06-17 — fixed via 0019 `list_active_brand_ids()`; codified by durable rule `system-job-force-rls-enumeration`.]**
- ~~[RULE-PROPOSAL recommended — recurring pattern, 2nd occurrence] **Cross-tenant system/Argo jobs MUST enumerate tenants via a SECURITY DEFINER function ...** Act: `/adopt-rule` to codify.~~ **[SUPERSEDED → adopted 2026-06-17 as durable rule `system-job-force-rls-enumeration`.]**
- ~~[RULE-PROPOSAL — **3rd occurrence, auto-candidate bar CROSSED**] **System/cron/worker jobs MUST enumerate tenants via a SECURITY DEFINER fn ...** Act: `/adopt-rule system-job-force-rls-enumeration`.~~ **[ADOPTED 2026-06-17 by stakeholder → `.engineering-os/durable-rules/2026-06-17T09-59-08Z__system-job-force-rls-enumeration.md`.]**
- ~~[feat-connector-backfill / Stage-6 PASS] **APPROVE → Stakeholder gate, 0 blocking.** ... Act: accept + commit + advance at the Stage-7 gate.~~ **[SHIPPED 2026-06-17 (PR #31). Residual tracked debt remains open: SEC-BF-M2 (dual LedgerWriter, post-M1), SEC-BF-L1 (dual repo), DEV-TOKEN-REACH (live worker token reachability).]**

(no open items)
