# Pending Stakeholder Attention

> Items here require Stakeholder review. Agents add lines; the Stakeholder acts and strikes them through.
> Each line names the issue, the artifact path, and the slash command to act.

- [feat-realized-revenue-ledger / Stage-6 PASS] **F-SEC-01 (HIGH) conscious-accept** — `revenue-finalization` Argo job no-ops under `brain_app` FORCE-RLS brand enumeration (no provisional finalizes; fail-closed, recoverable, no M1 consumer). Ship-as-techdebt for M1, P1 must-fix before prod scale (SECURITY DEFINER enumeration fn / superuser-scoped pool). Artifact: `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/11-final-review.md` §4. Act: accept at the Stage-7 gate or bounce to fix.
- [RULE-PROPOSAL recommended — recurring pattern, 2nd occurrence] **Cross-tenant system/Argo jobs MUST enumerate tenants via a SECURITY DEFINER function or a dedicated superuser-scoped pool — never a bare `brain_app` SELECT on a FORCE-RLS tenant table.** Occurred in `feat-identity-graph` (`phone-guard-reeval.ts`, run c9a1a0 SR-01/QA-04) and now `feat-realized-revenue-ledger` (`revenue-finalization.ts`). Not yet codified; below the ≥3-run auto-write bar (this is #2) — surfaced for human decision. Act: `/adopt-rule` to codify (or wait for a 3rd occurrence to auto-trigger).
