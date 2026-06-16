# 11 — Final Review (Stage 6)
## feat-multi-brand — Create additional brands + active-brand switcher

**authored_at:** 2026-06-16T10:55:00Z
**authored_by:** engineering-advisor (final-review hat, Opus tier)
**req_id:** feat-multi-brand
**lane:** high_stakes · **trigger_surfaces:** auth, multi_tenancy
**bounce history:** 1 bounce (BOUNCE r1 — SEC-MB-1 HIGH + QA-1 HIGH + QA-2/QA-4) → fixed in commit `bcfee81` → DELTA PASS on both gates.

---

## Advisor recommendation: **APPROVE**

> **Residual risk:** The set-brand spine (migration 0013, `switchBrandContext`, the BFF route + brand-summary) is verified-live but still UNCOMMITTED in the working tree — the Stakeholder commit MUST include those paths (command in §7) or the feature ships incomplete; QA-3 (audit `correlation_id` column) and SEC-MB-4 (audit-after-mint, LOW) ship as tracked tech-debt with no isolation/auth impact.

This is an APPROVE-to-gate, not a deploy. The decision card reads the line above verbatim.

---

## §1 — Acceptance Criteria → Evidence

| AC / MA | Requirement | Evidence (independently confirmed unless noted) | Verdict |
|---|---|---|---|
| AC-1 / SD-1 | New `POST /api/v1/bff/session/set-brand`, membership-verified, distinct `brand.switch` audit, re-mint | Route present (`bff.routes.ts:366`, `sessionPreHandler`); `switchBrandContext` calls `mintSessionToken` directly; live test LIVE-SB-1 green (re-ran by me) | MET |
| AC-2 / MA-04 | Migration 0013 brand_self_read, fail-closed, workspace-GUC-scoped | `0013_brand_self_read.sql` present + applied; `pg_policies` shows `brand_self_read (SELECT)` live; NN-1 two-GUC DO-block; no-GUC → 0 rows (fuzz re-ran by me) | MET |
| AC-3 / MA-14/15 | Brand switcher in dashboard shell, org-scoped, single-brand shown, no-op guard | `brand-switcher.tsx` mounted in `(dashboard)/layout.tsx`; no-op guard at `:87`; data-testids stable. UI not exercised by Playwright (QA-5, INFO) | MET (UI test deferred to orchestrator suite) |
| AC-4 / MA-08 | Create-brand dialog, no onboarding misroute, Owner/Brand-Admin | `create-brand-dialog.tsx`; grep confirms no `CreateBrandForm`/`resolveOnboardingRoute`; stays on `/dashboard` | MET |
| AC-5 / SD-2 / MA-06 | Brand-summary reflects active brand (name, per-brand member count) | `active_brand_id: auth.brandId` at `bff.routes.ts:628`; member count `WHERE organization_id=$1 AND brand_id=$2` at `:615`; live smoke confirms `active_brand_id=B`, scoped count | MET |
| AC-6 / MA-07/13 | Docs: M1 invariant comment, findActiveByUser note | Comments present (`brand.service.ts`, `auth.service.ts` JSDoc) | MET |
| AC-7 / I-S01 | Isolation-fuzz: cross-brand read = 0 under NOBYPASSRLS | **Re-ran by me:** 11/11 PASS; brand-B → connector_instance(brand-A) = 0; negative-control policy_off=1/policy_on=0 row proves canary is real | MET |
| MA-01 | Direct mint, no refreshSession/resolveActiveContext/findActiveByUser | Method-body grep returns only the SEC *comment*, no live call; live LIVE-SB-1 role=analyst proves no findActiveByUser fallback | MET |
| MA-02 | workspaceId from JWT (both set-brand AND brand-create) | set-brand: `auth.workspaceId` passed (`:405`); brand-create: SEC-MB-1 fix → `organizationId: auth.workspaceId` (`brand.routes.ts:58`) | MET |
| MA-03 | Role from brand-level membership row | `context.role = row.roleCode` from 3-arg `findByUserAndOrg`; live: org-owner → brand-analyst returns `analyst` | MET |
| MA-05 / MA-09 / MA-10 / MA-11 / MA-12 | preHandler revocation, audit shape, archived guard, no-brandId-in-memberCtx, primary-node note | All confirmed in source + DELTA security PASS; live negatives (archived→400, non-member→403, revoked→401) | MET |

