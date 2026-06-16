# 11 — Final Review (Engineering Advisor, Stage 6)

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 6 — Final Review (last gate before Stakeholder) |
| **Reviewer** | Engineering Advisor (final-review hat, Opus) |
| **Reviewed** | 2026-06-16T20:40:00Z |
| **Recommendation** | **APPROVE** → Stakeholder gate |
| **Verdict** | **PASS** |
| **Blocking** | none |

> **Decision-card residual risk (one line):** SEC-V1 (two NC assertion queries) and F-QA-4 (audit `correlation_id` column) remain backlog tech-debt — neither is a runtime data-leak or auth-bypass path; cross-org isolation and suspend-revocation are independently wire-proven under `brain_app`.

---

## 1. Requirement delivered — membership lifecycle operable end-to-end

The lifecycle Invited → Active → Suspended → Removed is now fully expressible. AC → evidence:

| Acceptance criterion | Evidence (spot-verified, not trusted from report) |
|---|---|
| **Invite** (hierarchy-bounded) | `createInvite` D-6 bound read at `invite.service.ts:97-100`: `ROLE_HIERARCHY.indexOf(granted) >= indexOf(actor) → 403`, owner exempt. Actor role from DB (`memberRepo.findByUserAndOrg`), not JWT. |
| **Accept** | `acceptInvite` raw-txn path with duplicate-membership pre-check → 409 + `23505` mapping (D-10). |
| **Role change** (hierarchy-bounded) | D-7 bound inside open txn with ROLLBACK-before-throw (verified in security review + UNIT-D7). |
| **Suspend** (immediate revoke, atomic, authority-checked) | `suspendUser` read at `auth.service.ts:766-868`: single rawPgPool `BEGIN/COMMIT` wrapping session-revoke CTE + `app_user.status='suspended'`; actor+target from DB; explicit owner block + hierarchy guard; D-9 org assertion; audit post-COMMIT `brand_id: brandId ?? organizationId`. |
| **Reactivate** | `reactivateUser` read at `auth.service.ts:875-953`: structurally distinct (D-1), single `status='active'` write, NO session revoke, distinct `user.reactivated` audit. |
| **Remove** (history preserved) | Existing `removeMember` DELETE; decision history survives in append-only `audit_log`; re-invite of removed email = new membership. |
| **Pending visibility + resend + revoke** | `listPendingInvites` (D-4 predicate + D-11 ctx), `resendInvite` (rotateToken, no second row, D-3), `revokeInvite` (GUC pool, RLS). |
| **e2e proves it** | Playwright `members-lifecycle.spec.ts` 4/4 standalone: invite → pending appears → accept → listed → role change → suspend → reactivate → remove + revoke-pending. D-11 false-negative guard active (asserts non-zero pending rows). |

**Verdict: delivered.** No drift from the requirement; success metric (full lifecycle from UI + immediate revocation + hierarchy server-side + green e2e + zero cross-tenant leak) is met.

## 2. The security spine is real (spot-verified by reading code)

- **LIVE privilege escalation CLOSED.** brand_admin→brand_admin invite now returns HTTP 403 — proven on the wire by WIRE-2 (`app.inject POST /api/v1/invites` brand_admin token → 403 FORBIDDEN; owner control → 201, non-tautological; removing the guard yields 201). Source bound confirmed at `invite.service.ts:97-100`.
- **Suspend atomic.** One rawPgPool `BEGIN/COMMIT` wraps both writes (`auth.service.ts:822-839`) — the two-commit re-login window (C-3) is eliminated. Authority enforced in-service from DB membership (C-4); D-9 org assertion present (`:804-808`); audit `brand_id` correct (H-1 fixed, `:842-859`).
- **Isolation holds.** NC-1/NC-2/NC-3 run under `SET LOCAL ROLE brain_app` (real RLS semantics); WIRE-3 proves the pending-list is org-scoped on the wire under `brain_app` (org-A session, org-B invite absent from JSON, removing GUC scoping fails the test). This addresses the dev-superuser-masks-RLS durable rule directly.
- **Re-run replicated:** `cd apps/core && DATABASE_URL=… npx vitest run src/modules/workspace-access/tests` → **69/69 pass, 6 files** (matches the QA delta verdict exactly; 3 wire tests executed, not skipped).

## 3. Both gates cleared legitimately

