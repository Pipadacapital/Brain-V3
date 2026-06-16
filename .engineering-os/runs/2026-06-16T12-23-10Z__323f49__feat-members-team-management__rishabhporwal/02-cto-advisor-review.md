# Stage 1 — Engineering Advisor Review

| Field | Value |
|-------|-------|
| **req_id** | `feat-members-team-management` |
| **Reviewed at** | 2026-06-16T12:25:00Z |
| **Reviewer** | Engineering Advisor (cto-advisor), intake hat |
| **Decision** | ADVANCE (with 2 personas) |
| **Lane** | high_stakes |

---

## 1. Lane Validation

The orchestrator's deterministic scan flagged: `auth · multi_tenancy · outbound_channel · pii`.

Lane scan **confirmed with one addition**:

| Surface | Present? | Evidence in this requirement |
|---|---|---|
| `auth` | YES | Session revocation on suspend/remove/role-change; invite-token auth (POST /invites/accept is public, token-auth) |
| `multi_tenancy` | YES | All member/invite reads/writes must be brand/org-scoped under RLS; cross-brand membership leak = P0 |
| `outbound_channel` | YES | Invite email delivery; resend-invite triggers a new outbound email |
| `pii` | YES | Member email addresses carried in invite payloads and the pending-invites list |
| `system_of_record_audit` | **ADDED** | Every invite/accept/role-change/suspend/remove must append to the hash-chained audit log (TRIGGER-SURFACES.md "System-of-record / audit-log writes" — the set of audited actions explicitly includes "role/permission/team changes") |

**feature_class: high_stakes — confirmed.** Five trigger surfaces, not four. The `system_of_record_audit` surface is added because this slice explicitly requires appending to the hash-chained WORM-anchored audit trail for every membership lifecycle event. The orchestrator must carry this addition forward.

---

## 2. Dependency Pre-flight

Required predecessors per `active.json`:
- `feat-access-onboarding-flow` — **shipped** (stage 8). The rbac.ts hierarchy helper, in-transaction session revocation pattern, and the audit hash-chain foundation all landed here.
- `feat-m1-app-foundation` — **shipped** (stage 8). workspace-access module, audit hash-chain (L-02 closed — sha256 is live), three-GUC session context.

No blocked dependency. No `proposed_children[].blocks` check needed — this requirement names dependencies, not proposed children. Proceed.

---

## 3. "Make It Less Dumb" — What Can Be Simplified or Deferred

**Keep everything, but tighten scope on one item:**

- Suspend/reactivate, pending-invites, and invitation-hierarchy enforcement are all genuine M1 gaps that block the lifecycle from being expressible in the UI. None is deferrable without breaking the success metric.
- The Playwright e2e covering the full lifecycle is the right verification shape for a surface this complex — not optional.
- One scoping note: "reactivate (access restored on next protected action)" must be explicitly distinguished from "re-invite". Reactivating a Suspended member restores their existing membership; re-inviting a Removed member creates a NEW row. The requirement states this correctly, but the Architect must ensure the schema and service layer make this a hard structural distinction, not a soft field-update path. No simplification possible here — both paths must exist and must be distinct.

---

## 4. Challenge Findings — The Real Risks in This Slice

### CF-01 (CRITICAL) — Suspend/Remove Must Revoke Sessions Atomically — No Two-Phase Window
**The invariant:** The existing `removeMember` + `updateMemberRole` patterns already do revoke-in-transaction. `AuthService.suspendUser()` exists but is NOT wired into any member route. This means a suspend action today would write the membership state change without revoking sessions — leaving a window where a suspended user's valid JWT still passes the `validateSession` preHandler.

**The risk:** A suspended user retains access until their session naturally expires or they make another request that re-validates. On a high_stakes surface (access control), this is CRITICAL.

**What the Architect must bind:** Wire `AuthService.suspendUser()` into the suspend member route using the SAME in-transaction pattern as `removeMember` (revoke sessions + membership write + audit in one txn). The reuse pattern is already there — this is a wiring gap, not a design gap. Verify under `SET ROLE brain_app` that session rows show `revoked_at IS NOT NULL` immediately after the suspend call.

### CF-02 (CRITICAL) — Invitation Hierarchy Must Be Enforced Server-Side — UI Gating Is Not Enough
**The invariant:** The requirement states "grant only roles at/below your authority" and "enforced on BOTH UI and backend." The rbac.ts hierarchy helper exists. However, the current requirement does not specify whether the hierarchy check on the backend is a contract-gated Zod-validated input or a raw runtime assertion.

**The risk:** A Manager who crafts a direct HTTP POST to `/api/v1/invites` with `role: 'brand_admin'` in the body can privilege-escalate if the server-side enforcement is absent or incomplete. UI-only gating on a user-accessible endpoint is a security control that provides zero protection. Additionally, "you can only grant brands you manage" introduces a brand-scope check orthogonal to the role hierarchy — a Manager inviting someone to a brand they don't manage is a multi-tenancy violation, not just an RBAC violation.

