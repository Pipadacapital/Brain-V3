---
req_id: feat-access-onboarding-flow
title: Access & Onboarding flow (registration, sign-in, 4-step onboarding, dashboard redirect)
submitted_by: rishabhporwal
submitted_at: 2026-06-15T21:18:00Z
status: cto-review
stage: 1
current_owner: cto-advisor
lineage:
  - feat-m1-app-foundation (shipped) — built initial app-native auth + workspace/brand onboarding; this requirement corrects/extends it to match the functional spec.
canon_conflicts_to_resolve_in_stage1:
  - "ADR-006 / D0.1: M1 auth is app-native (Authentik deferred). This spec names Authentik (OIDC), Google one-tap, MFA, Redis sessions, rotating refresh tokens — several were explicitly DEFERRED in M1. Stage 1 must scope what is in/out and flag any Canon amendment needed."
---

# Requirement: Access & Onboarding flow

## Stakeholder note
> "I tested few things and they are not as per my expectations as well as requirement."

This captures the COMPLETE Access & Onboarding flow for Brain, drawn from
`02_Brain_Product_Functional_Specification.md §1–2` and the
`06_Brain_API_Architecture_and_Contracts.md` contract. It supersedes the shipped M1
behavior where it diverges, and is the source of truth for registration → login →
onboarding → dashboard.

## raw_text

The end-to-end shape:

```
Landing → Sign up (Google one-tap OR email+password)
        → [email path] verify via single-use link
        → become sole Owner of a NEW organization
        → 4-step onboarding wizard
        → land in the product
```

One identity principle: **invitation is the only way into an existing org; signing up
always creates a brand-new org where you are the sole Owner. No path silently merges a
registration into someone else's org.**

### 1. Registration — §1.1
- Two methods: Google one-tap, or email+password.
- Google → email treated as verified; account+org+Owner created immediately; straight to onboarding.
- Email+password → account created **unverified**; a single-use verification link is emailed; the user cannot reach the product until verified.
- Rules: first registrant of a new org = its **sole Owner** (exactly one Owner per org, always); passwords never stored/shown/logged; one verified email = one identity that can belong to **multiple isolated orgs**.
- Edge cases: duplicate email → refuses, offers Sign in / Forgot password, leaks nothing; abandon-then-re-register → re-issues verification on the existing unverified record (no duplicate); two people registering the same brand → only the first is Owner, the second is routed to request an invitation; an already-invited teammate who clicks Sign up is guided to accept their invite instead.
- API: `POST /api/v1/auth/register` (public, idempotent) → `POST /api/v1/auth/email/verify` (verify token).

### 2. Sign-in, MFA, reset, sessions — §1.2
- Flow: Sign in (Google or email+password) → MFA if enabled → land in product (or resume point).
- MFA available to every account from day one.
- Failed login → generic "email or password is incorrect" (never says which); rate-limiting/lockout.
- Password reset → single-use, time-expiring magic link; neutral "if an account exists, we've sent a link" (no account-existence leak). Google-only accounts asking for reset are directed to Google.
- **Immediate revocation is non-negotiable:** removing/suspending a user, changing a role/permission, or revoking an integration invalidates affected sessions/tokens/keys **instantly**; an access-adding change applies on the next protected action.
- Edge cases: a user in multiple orgs is asked which to enter; "Remember me" extends on trusted devices but MFA still applies; lost second factor → backup codes or identity-verified audited recovery (never a permanent lockout).
- API: `POST /auth/login`, `/auth/mfa/verify` (partial-token), `/auth/token/refresh` (access JWT 15 min + rotating refresh 7 d), `/auth/logout?scope=all`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/revoke`. A revocation denylist is checked on every protected action.

### 3. The four-step onboarding wizard — §1.3
```
Step 1: Organization → Step 2: Brand → Step 3: Integration selection → Step 4: Done
                                        (connect now or "Skip For Now")
```
- No single integration is mandatory — a brand can finish onboarding with **zero connections** (lands in a guided empty state).
- Progress saved after every step — resume after a browser crash with data intact.
- Brand setup **hard-validates currency and timezone** (they drive every monetary and day-boundary metric) and sets a **default revenue definition** (Realized/Delivered recommended for COD-heavy India/GCC markets).
- **Pixel install is NOT part of onboarding** — it's done later in Tracking.
- Edge cases: OAuth failure leaves the source Disconnected with retry but doesn't block the wizard; a source that connects but returns zero data shows "no data yet," never a fabricated number; currency contradicting the region is allowed with a confirm prompt.

### 4. Account states, teams & invites — §1.4, §2.5
- Membership lifecycle: Invited → Active → (Suspended) → (Removed). Suspend/remove triggers immediate revocation; removing a teammate never destroys decision history.
- Invitation hierarchy: Owner invites Brand Admins (and may invite Managers/Analysts); a Brand Admin invites Managers/Analysts; Managers/Analysts invite no one. You can only grant brands you manage and roles at/below your authority.
- Four roles: Owner / Brand Admin / Manager / Analyst (a permission engine underneath; executive CEO/CMO/CFO views are lenses, not roles).
- Re-inviting a removed email creates a new membership.
- API: `POST /brands/{brandId}/members` (invite), `POST /invites/{token}/accept`, role/remove via PATCH/DELETE.

### What ties it together (the why)
- IdP: **Authentik (OIDC)** handles all of this; sessions live in **Redis**; email delivery powers verification/reset/invites.
- Tenant boundary: a **brand = workspace** is the unit of everything (currency, timezone, integrations, users, Decision Log, billing). The same human across brands has one login but separate, independent grants per brand — **isolation is absolute**.
- Everything is **audit-logged**: logins, role/permission changes, invites/removals — append-only and tamper-evident.

## Observed gaps vs M1 (Stakeholder tested)
The shipped M1 flow diverges from the above; the Stakeholder found it "not as per expectations
as well as requirement." Stage 1 (cto-advisor) must reconcile the spec against the sealed Canon
(app-native auth, Authentik/Google/MFA/Redis deferred in M1) and propose a scoped plan + any
required Canon amendments or child requirements before architecture.
