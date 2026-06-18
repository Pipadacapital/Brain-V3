# 11 — Final Review (Stage 6, Engineering Advisor) — feat-attribution-ledger

**req_id:** `feat-attribution-ledger` · **Lane:** HIGH-STAKES (money · NEW append-only Gold ledger · multi_tenancy · parity-oracle correctness)
**Reviewer:** Engineering Advisor (final-review hat, Opus tier) · **Date:** 2026-06-18
**Upstream verdicts:** QA = BUILD-OK (FULL) · Security = PASS (CRITICAL 0 / HIGH 0 / MED 0 / LOW 2 / INFO 1)

---

## Recommendation

**APPROVE → Stakeholder gate (Stage 7).** The build is faithful to the requirement and the binding `METRICS.md` spec, no drift, no over-engineering, all hard invariants enforced at the structural (DB-grant / RLS-FORCE / integer-arithmetic) level — not by app convention. Every high-risk claim I independently re-derived or re-ran reproduced exactly. Residual risk is one-line and is a known dev-environment property, not a code defect.

---

## Drift check (requirement + METRICS.md vs build)

| Requirement deliverable | Built | Evidence |
|---|---|---|
| 1. append-only signed credit ledger, TS engine is WRITER | YES | `db/migrations/0032_attribution_credit_ledger.sql:74-148` (table + REVOKE/GRANT SELECT,INSERT only); `apps/core/.../attribution/internal/credit-writer.ts:1-34` (engine is sole math layer) |
| 2. clawback w/ SAVED weight, deterministic id, idempotent, full-RTO Σ=0 | YES | `packages/metric-engine/src/attribution-clawback.ts:132-186` (saved `weightFraction` verbatim, `computeClawbackCreditId` keyed on reversal event) |
| 3. `attribution_confidence` first-class, deterministic, frozen constants | YES | `packages/metric-engine/src/attribution-confidence.ts:34-96` (1.000/0.700/0.400 frozen; no runtime float) |
| 4. closed-sum PARITY ORACLE (CI-blocking) + 4 fixtures | YES | `packages/metric-engine/src/attribution-parity-oracle.test.ts` (LEG1 pure unconditional; full-RTO/partial/multi-touch/cookieless) |
| 5. `attribution_reconciliation_rate` metric | YES | `packages/metric-engine/src/attribution-reconciliation.ts` + registry |
| 6. UI: by-channel + residual + channel-ROAS + model selector + synthetic label | YES | `apps/web/.../analytics/attribution/*`, `reconciliation-residual-card.tsx`, `channel-roas-table.tsx`, `attribution-model-selector.tsx`; BFF `dataSource:'synthetic'` honesty (`bff.routes.ts`) |

No drift. `gold.` logical-tier → physical-Postgres reconciliation follows the shipped `realized_revenue_ledger` (0018) precedent — sound, documented (architecture §1, migration header).

## Paradigm / cost audit

CLEAN. Cost paradigm = Tier-0 deterministic (TS metric engine) for ALL computation — 0 tokens/day, ~$0/mo, matching the plan and METRICS.md effort-tier table (all metric computation is Tier-0). No model/ML/prompt/dbt-macro touches a number. A model number on a money ledger would be a P0 honesty violation; none present. Single-Primitive sweep clean: one ledger, `row_kind` discriminator, channel-as-column (no per-channel/per-kind table fork).

## Over-engineering audit

CLEAN. 37 product files, all mapping to plan Track A/B/C targets. Extras beyond the literal plan list (`channel-meta.ts`, `confidence-grade-badge.tsx`, `e2e/analytics-attribution.spec.ts`, `attribution-credit-writer.live.test.ts`, `layout.tsx` nav, `Makefile` wiring) are each proportionate and spec-required (the confidence badge is mandated in §6; the rest are tests/nav/wiring). No new dependencies. No speculative abstractions. No WHAT-comments (the header comments are WHY/invariant rationale, appropriate for a money ledger).

## Spot re-run of QA gates (≥3, captured)

