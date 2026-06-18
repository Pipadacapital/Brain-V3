# Requirement: Onboarding UX improvements (registration → dashboard, customer-perspective)

| Field | Value |
|-------|-------|
| **req_id** | `feat-onboarding-ux` |
| **Title** | Reduce onboarding friction: auto-login, soft-gate email verification, merge workspace+brand, hide slug, forward-only wizard guard |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18T05:54:12Z |
| **Lane** | high_stakes (access/auth surface) |

## Why now

A customer-perspective review of registration → login → onboarding → dashboard surfaced
avoidable friction. These are the Stakeholder-approved fixes (2026-06-18). Builds on the
just-merged `feat-onboarding-website` (the website field + per-brand pixel provisioning
already exist on master — do NOT regress them).

## Deliverables (Stakeholder-approved scope)

1. **Auto-login after signup.** After a successful registration the user is authenticated
   immediately — no separate manual login step before onboarding. (Today register → /verify-email
   → manual /login.)
2. **Soft-gate email verification (Stakeholder decision 2026-06-18).** The user finishes
   onboarding and reaches the dashboard right after signup; show a **dismissible "verify your
   email" banner**; only **hard-block sensitive actions** until verified — connecting a real
   store, inviting members, billing. NOT a hard gate at the top of the funnel. (Today
   verification hard-blocks before onboarding.)
3. **Merge workspace + brand creation into one step** for the 1:1 case — don't make the user
   name a workspace AND a brand separately. One "create your brand/workspace" step that
   provisions both (workspace + its first brand) server-side. Keep the data model intact
   (org→brand); just collapse the UI.
4. **Hide the slug field.** Auto-derive the workspace slug server-side (it's an implementation
   detail); never show a slug input to the user.
5. **Forward-only wizard guard (live-test finding 2026-06-18).** Browser Back from a later step
   currently rewinds to /workspace/new and re-shows the already-created workspace form. Make the
   wizard forward-safe: either redirect completed steps forward (onboarding_status → next step)
   or make Back idempotent (no duplicate workspace/brand). Surfaced by the watchable E2E demo.
6. **General friction cuts** surfaced in the review (clear CTAs, no dead-ends, honest progress).

## Constraints

- **Do NOT regress `feat-onboarding-website`:** the website field + the per-brand
  `pixel_installation` auto-provision (via `@brain/pixel-sdk` `normalizeBrandHost`) must keep
  working through the merged workspace+brand step.
- Per-brand isolation + access control intact (RLS; verify under brain_app — superuser `brain`
  bypasses RLS so non-brain_app checks are INERT). Auto-login must issue a proper authenticated
  session (no auth bypass); soft-gate must STILL enforce verification on the sensitive actions
  server-side (the banner is UX; the gate is enforced in the BFF/core, not just hidden in UI).
- Additive migrations only (if any). No new deployable/topic/envelope.
- **Every build ships stakeholder-visible UI** (this slice IS the UI).

## Non-goals

- Multi-brand-per-workspace onboarding UI (1:1 for now; the merged step provisions one brand).
- Changing the auth/session mechanism beyond auto-login + the soft-gate enforcement points.
- The connector "Sync now" button (separate queued slice).

## Build tracks (the architect will bind)

@backend-developer (auto-login session issuance on register; the soft-gate enforcement points —
sensitive actions require verified email server-side; merged workspace+brand provisioning
command; auto-derive slug; forward-only onboarding_status routing) ∥ @frontend-web-developer
(the merged create step, the dismissible verify-email banner + sensitive-action gating UI, the
auto-login redirect, hidden slug, forward-only wizard, friction cuts). Verify access/isolation
under brain_app. Reuse the existing onboarding routes/components + the onboarding-website work.
