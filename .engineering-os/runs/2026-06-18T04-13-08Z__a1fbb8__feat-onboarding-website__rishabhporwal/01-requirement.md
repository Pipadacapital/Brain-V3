# Requirement: Onboarding captures the brand website → auto-provisions the per-brand pixel

| Field | Value |
|-------|-------|
| **req_id** | `feat-onboarding-website` |
| **Title** | Capture the brand website at onboarding as a first-class field → auto-provision the per-brand `pixel_installation` (token + target_host) → surface the install snippet in the Tracking Center |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18T04:13:08Z |
| **Lane** | high_stakes (multi_tenancy — pixel install_token is the per-brand tenant key) |
| **Model** | org→brand→website→pixel; **1 brand : 1 website for now** (Stakeholder-confirmed 2026-06-18) |

## Why now

The first-party pixel (Phase 1, shipped) derives `brand_id` server-side from a per-brand
`install_token` (migration 0028). But a brand only HAS a usable install_token if a
`pixel_installation` row exists — and today onboarding does **not** create one. The brand
form already has a `domain` field, but it is **optional and easily skipped** (e.g. live brand
`Sugandh lok` has an empty `brand.domain`), and even when filled it provisions **no**
`pixel_installation`. Result: a brand finishes onboarding with nowhere to install the pixel
and no install snippet to copy. This slice closes that gap.

## Current state (verified in code)

- `apps/web/components/onboarding/create-brand-form.tsx` — has a `domain` input, but submits
  `domain: data.domain || undefined` (optional, skippable). No website-shape validation beyond
  the existing zod rule.
- `brand.domain` (migration `0004_brand.sql:21`) — `TEXT NULL`, "pixel-verify target host".
- `pixel_installation` (migration `0007_pixel.sql`) — columns id, brand_id, install_token,
  target_host, installed_at. **Created today only by... nothing in the onboarding path.**
- `resolve_brand_by_install_token(uuid)` (0028, SECURITY DEFINER) — already the server-side
  derivation; it just needs a row to resolve to.

## Deliverables

1. **Website as a first-class onboarding field.** In the brand-creation step, the website is
   prominent and **strongly encouraged** (the Stakeholder soft-gates, doesn't hard-block:
   a brand may still "Skip for now," but the default path captures it). Validate + normalize to
   a canonical host (lowercase, strip scheme/path/trailing slash, punycode-safe) before persist.
   Persist to `brand.domain`.
2. **Auto-provision the per-brand `pixel_installation` on brand-create-with-website.** When a
   brand is created (or later edited) with a website, server-side: create exactly **one**
   `pixel_installation` (1:1) with a fresh `install_token` (uuid) and `target_host` = the
   normalized host — idempotent (a brand never gets two rows for the same host; re-submitting
   the same host is a no-op). The token is server-generated, never client-supplied. If the
   brand skipped the website, no row is created yet (the Tracking Center can provision later).
3. **Surface it (MANDATORY — stakeholder-visible UI).** Two surfaces:
   - **Onboarding:** after the brand+website step, show a short "your tracking is ready" state
     with the install snippet (the `/pixel.js` tag carrying the install_token) for *this* brand's
     site + a "verify" affordance — or an honest "add your website to start tracking" if skipped.
   - **Tracking Center (`/settings/pixel`):** show the brand's website (`target_host`), the
     install snippet, and the install/verification status. If no `pixel_installation` exists yet
     (website skipped), offer an inline "add website → provision pixel" action.

## Constraints

- **Per-brand isolation (THE invariant):** the `install_token` is the per-brand tenant key —
  the server DERIVES `brand_id` from it and NEVER trusts a client-sent brand_id (R2 fix, already
  shipped). Provisioning runs under the brand's own RLS scope; verify under `brain_app`
  (the dev superuser `brain` BYPASSES RLS — any isolation check not under brain_app is INERT).
- **Additive migration only** (if any). `pixel_installation` already exists; this slice likely
  needs **no schema change** — only a provisioning command + a uniqueness guard
  (one active row per (brand_id, target_host)). If a partial unique index is needed for
  idempotency, it is additive.
- **1:1 brand:website for now.** The schema already supports 1:N later (multiple
  `pixel_installation` per brand); do NOT build the multi-site UI — just don't preclude it.
- Website normalization must be deterministic + tested (the same site typed three ways →
  one canonical host → one token).
- No new deployable/topic/envelope. Reuse the existing collector `/pixel.js` asset route and
  the Tracking Center surface shipped in Phase 1.

## Non-goals (follow-on)

- Multiple websites per brand (1:N storefronts) — schema-ready, deferred.
- DNS/A-record stable ingress for the pixel (separate platform follow-up).
- Deep install-verification heuristics (match-rate/coverage score) — Tracking Center follow-up.
- The broader Onboarding UX slice (auto-login, soft-gate email verify, merge workspace+brand,
  hide slug) — that is a SEPARATE queued slice.

## Build tracks (the architect will bind)

@backend-developer (the brand-website normalization + the idempotent `pixel_installation`
auto-provision command + uniqueness guard, server-side token generation, isolation under
brain_app) ∥ @frontend-web-developer (the first-class website field in the brand step + the
onboarding "tracking ready / add website" state + the Tracking Center website+snippet surface).
Verify isolation under brain_app; reuse the Phase-1 pixel-asset route + `/settings/pixel`.
