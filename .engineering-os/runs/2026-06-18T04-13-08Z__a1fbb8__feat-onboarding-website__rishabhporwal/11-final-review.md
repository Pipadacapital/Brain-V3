# 11 — Final Review (Stage 6 · Engineering Advisor) — feat-onboarding-website

**req_id:** `feat-onboarding-website` · **Lane:** high_stakes (multi_tenancy) · **HEAD:** `22ca3b8`
**Reviewer:** Engineering Advisor (final-reviewer, Opus) · **Date:** 2026-06-18 · **Review type:** DELTA (post-bounce)
**Security verdict (upstream):** PASS — recommend APPROVE (0 CRITICAL / 0 HIGH / 0 MED / 1 LOW)

---

## Recommendation

**APPROVE → Stakeholder gate (Stage 7).**

The single blocking finding from the prior review (F-ADV-01, Single-Primitive Rule violation) is **RESOLVED at HEAD `22ca3b8`**, verified by re-run (not trust). The fix is FE-import-only: it deletes the duplicate normalizer, repoints both call sites at the canonical `@brain/pixel-sdk` primitive, and adds the workspace dep. It does not touch the server/db/RLS spine, so the isolation invariant and the prior Security PASS carry forward unchanged.

---

## F-ADV-01 — RESOLVED (delta re-verification at HEAD `22ca3b8`, all commands re-run)

The prior bounce: the FE reimplemented `normalizeBrandHost` as a divergent duplicate (`apps/web/lib/pixel/normalize-host-preview.ts`), which empirically diverged from the canonical (`shop.com:8443` → server `"shop.com"` vs FE `null`). Single-Primitive violation. Fixed as follows — each item re-verified:

| # | Check | Result (re-run at HEAD `22ca3b8`) |
|---|---|---|
| 1 | **Duplicate is gone** | `ls apps/web/lib/pixel/normalize-host-preview.ts` → **No such file** (deleted). `git grep normalizeHostPreview` → **no matches in src** (only this run-dir's prior-bounce record + journal mention it as history). `find apps/web -name 'normalize-host-preview*'` → none. |
| 2 | **Both FE call sites import the canonical** | `create-brand-form.tsx:25` → `import { normalizeBrandHost } from '@brain/pixel-sdk'`; used at `:85`. `pixel-wizard.tsx:17` → same import; used at `:73`. Both from `@brain/pixel-sdk` — no local duplicate. |
| 3 | **`apps/web` depends on `@brain/pixel-sdk` + symlink resolves** | `apps/web/package.json:15` → `"@brain/pixel-sdk": "workspace:*"`. Symlink `apps/web/node_modules/@brain/pixel-sdk → ../../../../packages/pixel-sdk` resolves to the real package (`name: "@brain/pixel-sdk"`); `normalizeBrandHost` is exported from `packages/pixel-sdk/src/index.ts:15`. |
| 4 | **No drift possible now (same function) + gates green** | Both call sites now call the **one** canonical implementation — divergence is structurally impossible. `@brain/web tsc --noEmit` → **EXIT 0**. `@brain/web vitest run` → **9/9 PASS**. `@brain/pixel-sdk vitest run` → **34/34 PASS** (incl. `normalize-host.test.ts` 22/22, the shared idempotence/edge-case matrix). |
| 5 | **Isolation invariant untouched** | Fix commit `22ca3b8` `--stat`: only `create-brand-form.tsx` (+/-4), `pixel-wizard.tsx` (+/-4), delete of `normalize-host-preview.{ts,test.ts}`, `apps/web/package.json` (+1 dep), `pnpm-lock.yaml`, + run/journal artifacts. **No server / db / sql / rls file touched.** The `brain_app` `provision-isolation.live` suite remains the authority (verified non-inert in the prior review: INERT-TEST GUARD asserts `brain_app` + `NOT is_superuser`; cross-brand → 0 rows; bogus-token → 0 rows). An FE-import-only diff cannot regress it. |

---

## Reconciled with the prior Security PASS

Security PASSED upstream: **0 CRITICAL / 0 HIGH / 0 MED / 1 LOW**. This delta is FE-import-only and introduces no new server surface, so the Security verdict carries forward intact. No new auth/money/tenancy path was added or modified.

## Residual risk

| ID | Source | Sev | Disposition |
|---|---|---|---|
| SEC-LOW-1 | Security | LOW | `install_token` logged at info via a **pre-existing** event-emit closure. Token is the public per-brand tag identifier embedded in the public `/pixel.js` snippet, **not a confidential secret**; **not introduced by this diff**. Ship-as-tracked. |

No finding on the isolation / token-derivation / money path. The sole residual is the pre-existing public-`install_token`-at-info LOW, which this run neither introduced nor touched.

## Hard-rule / paradigm / negative-control checks
- **Negative-control validity:** PASS — `provision-isolation.live.test.ts` carries a real, captured negative control (INERT-TEST GUARD + cross-brand 0-rows + bogus-token 0-rows). Not bypass-green, not inert, not tautological. Untouched by this delta.
- **Paradigm:** clean — Tier-0 deterministic (string/URL normalization + INSERT-or-return), zero model calls, $0/mo, no escalation beyond plan.
- **Hard-rule:** **CLEAR.** The Single-Primitive violation (F-ADV-01) that previously blocked auto-approval is resolved — the FE now imports the one canonical primitive. No dependency violation, no compliance gap, no paradigm escalation, no un-codified gate-skip. Migration: none (additive doc-comment only).
- **Over-engineering:** CLEAR — the duplicate util + test (119 lines) that were the prior over-engineering finding are deleted; net change is a reduction.

## Retro / recurrence
Root cause (now fixed): a shared pure primitive was reimplemented on the consuming side rather than imported, because the consumer package lacked the workspace dep — and the two copies silently diverged. **First occurrence** of this precise mechanism (duplicate-pure-util-instead-of-import) in the run series → below the ≥3-distinct-prior-runs auto-candidate threshold → **no `rule-proposals/` written**; logged as a watch-item. The fix (add the workspace dep + import the canonical) is the correct closure and validates the Single-Primitive gate caught real drift before ship.

## Auto-candidate rule
NOT fired (first occurrence; below ≥3 threshold). No `pending-stakeholder-attention.md` append from this run.

---

VERDICT: PASS

**Next:** Stakeholder gate (Stage 7). F-ADV-01 RESOLVED at HEAD `22ca3b8` (delta-verified, commands re-run). Reconciled with the prior Security PASS (0 CRIT/HIGH/MED, 1 LOW). Residual risk = the pre-existing public-`install_token`-at-info-log LOW, not introduced here. The mechanical commit is owned by the Stakeholder gate; product-code paths in this run: `apps/web/components/onboarding/create-brand-form.tsx`, `apps/web/components/pixel/pixel-wizard.tsx`, `apps/web/package.json`, `pnpm-lock.yaml` (plus the prior-slice `88697c8` product files). No `git push` from this stage.