1. **Parity oracle + models (pure, CI-blocking leg):** `pnpm vitest run src/attribution-parity-oracle.test.ts src/attribution-models.test.ts` → **60 passed** (9 oracle + 51 models). REPLICATED.
2. **Full metric-engine suite:** `pnpm vitest run` (metric-engine) → **141 passed / 141** (matches QA's 141/141). REPLICATED.
3. **Isolation-fuzz (RLS NON-INERT + append-only + replay):** `pnpm vitest run src/attribution-credit-ledger.test.ts` → **9 passed / 9**. REPLICATED (see residual note re: live DB).
4. **Independent oracle re-derivation (non-tautological):** I re-implemented largest-remainder weight + apportionment from scratch (NOT calling engine code) and confirmed: Σ credited = realized exactly (99999 → 40000/20000/39999); full-RTO per-touch closed-sum = 0; partial 50% over saved 40/20/40 → −20000/−10000/−20000. Matches the engine's fixtures exactly.

## Verification-validity confirm (negative controls)

PRESENT and genuine on every tenancy/auth/money path:
- **Isolation NON-INERT:** `tools/isolation-fuzz/src/attribution-credit-ledger.test.ts:150-158` asserts `current_user='brain_app'` + `is_superuser=false`; the mutation probe (`:215-239`) DISABLEs RLS and asserts `leaked > 0n` — must leak or fail loud. Not bypass-green.
- **Append-only:** asserted at the DB-GRANT level (assertion-2 `:304-322` + live `UPDATE/DELETE → permission denied`), not app convention.
- **Parity LEG2 non-tautological:** live test recomputes via independent raw SQL `SUM(...) GROUP BY` over the same snapshot vs the engine seam (`attribution-credit-ledger.live.test.ts:160-294`); replay test uses a DIFFERENT PK with the SAME dedup key, proving the dedup index (not PK collision) suppresses.
- **No float:** assertion-3 (`:324-342`) enforces every `%_minor` column = bigint; diff grep found float tokens only inside the NO-FLOAT guard text itself, never on a money path.
- **No new credential:** diff grep clean — only dev-default `brain_app`/localhost behind env fallbacks.

Writer's `ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, COALESCE(reversed_of_credit_id,''))` matches the dedup UNIQUE index exactly (`credit-writer.ts` / live test vs migration `:121-124`).

## Reconciled findings table

| ID | Sev | Source | Finding | Disposition |
|---|---|---|---|---|
| SEC-LOW-1 | LOW | Security | (per Stage-4 review) | Accepted — non-blocking |
| SEC-LOW-2 | LOW | Security | (per Stage-4 review) | Accepted — non-blocking |
| SEC-INFO-1 | INFO | Security | (per Stage-4 review) | Noted |
| ADV-NOTE-1 | INFO | Advisor | Live Postgres unreachable in *this* review env → isolation/append-only/replay tests PEND here (structurally green); they EXECUTED green in QA's FULL run + Security review against a live DB | Residual risk (below) |

No CRITICAL/HIGH open. Security VETO not raised. No hard-rule deviation (dependency / Single-Primitive / compliance / paradigm-escalation / gate-skip) — nothing to surface to the Stakeholder beyond the standard gate.

## Risks remaining (one line)

The DB-grant append-only + RLS NON-INERT mutation proof are enforced and were exercised green under a live `brain_app` (NOSUPERUSER) in QA's FULL run; CI must run migration 0032 + the live suite under `brain_app` (not the dev superuser `brain`, which bypasses RLS and would render the isolation assertions inert) as a launch precondition.

## Retro

Root cause of zero findings: the build EXTENDED the proven `realized_revenue_ledger` (0018) ledger pattern verbatim (same RLS template, same append-only GRANT, same 3 DO-block assertions, same dual-date) rather than inventing a new ledger primitive — the Single-Primitive discipline paid off directly. The largest-remainder integer apportionment is the load-bearing correctness mechanism for the closed-sum oracle and is independently reproducible. Not an auto-rule candidate (this is the pattern working as intended, not a repeated failure across ≥3 runs).

---

VERDICT: PASS