- **Security: PASS, 0 blocking.** Independent code inspection closed all 5 CRITICALs (C-1..C-5) + 3 HIGHs (H-1..H-3) + 2 MEDs (M-1/M-2). Two open findings are MED/LOW test-hygiene/dead-path.
- **QA: FAIL → fix → DELTA PASS — a real fix, not a wave-through.** The bounce vetoed 3 missing HTTP wire-smoke tests (F-QA-1/2/3). Fix commit `fcbc221` is **test-only** (2 files: new `member-wire-smoke.live.test.ts` +553, dev-report +8 — confirmed by `git show --stat`); prior 66 tests stayed green; 3 new wire tests added that are **non-inert** (WIRE-1 read at `:366` — live session, 200-before control, real `suspendUser`, 401 SESSION_REVOKED after; removing the session guard yields 200 and the test fails). The QA `negative_control[]` array carries captured RED evidence for all three. Legitimate bounce-and-fix.

## 4. Deferred-item dispositions

| ID | Sev | Disposition | Rationale |
|---|---|---|---|
| **SEC-V1** | MED | **ship-as-techdebt — effectively resolved** | The functional claim (suspend revokes the session, enforced on the next protected call) is now covered end-to-end by WIRE-1 (live HTTP 401 SESSION_REVOKED under a real session). The residual is purely that two NC-4/NC-5 *assertion queries* read `app_user`/`user_session` under the superuser pool — but `app_user` has RLS disabled and `user_session` RLS is keyed by `app.current_user_id`, not org, so cross-org isolation (the ONE invariant) is unaffected and is independently proven by NC-1/2/3 + WIRE-3 under `brain_app`. Backlog: tighten the two assertion queries to `brain_app`. **Not a runtime risk.** |
| **SEC-V2** | LOW | **ship-as-techdebt** | `resolveMembership` optional-rawPgPool null fallback is unreachable in prod (`main.ts` passes rawPgPool unconditionally); the fallback degrades to a 404, which is still safe. |
| **F-QA-4** | MED | **ship-as-techdebt** | `audit_log` has no `correlation_id` column — pre-existing house schema, needs a migration, out of this contract's scope. `request_id` is in route envelopes; `correlationId` threads through service calls. Track as M1 audit-observability improvement. |
| **F-QA-5** | LOW | **ship-as-techdebt** | Full-suite e2e rate-limiter exhaustion (>10 registers/hr/IP) is a pre-existing test-infra limitation (confirmed by pre-Track-B stash run). Target spec passes 4/4 standalone. Track as CI test-user-pool work. |

No deferred item must-fix before ship; none touches the security spine.

## 5. Scope creep / canon

- **No scope creep.** Diff (`git diff feat/shopify-sync-validation..HEAD --stat`) is confined to `apps/core/workspace-access`, `apps/web` (members surface + e2e + session-role hook), `packages/contracts`, `db/migrations/0014`, and run artifacts. `full-journey.spec.ts` (+113) and `use-session-role.ts` (+49) are in-lane Track-B frontend additions (commit 8f89cfa / 85d0fa8), not unrelated drive-by changes.
- **No new ADR / stack layer / external dependency / secret.** Reuses the existing revocation primitive, `rbac.ts` hierarchy helper, audit writer, notification path. MFA/OIDC stay deferred.
- **Migration 0014 additive (I-E02).** Three `CREATE INDEX IF NOT EXISTS` + pre-flight `RAISE EXCEPTION` dup guards; index-only `down`; zero data impact.
- **Branch base includes 43ea557** — `git merge-base --is-ancestor 43ea557 HEAD` → true (members-table envelope fix present; e2e renders a non-empty table).
- **Cost paradigm: Tier 0 deterministic** — 0 model calls, $0/mo. RBAC is array-index comparison; revocation is SQL UPDATE; isolation is RLS + app-layer assertion. Correct routing; no model-in-a-costume.
- **Single-Primitive: clean** — no second suspend mechanism (no `membership.status` column); `app_user.status` is the sole source of truth.

## 6. Over-engineering audit

PASS. No files/observability/deps/abstractions beyond the plan. No `setUserStatus(flag)` shared helper (D-1 honored). No WHAT-comments in the spot-checked code (comments are WHY/binding-ref). Plan length proportionate to a high-stakes auth/multi-tenancy/audit slice.

## 7. Verification-validity + hard-rule check

