# 11 — Final Review (Stage 6 · Engineering Advisor) — feat-onboarding-website

**req_id:** `feat-onboarding-website` · **Lane:** high_stakes (multi_tenancy) · **HEAD:** `88697c8`
**Reviewer:** Engineering Advisor (final-reviewer, Opus) · **Date:** 2026-06-18
**Security verdict (upstream):** PASS — recommend APPROVE (0 CRITICAL / 0 HIGH / 0 MED / 1 LOW)

---

## Recommendation

**BOUNCE → Stage 3 (build — @frontend-web-developer, 1 small backend/web edit).**

The isolation invariant, the money/auth surface, and the build are sound; the bounce is **not** a security or correctness-of-isolation failure. It is a **Single-Primitive Rule violation** (hard-rule list) + an **over-engineering finding** that the architecture *explicitly named and forbade*, and which has **already produced a behavioral divergence** between the client preview and the server-authoritative normalizer. Per the Stage-6 charter an over-engineering finding bounces the named item; a Single-Primitive violation cannot be auto-waived.

The fix is mechanical and small (delete a duplicate util + its test, add `@brain/pixel-sdk` to `apps/web` deps, import the one primitive at two call sites). It does not touch the isolation spine, so the re-review is a delta on the named item + a regression check.

---

## What was independently verified (PASS)

### Gates re-run on this machine (captured)
| Gate | Result |
|---|---|
| `@brain/pixel-sdk` `vitest run src/normalize-host.test.ts` | **22/22 PASS** (replicated) — incl. `mailto:a@b.com → null` (the caught+fixed bug, line 26) + idempotence property |
| `apps/web` `vitest run lib/pixel/normalize-host-preview.test.ts` | 10/10 PASS (replicated) |
| `@brain/pixel-sdk` `tsc --noEmit` | EXIT 0 |
| `packages/contracts` `tsc --noEmit` | EXIT 0 |
| `apps/core` `tsc --noEmit` | EXIT 0 (the provision-seam + main.ts wiring + command/repo edits compile clean) |

### Isolation invariant — verified non-inert (source-read; live run by Security)
`provision-isolation.live.test.ts` is a genuine, non-inert tenancy proof:
- **INERT-TEST GUARD** (`:128-138`): `beforeAll` asserts `current_user='brain_app'` AND `is_superuser=false`, else throws — pointing it at superuser `brain` FAILS the suite (the captured negative control). Honors `dev-db-superuser-masks-rls`.
- **Cross-brand RLS (P1, `:180-181`):** under A's GUC → 1 row; under B's GUC → **0 rows** (non-inert, RLS isolates).
- **Bogus-token (P3, `:221-225`):** a never-issued token → `resolve_brand_by_install_token` returns **0 rows** (no wrong-brand leak).
- **Idempotency (P4)** + **edit-host-in-place (P5):** still exactly one row, **same `install_token`** (stable tenant key).
- No live psql/`brain_app` in this sandbox → I could not re-execute the DB suite myself; verified non-inertness at source and reconciled with Security's captured live PASS.

### Spine spot-verified at source (the high-risk claims)
- **Server-side brandId derivation (R2):** `brand.service.ts:158` `provisionPixel(brand.id, ...)` (create) and `:309` `provisionPixel(id, ...)` (update, path-resolved id) — never a client body field. P2's grep guard locks this.
- **Idempotent provision keeps the token:** `GetOrCreatePixelInstallationCommand` edit-in-place branch builds the updated entity with `installToken: existing.installToken`; repo `UPDATE ... SET target_host` keys on `id AND brand_id`. Same token, same row.
- **No migration:** additive doc-comment only on `brand.api.v1.ts:48`; reuses `UNIQUE(brand_id)` (0007:26) as the idempotency key per ADR-3. Confirmed.
- **Cost paradigm:** Tier-0 deterministic (string/URL normalization + an INSERT-or-return). Zero model calls. $0/mo. Matches the plan.

---

## The blocking finding

### F-ADV-01 — Single-Primitive violation + over-engineering: FE reimplements `normalizeBrandHost` instead of importing it (BLOCKING → BOUNCE)

The architecture (05 §32, Track B tasks 1 & 4) mandated the FE **import** `normalizeBrandHost` from `@brain/pixel-sdk` and explicitly stated this **"kills the duplicate normalization — Single-Primitive."** Instead the diff adds a **second, independent implementation** `apps/web/lib/pixel/normalize-host-preview.ts` (52 lines) + `normalize-host-preview.test.ts` (67 lines) and points `pixel-wizard.tsx:73` and `create-brand-form.tsx:85` at the duplicate.