**What the Architect must bind:** 
- The `createInvite` handler must (a) resolve the actor's role from the JWT/session (not from the request body), (b) assert via `rbac.ts` that `actorRole >= grantedRole`, and (c) assert that the actor's `brand_id` set includes the target `brand_id`. All three checks must happen server-side before the invite row is written. A failure in any check returns 403, not a database error.
- The Zod contract in `packages/contracts` must NOT accept `role: 'owner'` from a non-Owner actor — but runtime enforcement in the handler is the real gate (Zod validates shape, not authority).
- This check must be explicitly covered in the Playwright e2e: a Manager attempting to invite a Brand Admin must receive a 403.

### CF-03 (HIGH) — RLS Isolation Under brain_app, Not Superuser — the Dev-Superuser-Masking Trap
**The invariant from lessons + requirement:** The dev DB connects as superuser `brain`, which bypasses RLS. This has been a persistent risk across prior runs (feat-access-onboarding-flow NN-7 — invite compound PERMISSIVE RLS; feat-multi-brand — brand_self_read RLS gap was a P0 blocker).

**The risk for this slice:** The members/invites tables have `brand_id`-scoped RLS. In dev (as superuser), all member/invite queries appear to work correctly across any brand because RLS is bypassed. The actual enforcement is only tested when running as `brain_app`. If the Playwright e2e runs against a dev DB as superuser, cross-brand membership leakage would not be caught.

**What the Architect must bind:**
- All RLS-relevant tests (cross-brand member/invite reads, pending-invite visibility) must execute under `SET ROLE brain_app` with the three-GUC context set — not as superuser.
- A negative control: a query for members/invites under a brand_id the session does not own must return zero rows, not the wrong brand's data.
- The isolation-fuzz CI gate (already required per INVARIANTS I-S01) must include the members/invites tables.

### CF-04 (HIGH) — Re-invite a Removed Email Must Create a NEW Membership Row — No Resurrection
**The risk:** If the `createInvite` handler first checks for an existing (soft-deleted or status='removed') membership and resurfaces it, the old membership row's grants, role, and audit chain survive. This is a "ghost access" vulnerability: an actor who was removed, possibly for cause, re-enters the system carrying their prior permissions without a clean audit trail entry.

**What the Architect must bind:** The `createInvite` handler (and any "re-invite" path) must INSERT a new membership row, not UPDATE status on an old one. The old row stays in the table (audit requires no destructive migration per I-E02) with status='removed'. The new invite has a fresh `invited_at`, a new token, and a clean role grant. This must be enforced in the service layer, not just documented. A UNIQUE constraint on `(brand_id, user_email, status='active')` is safer than relying on application logic alone — the Architect should evaluate this at schema design time.

### CF-05 (HIGH) — Pending-Invite Revoke Must Actually Invalidate the Token
**The risk:** If revoke-invite only sets `invite.status='revoked'` in the DB but the existing token (already delivered via email) remains valid, an attacker who retained the original invite email can still call `POST /api/v1/invites/accept` with the old token and gain access. Token invalidation requires the `accept` endpoint to check the invite's current status before processing, and it requires the token itself to be single-use (consumed on accept) or time-bounded.

**What the Architect must bind:**
- The `accept` endpoint must verify `invite.status = 'pending'` before accepting — not just that the token matches.
- If token-revocation is implemented by setting `invite.status='revoked'`, the accept handler must reject tokens belonging to any non-pending invite.
- The Playwright e2e must include a test: revoke a pending invite, then attempt to use the original token — the accept must fail with a 410/403.
- Related: the `resend-invite` path should invalidate the old token (or reuse the same row with a refreshed token + expiry) to prevent two simultaneous valid tokens for the same invite.

### CF-06 (MEDIUM) — Audit Surface Expansion Hits the sha256 Hash-Chain — Verify sha256 Is Live Before Writing
**The context:** L-02 (audit sha256 deferral) was CLOSED in `feat-m1-app-foundation`. The journal confirms "sha256 hash-chain in audit (not djb2)" is live. However, this is the first production slice that will write actual membership lifecycle events to the audit log in anger — invite, accept, role-change, suspend, remove.