**No AC unmet.** The requirement — create additional brands + active-brand switcher, end-to-end, with absolute isolation — is delivered.

---

## §2 — The ONE invariant (I-S01, brand isolation): VERDICT = HOLDS, independently confirmed

The isolation spine is real, not asserted. I re-ran the proofs myself:

1. **Isolation-fuzz (AC-7):** `PG_USER=brain PG_PASSWORD=brain npx vitest run src/pg.test.ts` → **11/11 PASS**. brand-B session reading `connector_instance WHERE brand_id = A` returns **0 rows** under the `isofuzz_app` NOSUPERUSER NOBYPASSRLS role. The canary is non-inert: the bundled negative control disables RLS and observes `policy_off=1 row` (data exposed) vs `policy_on=0 rows` — proving the test would catch a regression, not pass green under bypass.
2. **MEMORY.md hazard handled:** the known "dev superuser `brain` masks RLS" trap is explicitly defeated — the fuzz creates and uses a dedicated NOBYPASSRLS role, so isolation is proven under prod-equivalent (`brain_app`) conditions.
3. **SEC-MB-1 fix (the body-spoof closure):** `brand.routes.ts:58` now sources `organizationId` from `auth.workspaceId` (JWT), not the body; `parsed.data.workspace_id` has no live readers (comment-only). Cross-org brand creation via body-spoofing is structurally impossible.
4. **0013 fail-closed RLS:** policy live in the running DB (`pg_policies`), two-arg `current_setting(..., TRUE)`, workspace-GUC-scoped, no-GUC → 0 brands.
5. **Layered enforcement:** RLS (0013 + brand_isolation 0004) + GUC-in-ctx discipline (MA-11, no brandId before authorization) + audit brand_id + JWT brand_id re-mint — each independently asserted. Consistent with canon I-S01 ("enforced at every layer independently").

---

## §3 — Both VETO gates genuinely cleared

| Gate | FULL | Fix | DELTA | Independently replicated by me |
|---|---|---|---|---|
| Security (Stage 4) | FAIL (SEC-MB-1 HIGH) | bcfee81 | **PASS, blocking:false** | SEC-MB-1 fix confirmed at `brand.routes.ts:58`; scope-creep check confirmed (no new endpoint/migration/secret) |
| QA (Stage 5) | FAIL (QA-1 HIGH) | bcfee81 | **PASS, blocking:false** | Re-ran switch-brand.live (4/4), critical-paths (22/22), isolation-fuzz (11/11) — all green |

The FAIL→fix→DELTA-PASS loop is legitimate: the fixes are committed (`bcfee81`), the re-reviews ran real tests against live Postgres, and both verdict JSONs declare `verdict: PASS`, `blocking: false`. Negative controls are present and non-inert in both artifacts (QA `negative_control[]` documents the protection-removed/red-output for 3 paths; security `evidence.test_validity` confirms the same). **Gate re-runs replicated — no bypass-green, no inert probe, no tautological parity.** (The original AC-7 tautology `>= 0` was itself caught and fixed to `> 0` — the gate worked.)

---

## §4 — Deferred items disposition

| ID | Sev | Item | Disposition | Rationale |
|---|---|---|---|---|
| **QA-3** | MED | `correlationId` not stored in `audit_log` (no column) | **SHIP AS TECH-DEBT** | The `brand.switch` audit row IS written (from/to/workspace/role_granted confirmed in live DB). The gap is only request-level correlation in the system-of-record, which needs a cross-service migration (`audit_log.correlation_id` + `AuditEntry` + `DbAuditWriter`) — correctly out-of-slice per change-control (no mid-bounce schema migration). `request_id` is in the HTTP response; correlationId flows at the GUC/log layer. No isolation, auth, or money impact. M1-shippable. |
| **SEC-MB-4** | LOW | Audit append AFTER mintSessionToken | **SHIP AS TECH-DEBT** | Current order is the SAFE one: if mint throws, no audit row AND no cookie update — no misleading entry. Risk is hypothetical (a future refactor reversing the order). A comment documents intent. No action required this release. |
| QA-5 / SEC (INFO) | INFO | Playwright E2E for switcher UI not run | Acceptable | No browser env this session; data-testids are stable and documented; the orchestrator Playwright suite is the contracted gate. UI is a presentation layer over a server-enforced security path. |

Neither deferred item touches the isolation spine. Both are safe to ship.

---