- **It was avoidable.** `packages/pixel-sdk/src/normalize-host.ts` is pure (no `node:` imports, only the global `URL`) and the SDK is a browser-targeted package; core already imports it (`brand.service.ts:11`). The only thing missing was a `@brain/pixel-sdk` entry in `apps/web/package.json`. The implementer chose to reimplement rather than add the one-line dep + import the architecture named.
- **The duplication has already diverged (proven empirically).** For input `shop.com:8443` (bare host + explicit port): **server `normalizeBrandHost` → `"shop.com"`** (accepts), **FE `normalizeHostPreview` → `null`** (rejects). The FE file's own docstring claims it "mirrors the server algorithm … so the preview matches the persisted value" — that claim is now **false**. User-visible effect: a user typing `shop.com:8443` sees the FE preview say "no valid host" yet the server accepts and provisions `shop.com`. (Blast radius is cosmetic — the server is authoritative for the persisted value and provisioning/isolation remain correct — but it is exactly the drift class the Single-Primitive rule exists to prevent.)

**Fix (small, named):** add `"@brain/pixel-sdk": "workspace:*"` to `apps/web/package.json`; replace `normalizeHostPreview` imports at `pixel-wizard.tsx:17` and `create-brand-form.tsx:25` with `import { normalizeBrandHost } from '@brain/pixel-sdk'`; delete `normalize-host-preview.ts` + `.test.ts`. The shared idempotence/edge-case matrix already lives in `normalize-host.test.ts` (22/22).

---

## Reconciled findings table

| ID | Source | Sev | Disposition |
|---|---|---|---|
| F-ADV-01 | Advisor | BLOCKING | Single-Primitive violation + over-engineering — FE duplicates `normalizeBrandHost`; diverges on `shop.com:8443`. **BOUNCE → Stage 3.** |
| SEC-LOW-1 | Security | LOW | `install_token` logged at info via a pre-existing event-emit closure. Token is the public per-brand tag identifier embedded in the public `/pixel.js` snippet, not a confidential secret; not introduced by this diff. **Ship-as-tracked** (re-evaluate when the gate clears). |
| ADV-OBS-1 | Advisor | NON-BLOCKING | Track B task 5 asked for `create-brand-form.test.tsx` / `tracking-ready` component tests (REQUIRED pass-1). They do not exist; coverage was **relocated** to `e2e/onboarding-website.spec.ts` (asserts website→snippet, skip→honest add-website, no faked snippet, Tracking Center inline provision) — functionally equivalent or stronger. Plan-deviation-of-form, not substance. Note for the bounce: while the bounce is open, fold the two FE assertions into a component test, or record the e2e relocation in the plan. |

## Risks remaining (if the bounce were waived — for Stakeholder context only)
- **None on the isolation / token-derivation / money path.** Proven non-inert under `brain_app`.
- F-ADV-01's runtime blast radius is a cosmetic preview mismatch; the persisted/provisioned value is server-correct.
- SEC-LOW-1 (token at info log) — public identifier, pre-existing.

## Hard-rule / paradigm / negative-control checks
- **Negative-control validity:** PASS — `provision-isolation.live.test.ts` carries a real, captured negative control (INERT-TEST GUARD + cross-brand 0-rows + bogus-token 0-rows). Not bypass-green, not inert, not tautological.
- **Paradigm:** clean — Tier-0 deterministic, zero model calls, no escalation beyond plan.
- **Hard-rule:** **Single-Primitive Rule deviation present (F-ADV-01)** — on the hard-rule list; cannot auto-approve. No dependency-violation, no compliance gap, no un-codified gate-skip otherwise. Migration: none (additive doc-comment).

## Retro / recurrence
Root cause this run = a shared pure primitive was **reimplemented on the consuming side rather than imported**, because the consumer package lacked the workspace dep — and the two copies silently diverged. This is the inverse of the recurring "endpoint-shape-change → enumerate-and-repoint-all-consumers" watch theme but in the Single-Primitive family. **First occurrence of this precise mechanism** (duplicate-pure-util-instead-of-import) in the run series → below the ≥3-distinct-prior-runs auto-candidate threshold → **no `rule-proposals/` written**; logged as a watch-item. (The system-job-force-rls-enumeration rule already adopted is unrelated and not triggered here.)

## Auto-candidate rule
NOT fired (first occurrence; below ≥3 threshold). No `pending-stakeholder-attention.md` append from this run.

---

VERDICT: BOUNCE

**Bounce target:** Stage 3 (build) — @frontend-web-developer (with a one-line `apps/web/package.json` dep add). Fix F-ADV-01: replace the duplicate `normalizeHostPreview` with the mandated `@brain/pixel-sdk` `normalizeBrandHost` import at both call sites; delete the duplicate util + test. On return: delta-review F-ADV-01 + re-run the SDK/preview/tsc gates + the `brain_app` isolation suite as the regression check. No commit command issued (bounce, not PASS).