**The risk:** If anything in the audit write path for membership events diverges from the chain writer (e.g., a different code path that appends without calling `packages/audit`'s chain writer), those rows will have a stub or broken hash. Since the chain is verified quarterly, a divergent path might not surface for weeks.

**What the Architect must bind:** Every membership lifecycle action must go through the same `packages/audit` chain writer used by other audited actions. No direct `audit_log` INSERT bypassing the package. Add a spot-check in the Playwright e2e or a unit test that reads back the audit rows for a lifecycle sequence and verifies the hash chain is unbroken for those rows.

### CF-07 (MEDIUM) — Pending-Invites Visibility Route Is a New RLS Surface
**The risk:** The new "list-pending" route lists invites not yet accepted. If this route queries the `invite` table without the same RLS enforcement as the existing member list, it can either (a) return another brand's pending invites or (b) return pending invites the actor is not authorized to see (e.g., a Manager seeing Owner-tier invites for their brand).

**What the Architect must bind:** The pending-invites list route must be scoped by the same RLS policy + GUC context as the existing `listMembers` route. Additionally, consider whether a Manager-role actor should see pending invites they did not create, or only their own. The requirement does not specify this — the Architect must bind this decision.

---

## 5. Underspecified Decisions the Architect Must Bind

| Decision | Why it matters |
|---|---|
| **D-1: Reactivate mechanism** | Is reactivation a PATCH on the membership row (status: suspended → active) or a new invite? Must not create a new row — that is re-invite, not reactivate. The service layer must distinguish these two paths at the code level. |
| **D-2: Brand-scope check in invitation hierarchy** | "You can only grant brands you manage" — what is the data model? Does a Manager's JWT carry the list of brand_ids they manage, or does the server re-query the membership table? The latter is safer (JWT can be stale). |
| **D-3: Resend-invite token behavior** | Does resend create a new token (invalidating the old one) or extend the expiry of the existing token? Dual valid tokens for the same invite slot is a security risk. |
| **D-4: Pending-invite visibility permission** | Can a Manager see pending invites they did not send? Can a Brand Admin see Manager-tier pending invites? The requirement is silent — the Architect must define and enforce this. |
| **D-5: Branch base for this feature** | Requirement notes the `membersApi.list` envelope fix is on `feat/shopify-sync-validation`. The Architect must confirm the branch base includes that commit (43ea557) or cherry-pick it. An empty members table is not a failure mode during development — it is a false negative in the Playwright e2e. |

---

## 6. Persona Specifications

Two personas for the high_stakes lane — the sharpest pair for an RBAC/membership surface:

### Persona 1 — Authorization & Privilege-Escalation Abuser (:sonnet)
**Name:** "The RBAC Boundary Prober"
**Archetype:** A Manager-role actor who probes every server-side route with crafted HTTP requests to attempt privilege escalation: invite Brand-Admin-tier users, grant Owner roles, read pending invites across brands, and reactivate removed members by replaying old session tokens.
**Concerns to surface:**
- Can a Manager POST to `/api/v1/invites` with `role: 'brand_admin'` and succeed?
- Does the `accept` endpoint validate that the invite token is still pending, or just that the token exists?
- Is the actor's authority resolved from the JWT (server-authoritative) or from the request body (attacker-controlled)?
- Can a revoked invite token still be accepted?
- Does the reactivate path require the same authority as the original invite, or is there a lower-friction path that bypasses the hierarchy check?
- Does the pending-invites list route enforce brand isolation, or does it list all pending invites in the DB if the RLS GUC is missing?

### Persona 2 — Tenancy & Session-Revocation Skeptic (:sonnet)
**Name:** "The Isolation and Revocation Auditor"
**Archetype:** A security auditor who probes session revocation timing, cross-brand membership leakage under RLS, and the atomicity of the suspend/remove/revoke transaction. Focuses on what happens in race conditions and on the dev-superuser-masks-RLS trap.
**Concerns to surface:**
- After suspend is called, how quickly is the existing session invalidated? Does `validateSession` preHandler check `revoked_at IS NOT NULL` in the same request, or is there a cache window?
- Is the revoke-in-transaction pattern (revoke sessions + membership write + audit) truly atomic for suspend, or does suspend call `AuthService.suspendUser()` outside the transaction boundary?
- Under `SET ROLE brain_app` (not superuser), does a query for another brand's members/invites return zero rows?
- Does the pending-invites list return only the current brand's invites, even if the GUC is not set (NN-1 negative control: should return zero rows, not another brand's data)?
- Is the invite token stored as a sha256 hash (per I-S09 — secrets never plaintext in DB) or as plaintext? A plaintext invite token in the DB is a secrets invariant concern.

---

## 7. Decision

**ADVANCE with 2 personas.**

This is a genuine M1 gap: the lifecycle is not expressible without suspend/reactivate, pending-invite visibility, and consistent hierarchy enforcement. The problem statement, target user, and success metric are all concrete and verifiable. The requirement does not introduce new infrastructure, does not open a new Canon conflict, and does not require Stakeholder escalation.

The challenge findings (CF-01 through CF-05 are CRITICAL/HIGH) are all implementation-level: the design approach is sound (reuse the existing revocation pattern; reuse rbac.ts), the gaps are in wiring and edge-case enforcement. These are exactly the kind of concerns the two personas should pressure-test before the Architect commits to a spec.

No KILL or CHALLENGE-BACK triggers are met: the requirement has a clear problem statement, a named user, a concrete success metric, and is aligned with the Product Canon's M1 scope. The cost paradigm is Tier 0 (deterministic — no model calls anywhere in this slice). The anti-blind triggers (Single-Primitive, large-model-for-small-problem, region assumption, compliance ambiguity) are all clean.

Audit sha256 note: L-02 is confirmed closed in feat-m1-app-foundation. The Architect must confirm this before wiring new audit writes.
