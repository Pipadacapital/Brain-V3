# Final Review — feat-analytics-api-dashboard

**Stage:** 6 (final review · VETO authority) · **Reviewer:** Engineering Advisor (Opus 4.8)
**req_id:** `feat-analytics-api-dashboard` · **Reviewed:** 2026-06-17T07:12:00Z
**Branch:** `feat/analytics-api-dashboard` · **HEAD:** `709cb2c` (QA-F-001 table-name fix)

## Recommendation: **APPROVE** → Stakeholder gate

**Blocking findings: 0.**

**One-line risk:** A semantically-invalid `as_of` (e.g. month=13) returns 500 instead of 400 (LOW-SEC-001, not exploitable, no leak) and the display formatter parses a bigint-derived decimal string through `Number()` for Intl rendering (QA-F-002, precision-safe within ~₹90T) — both tracked tech-debt, neither touches correctness of the reconciling number, isolation, or the honest empty state.

---

## What I verified independently (not on report faith)

This is the M1 finale — the reconciling realized_revenue number on screen, lane `high_stakes` (metric_engine · money · multi_tenancy). I spot-checked the code against every GO/NO-GO claim and re-ran three QA gates against the real database.

### Sole read path (ADR-002 / §9) — CONFIRMED
- Grep for `SUM(` / `.reduce(` / `sum` across `apps/web` card + formatter, the `analytics` module, and the BFF realized-revenue route: **zero executable hits** — all matches are comments or test-assertions naming the prohibition.
- `get-revenue-metrics.ts:92-95`: numbers come ONLY from `computeRealizedRevenue` / `computeProvisionalRevenue` (`@brain/metric-engine`). The ONLY additional SQL is the `EXISTS(finalized)` existence check (`:66-76`) — an existence signal, not a value computation (explicitly allowed by D-2/D-3).
- BFF route (`bff.routes.ts:1005-1011`) calls `getRevenueMetrics` and wraps in `{request_id, data}` — no ad-hoc query. Engine == API == screen holds.

### Honest empty state (§8) — CONFIRMED
- `get-revenue-metrics.ts:80-87`: `state:'no_data'` with `realized:null, provisional:null` is driven by the `EXISTS(finalized)` gate, NEVER inferred from the engine's `??'0'` value (the landmine at `realized-revenue.ts:71` is neutralized).
- Card (`realized-revenue-card.tsx:63-90`): the `state==='no_data'` branch renders `EmptyState` "No data yet" and NEVER a 0/fabricated number; `realized` is only read when `state==='has_data'`.

### Money discipline — CONFIRMED
- Minor units + `currency_code`, serialized bigint→string; per-currency `Record<ccy,string>`. Realized and provisional rendered in two distinct sibling `<div>` blocks (`realized-revenue-card.tsx:108-169`) with distinct labels ("Realized" / "Provisional / Settling — not yet confirmed") — no arithmetic between them, never summed.
- `formatMoneyDisplay` (`money-display.ts:38-71`): bigint integer division for the major/minor split; no `parseFloat`, no inline `/100` on the raw minor value. The `Number(decimalString)` at `:70` is display-only after a precision-safe decomposition (QA-F-002 — see risks).

### Isolation (the ONE invariant) — CONFIRMED under real RLS
- Brand from session (`bff.routes.ts:976` `auth.brandId`), never from body.
- `rawPgPool` threaded `main.ts:314` → `rawPool?: PgPool` `bff.routes.ts:66` → `{ pool: rawPool }` to the engine. Raw `pg.Pool`, NOT the `DbPool` wrapper → no double-GUC; **F-SEC-02 not regressed.** Reads run inside `withBrandTxn` (txn-scoped GUC).
- I re-ran the live suite against the real `postgres:16` container with `BRAIN_APP_DATABASE_URL`. `pg_roles` confirms `brain_app` = `rolsuper=f, rolbypassrls=f` (NOBYPASSRLS). The negative-control test asserts `current_user='brain_app'` + `is_superuser=false`, then proves a BRAND_B query never returns BRAND_A's value. **Genuine negative control** — would flip RED under the superuser (`brain` masks RLS).

### Envelope — CONFIRMED
- Client unwraps `.data` (`client.ts:757` `const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>`). Raw and mapped types declared separately. No 9th flat-shape mismatch. e2e test 4 (inherited-green) proves the shape over the real client path.

---