## §5 — Scope-creep / canon-violation audit

- **No new migration** beyond the planned 0013 (`git diff` of bounce: 0 changes in `db/`).
- **No new endpoint** beyond the planned `set-brand` (bounce diff touched only the brand-create fix).
- **No new secret** in production paths (test-only JWT literals in test files, pre-existing pattern).
- **STACK / ADR unchanged** (no STACK/ADR files in the diff; security DELTA confirmed). No new layer, no stack re-evaluation — correct per `engineering-discipline` Right-Sized Stack.

**Over-engineering audit (engineering-discipline §3):** CLEAN. The feature is one service method + one route + one migration + minimal UI. Single-Primitive: reuses `mintSessionToken`, `findByUserAndOrg`, `sessionPreHandler`, `DbAuditWriter`, `BrandRepository`, brand-summary as the list source — no new service, no per-brand fork, no second list endpoint, no abstraction-for-one-use. **Cost paradigm:** Tier-0 deterministic, 0 model calls — correct; any model involvement here would be a paradigm violation. No WHAT-comments observed in spot-check; comments are WHY/SEC-invariant anchors.

---

## §6 — Commit-hygiene finding (the one thing the Stakeholder MUST act on)

The committed history (`bcfee81`, `9b87621`) contains Track B (frontend) + the BOUNCE r1 fixes. But the **primary backend spine is still in the working tree, uncommitted**:

- `db/migrations/0013_brand_self_read.sql` — **untracked**
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — modified (set-brand route + brand-summary active_brand_id)
- `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` — modified (`switchBrandContext`)
- `apps/core/src/modules/workspace-access/internal/application/brand.service.ts` — modified (MA-07 comment)

This is NOT a code defect (the implementation is present, verified-live, and typechecks clean) — it is a release-hygiene gap. **It does not block APPROVE, but the Stakeholder commit step MUST stage these exact paths.** Mechanical command in §7 (explicit paths, no `git add -A`).

---

## §7 — Mechanical commit command (Stakeholder gate)

```bash
cd "/Users/rishabhporwal/Desktop/Brain V3"
git add \
  db/migrations/0013_brand_self_read.sql \
  apps/core/src/modules/frontend-api/internal/bff.routes.ts \
  apps/core/src/modules/workspace-access/internal/application/auth.service.ts \
  apps/core/src/modules/workspace-access/internal/application/brand.service.ts
git commit -m "feat(multi-brand): set-brand route + switchBrandContext + 0013 brand_self_read RLS (feat-multi-brand)"
```

> Run-artifact / journal / state files under `.engineering-os/` are committed by the orchestrator's own bookkeeping step — NOT part of the product-code commit above.

**Deploy ordering (do NOT execute — Stakeholder/`/approve` owns this):** migrate (0013) → core → web, per plan §6. 0013 must land before core ships or brand-summary returns 0 brands under `brain_app`.

---

## §8 — Remaining risk (the honest residual)

1. **Commit hygiene (the live one):** the spine must be staged from the working tree — §7 closes it. If skipped, the deploy ships frontend + fixes without the actual switch backend.
2. **UI not E2E-tested this session (INFO):** server-side security is fully proven; the switcher is presentation over an enforced path. Orchestrator Playwright suite is the standing gate.
3. **QA-3 tech-debt:** request-level audit correlation needs a follow-up migration. Tracked.
4. **Multi-org body-spoof family (watch-item, not blocking):** SEC-MB-1 (this run) and a `set-org` finding in `feat-access-onboarding-flow` (a7a965) are the same root-cause class — "tenant/workspace id sourced from body, not session JWT." That is **2 distinct runs**; the auto-candidate rule fires at ≥3, so no `rule-proposal` is written this run. Recorded in the retro as a watch-item for the Stakeholder; if a third recurs, codify "session-context fields (workspace_id/brand_id/org_id) are NEVER read from request bodies" as a durable rule.

---

## §9 — Final verdict

**APPROVE → hand to Stakeholder gate.** Requirement delivered end-to-end; the ONE invariant (I-S01) holds and was independently re-proven under NOBYPASSRLS; both VETO gates cleared with replicable evidence and live negative controls; no scope creep or canon violation; over-engineering audit clean; deferred items are genuinely M1-shippable tech-debt. The only action the gate must take is staging the uncommitted spine (§7).

No production blocker. State remains Stage 6 complete; owner → stakeholder.
