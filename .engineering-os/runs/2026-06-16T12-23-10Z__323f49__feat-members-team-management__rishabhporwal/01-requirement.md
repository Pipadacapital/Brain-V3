# Requirement: Complete and harden the Members & Team Management surface

| Field | Value |
|-------|-------|
| **req_id** | `feat-members-team-management` |
| **Title** | Complete and harden the Members & Team Management surface |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T12:23:10Z |
| **Tier impact** | M1 teams/access scope (Functional Spec §1.4 + §2.5) |
| **Region impact** | None (control-plane; no RegionAdapter change) |

---

## Lane *(set by the Engineering Advisor at Stage 1)*

| Field | Value |
|-------|-------|
| **feature_class** | _(advisor to set — expected high-stakes)_ |
| **feature_class_rationale** | _(advisor)_ touches auth/session (revocation), RBAC/authorization, multi-tenant membership, PII (member email), audit |
| **trigger_surfaces_touched** | _(advisor to confirm)_ auth · multi-tenancy · pii · (audit) |

---

## Raw text (from the Stakeholder)

> Complete and harden the Members & Team Management surface to finish the M1 teams/access scope (Product Functional Spec §1.4 + §2.5).
>
> CURRENT STATE (scaffolded, ~80% built — completion+hardening slice, not greenfield):
> - Backend (apps/core/workspace-access): POST /api/v1/invites (createInvite), POST /api/v1/invites/accept (public, token-auth), GET /api/v1/members (listMembers), PATCH /api/v1/members/:id/role and DELETE /api/v1/members/:id — both already revoke the target's sessions in-transaction (AC-2/SD-3). RBAC hierarchy helper exists at workspace-access/internal/security/rbac.ts. AuthService.suspendUser() exists as a service capability but is NOT exposed via any member route or UI.
> - Frontend (apps/web): /settings/members page with MembersTable + InviteMemberDialog, an /invite/accept page + accept-invite-view, use-members hooks. The members-list envelope bug was just fixed (membersApi.list maps {members:[]} → PaginatedResponse.data), so the table renders.
> - The dev email-token helper (GET /api/v1/dev/last-email-link) captures invite links (type 'invite') so invite acceptance can be completed in the browser without an inbox.
>
> DELIVER (close the gaps):
> 1. Suspend / reactivate lifecycle (membership: Invited → Active → Suspended → Removed). Member-facing suspend action that IMMEDIATELY revokes the target's sessions (reuse the revoke-in-transaction pattern from updateMemberRole/removeMember; wire AuthService.suspendUser), plus reactivate (access restored on next protected action). Removing a member never destroys decision history; re-inviting a removed email creates a NEW membership.
> 2. Pending-invites visibility (the 'Invited' state). List invites not yet accepted (new list-pending route + UI section), with resend-invite and revoke-invite. Today only active memberships are listed.
> 3. Invitation-hierarchy enforcement on BOTH UI and backend: grant only roles at/below your authority — Owner > Brand Admin > Manager > Analyst; Owner invites anyone, Brand Admin invites Manager/Analyst, Manager/Analyst invite no one; you can only grant brands you manage.
> 4. Audit + immediate revocation non-negotiable: every invite/accept/role-change/suspend/remove is append-only audit-logged with actor + target + role; suspend/remove/role-change invalidate sessions instantly; access-adding changes apply on next protected action.
> 5. Real-browser (Playwright) e2e for the full lifecycle, using the dev email-token helper to accept invites in-browser: invite → pending appears → accept → member listed → change role → suspend (session revoked) → remove; and revoke a pending invite.

---

## Problem statement

The M1 teams/access surface (Functional Spec §1.4 membership lifecycle, §2.5 invitation hierarchy) is ~80% scaffolded but incomplete: there is no member-facing **suspend/reactivate** (only remove), no visibility of **pending (Invited) invites**, and **invitation-hierarchy** authority is not consistently enforced at the UI. A member-list rendering bug was just fixed. Without these, the lifecycle Invited → Active → Suspended → Removed is not expressible and an Owner/Brand-Admin can't fully manage their team.

## Target user

Owner / Brand Admin managing their workspace team (and Managers/Analysts as constrained actors). India DTC brand, M1.

## Success metric

Full membership lifecycle operable end-to-end from the UI (invite → accept → role change → suspend → remove + pending-invite resend/revoke), with immediate session revocation proven on suspend/remove/role-change, hierarchy enforced server-side, and a green Playwright e2e covering the lifecycle. Zero cross-brand/cross-org membership leakage (the ONE invariant).

## Constraints

- Absolute brand/tenant isolation holds — all member/invite reads/writes brand/org-scoped under RLS (the ONE invariant; cross-tenant leak = P0).
- `apps/web` + `apps/core/workspace-access` only. No new external dependency.
- Immediate revocation is non-negotiable (suspend/remove/role-change invalidate sessions instantly; revoke + membership write + audit atomic in one transaction).
- Audit is append-only and tamper-evident (existing hash-chain).
- MFA / Google one-tap / Authentik remain deferred per ADR-006 / D0.1.

## Non-goals

- MFA, Google one-tap, Authentik/OIDC (deferred).
- Cross-org invitation merging (signup always creates a new org; invitation is the only way into an existing org — already enforced).
- Notification-channel work beyond the existing email invite (the send/consent chokepoint is unchanged).

## Linked prior runs

- feat-access-onboarding-flow (membership/auth foundation, session revocation, rbac.ts)
- feat-m1-app-foundation (workspace-access module, audit hash-chain)

## Notes

- The members-list envelope fix + the dev email-token invite-link capture already landed on branch `feat/shopify-sync-validation` (commits `43ea557`, and the dev-token helper merged to master). The architect should branch the feature work from a base that includes the `membersApi.list` fix (current `feat/shopify-sync-validation` HEAD) or cherry-pick it, or the members table renders empty.
- Existing revocation pattern to reuse: `InviteService.updateMemberRole` / `removeMember` (revoke target sessions + membership write + audit in one txn, AC-2/SD-3). `AuthService.suspendUser` already revokes all sessions for a user.
- Dev gotcha (durable rule): dev DB connects as superuser `brain` which BYPASSES RLS — verify isolation claims under `SET ROLE brain_app` + the 3-GUC context, not just dev.