## Gates re-run by the final-reviewer (≥3, captured)

| Gate | Result | Evidence |
|---|---|---|
| `@brain/core` typecheck | PASS | `tsc --noEmit` EXIT 0, no output |
| `@brain/web` typecheck | PASS | `tsc --noEmit` EXIT 0, no output |
| `revenue-metrics.live.test.ts` (20 tests) under `brain_app` | PASS | **20/20** against real postgres:16; negative-control `current_user=brain_app` + cross-brand=no_data replicated; honest-empty (realized=null, not bare 0) + provisional-disjoint + sole-read-path grep all green |

**Inherited-green (could not stand up here):** the Playwright e2e (4/4, incl. test 2 rendering the real ₹1,234) needs a running Next.js + BFF + Postgres stack — not bootstrappable in this review environment. Its assertions ride the exact BFF→engine path my 20 live tests exercise; QA's DELTA full re-run captured all four green. Verification-validity confirmed: QA's `negative_control[]` carries the brain_app NOBYPASSRLS proof with a sound `confirmed_red_on_removal`; security carries 0 blocking.

---

## Over-engineering audit (engineering-discipline) — CLEAN

Delivered file set matches the plan's §2/§5/§6 named artifacts exactly: one analytics service + one domain type + index export + one BFF route block + one `main.ts` thread + one card + one client adapter + one hook + one display formatter + test files. No new service, package, queue, abstraction, or ADR. The single new formatter wraps the ONE `@brain/money` model (the `formatMoney` there is log-only) — not a duplicate money model. Plan length proportionate to a high_stakes money/tenancy finale. No WHAT-comments of concern. **No over-engineering finding.**

## Hard-rule deviation check — NONE

No dependency violation (all four blockers shipped), no Single-Primitive violation (extend-only sweep confirmed in code), no compliance gap, no paradigm escalation beyond plan (Tier-0 deterministic throughout — zero model calls verified), no un-codified gate-skip. No deferred item rises to a hard-rule trip.

## Drift check — NONE

All six requirement deliverables present and verified: Analytics API as sole read path, honest empty state, dashboard card, money discipline, per-brand isolation, automated tests. The M1 vertical spine is complete end-to-end (Bronze → identity → ledger → metric engine → Analytics API → dashboard).

---

## Risks remaining (tracked tech-debt — carried to Stakeholder)

| ID | Sev | What | Disposition |
|---|---|---|---|
| LOW-SEC-001 | LOW | Semantic `as_of` (e.g. `2026-13-01`) passes the regex; `new Date(...)`→Invalid Date→`.toISOString()` throws `RangeError` (`get-revenue-metrics.ts:61`)→500 not 400. | Open-deferred. Not a security defect: no PII, not exploitable, input already in the reject class. Fix = `isNaN(asOf.getTime())` guard before the call. Verified the path in code. |
| QA-F-002 | OBS (non-blocking) | `formatMoneyDisplay` uses `Number(decimalString)` for `Intl.NumberFormat` (`money-display.ts:70`). | Display-only, after bigint integer-division split; precision-safe within `Number.MAX_SAFE_INTEGER/100` (~₹90T). Satisfies D-7 (the ban is on `parseFloat`/`/100` of the raw minor value). No fix required. |
| F-SEC-02 | P2 (carried) | Old GUC-reset defense-in-depth on the legacy path; the new engine path is correct and not regressed here. | Carried must-fix-before-Phase-2 from prior runs. This feature uses the correct `withBrandTxn` raw-pool path — verified. |
| QA-3 (carried) | LOW | Carried QA observation from the metric-engine line. | Tracked. Non-blocking. |

## Retro

- **What went right:** the four invariants the plan front-loaded (honest-empty, sole-read-path, no-9th-envelope, isolation-under-brain_app) each landed with a RED-capable test; I replicated the live suite and the negative-control against the real role config. The Architect's pool-type binding (raw `pg.Pool`, not `DbPool`) prevented a double-GUC F-SEC-02 regression.
- **The one bounce that mattered:** QA-F-001 (e2e seed helper referenced the legacy table `app_user_org_membership` instead of `membership`) broke the real-number e2e; fixed in `709cb2c`, DELTA re-verified 4/4. Root cause = stale table name in a test fixture; **does not meet the ≥3-prior-occurrence threshold** (zero matches in lessons-learned) → **no rule-proposal written.**
- **Auto-candidate rule:** did not fire.