- **Negative controls present + non-empty** on the tenancy/auth/money paths: QA `negative_control[]` carries captured RED evidence (WIRE-1/2/3 protections-removed proofs); security review documents NC-1..6 + isolation-fuzz kill-the-policy proof (0→>0). No bypass-green, no inert probe, no tautological parity.
- **Hard-rule deviation check: clean.** No dependency violation, no Single-Primitive violation, no compliance gap, no paradigm escalation beyond plan, no un-codified gate-skip. Nothing requires Stakeholder-only sign-off beyond the normal deploy gate.

## 8. Bounce history

| Stage | Verdict | Detail |
|---|---|---|
| 4 Security | PASS (0 blocking) | All 5 CRITICAL + 3 HIGH closed; SEC-V1 MED, SEC-V2 LOW deferred. |
| 5 QA (r1) | **FAIL → BOUNCE** | 3 VETO: missing HTTP wire-smoke for suspend→401, brand_admin→403, pending-list org-scope. |
| 5 QA (delta) | **PASS** | Fix `fcbc221` test-only; 3 non-inert wire tests added; 69/69 green; no regression. |
| 6 Final | **PASS → APPROVE** | This review. |

## 9. Retro (condensed)

- **What worked:** intake's persona-driven CRITICAL enumeration (C-1..C-5) mapped 1:1 to architect bindings (D-6..D-11) and to backend acceptance items — zero drift between stages. The dev-superuser-masks-RLS durable rule was honored end-to-end (NC tests under `brain_app`, WIRE-3 cross-org HTTP).
- **What the QA bounce caught:** DB/service-layer proofs (NC-4/5, UNIT-D6) are necessary but not sufficient for a "revokes on the wire" / "403 on the wire" claim. The bounce correctly demanded `app.inject` HTTP assertions. This is a recurring pattern (DB-row proof mistaken for wire proof) — see auto-candidate note below.
- **Auto-candidate rule check:** "wire-level assertion required for auth/isolation claims, not just a DB-row or service-throw proof" — this is the root cause of the r1 bounce. It does not yet meet the ≥3-distinct-prior-runs threshold from the recall available in this run, so **no rule-proposal is auto-written**; flagged here for the Stakeholder to weigh whether to seed it.

## 10. Build sanity

- `pnpm --filter @brain/core typecheck` → **EXIT 0**
- `pnpm --filter @brain/web typecheck` → **EXIT 0**

---

## Recommendation

**APPROVE → Stakeholder gate.** The membership lifecycle is operable end-to-end, the live privilege-escalation hole is closed and wire-tested, suspend is atomic + authority-checked, isolation holds under `brain_app`, both gates cleared legitimately (the QA bounce was a real test-only fix), and the four deferred items are all shippable tech-debt with no security-spine impact. No hard-rule deviation; no scope creep; Tier-0 cost. State advances to `awaiting-stakeholder` (this hat does NOT advance to deploy).

## Mechanical commit command (Stakeholder runs at the gate — explicit product-code paths, no `git add -A`)

```bash
cd "/Users/rishabhporwal/Desktop/Brain V3"
git add \
  apps/core/src/main.ts \
  apps/core/src/modules/workspace-access/internal/application/auth.service.ts \
  apps/core/src/modules/workspace-access/internal/application/invite.service.ts \
  apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts \
  apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts \
  apps/core/src/modules/workspace-access/tests/member-lifecycle.live.test.ts \
  apps/core/src/modules/workspace-access/tests/member-wire-smoke.live.test.ts \
  db/migrations/0014_member_lifecycle.sql \
  packages/contracts/src/api/member.api.v1.ts \
  packages/contracts/src/index.ts \
  apps/web/app/\(dashboard\)/settings/members/page.tsx \
  apps/web/components/members/invite-member-dialog.tsx \
  apps/web/components/members/members-page-client.tsx \
  apps/web/components/members/members-table.tsx \
  apps/web/components/members/pending-invites-section.tsx \
  apps/web/e2e/full-journey.spec.ts \
  apps/web/e2e/helpers/onboard.ts \
  apps/web/e2e/members-lifecycle.spec.ts \
  apps/web/lib/api/client.ts \
  apps/web/lib/api/types.ts \
  apps/web/lib/hooks/use-members.ts \
  apps/web/lib/hooks/use-session-role.ts \
  apps/web/playwright.config.ts
# commit on branch feat/members-team-management (already the working branch)
```

> Deploy ordering invariant (architect §8): migration 0014 → core → web. Slice 1 (escalation fix) is independently deployable. `down` for 0014 is index-drop only.
