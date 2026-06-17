# Final Review (Stage 6) — fix/dev-token-reach

| Field | Value |
|---|---|
| **req_id** | `fix-dev-token-reach` |
| **stage** | 6 |
| **agent** | Engineering Advisor (final-reviewer) |
| **mode** | retroactive review of an already-committed branch |
| **reviewed_at** | 2026-06-17T16:30:00Z |
| **diff** | `git diff master...fix/dev-token-reach` — 16 files (+530/-76 incl. run artifacts; 12 product files +278/-52), migrations 0024+0025 |
| **recommendation** | **APPROVE** (PASS) |
| **blocking** | 0 |

---

## One-line risk

A dev-only secret seam + a NIL-uuid system-job GUC workaround + an honest analytics empty-state change, all proven on a real 19,476-row Boddactive backfill — safe to merge with four explicitly-tracked, non-blocking debts (none on the prod isolation/money path).

---

## Recommendation: APPROVE — merge with tracked debt

Both upstream gates PASS with 0 blocking after a single QA bounce that fixed the analytics test-contract gap (QA-DTR-B1) and added a non-inert negative control (QA-DTR-W1). I independently re-ran ≥3 gates at source, spot-checked every high-stakes file in the diff, and confirmed the one invariant (brand isolation) holds at every new query/UPSERT/UPDATE. The over-engineering audit is clean and no hard-rule deviation exists.

---

## Gates re-run at source (captured)

| # | Gate | Command (abridged) | Result |
|---|---|---|---|
| 1 | Analytics suite (the bounced gate) | `pnpm vitest run src/modules/analytics` (brain_app + brain URLs) | **21/21 PASS**, exit 0, 253ms |
| 2 | Validity / negative-control | `validity_check.py --paths .../analytics/tests --artifacts negative-control.json --require-negative-control` | **clean (1 file)**, exit 0 |
| 3 | Core typecheck | `pnpm --filter @brain/core typecheck` (`tsc --noEmit`) | **exit 0** |
| 4 | Stream-worker tsc (pre-existing-error confirm) | `pnpm exec tsc --noEmit \| grep "error TS"` | **3 errors**, all pre-existing (see below) |

All three QA PASS gates replicated independently. No gate I could not reproduce.

### Pre-existing stream-worker tsc errors — confirmed at source (not stash, structurally)
- 2× `TS2345` in `src/tests/backfill.e2e.test.ts:589-590` — **this file is not in the diff at all** (`git diff --name-only` count = 0). Cannot be branch-introduced.
- 1× `TS2307` in `worker-secrets.ts:41` — the require/`as typeof import(...)` dual-path line is **byte-identical on master** (`git show master:...` confirmed; the branch's diff to this file does not touch that line, grep count = 0). Pre-existing design issue (mismatched relative paths in the dual-path import), not a branch regression.
- QA's "branch adds zero new tsc errors" is confirmed by source, more strongly than the stash method.

> Note: the clean-worktree comparison I first attempted returned a false "0 errors" because the worktree had no `node_modules` (tsc not resolvable) — discarded as invalid; the name-only + `git show master` proof above is definitive.

## Source spot-checks (high-stakes surfaces)

- **NIL-uuid GUC trick (`run.ts:260-292`) — SAFE.** Confirmed: `BEGIN` → `set_config(app.current_brand_id=brandId, app.current_user_id=NIL, app.current_workspace_id=NIL, true)` → brand-scoped `SELECT … WHERE ci.id=$1 AND ci.brand_id=$2` → `COMMIT`, with `ROLLBACK` on error and `release()` in `finally`. The nil user/workspace makes `brand_self_read`'s membership subquery match nothing (no membership row has a nil user); `brand_isolation` (app.current_brand_id) is the sole grant; `connector_instance`/`connector_sync_status` have no self-read policy and are governed only by their brand_id isolation policy. No access widening. `brandId` originates from the SECURITY DEFINER enumeration fn (MT-1), never env/Shopify.
- **`dev_secret` (0024) + secrets managers — dev-only, prod-hard-fail intact.** Core `LocalSecretsManager` constructor throws if `NODE_ENV=production`; `main.ts:373-377` selects `AwsSecretsManager` when `isProduction` (LocalSecretsManager branch unreachable in prod). Worker `buildWorkerSecretsManager()` selects `AwsSecretsManager` in prod (KMS_KEY_ID required-or-throw); `WorkerLocalSecretsManager` (the dev_secret reader) is never instantiated in prod. Token carries explicit "NEVER logged (I-S09)" markers on every read/write; not in any API response, redirect, analytics query, or log. Migration is additive; `GRANT … TO brain_app` scoped to the dev table. dev_secret unreachable in prod. CONFIRMED.
- **UPSERT isolation — SAFE.** `connector_instance` `ON CONFLICT (brand_id, provider)` and `connector_sync_status` `ON CONFLICT (brand_id, connector_instance_id)` (new UNIQUE in 0025) both carry `brand_id` in the conflict key → a different brand cannot match the conflict target → no cross-brand overwrite. 0025's dedupe DELETE is intra-(brand_id, connector_instance_id) partition only; RLS/grants unchanged.
- **OAuth callback redirect (`main.ts:492-516`) — SAFE.** HMAC-first + state-nonce unchanged (validated inside the command before any token exchange). Both success and error redirect targets are the fixed server `config.appBaseUrl` (not request-derived) → no open-redirect. Query string carries only `?connected=<type>` / `?connect_error=<code>` from a closed enum — no token, secret_ref, brand_id, or PII. `marketplace-view.tsx` strips the param via `router.replace` after toasting.
- **Analytics change (`get-revenue-metrics.ts:60-86`) — honest.** EXISTS check broadened from `recognition_label='finalized'` to ANY ledger row, still inside `withBrandTxn` (RLS-scoped). Provisional surfaces; realized stays a true `{INR:'0'}` (engine output, never blended/floated); `no_data` now means zero rows of any kind. Engine remains the sole computation. Negative-control test (`revenue-metrics.live.test.ts:367-402`) verified non-inert: runs under `appPool` (brain_app), asserts `is_superuser=false` (defeats the dev-superuser-masks-RLS trap), sets GUC=BRAND_B, queries BRAND_A rows, asserts count=0 — goes RED if the RLS policy is dropped. Not tautological.
- **Live data proof (independently re-queried).** `realized_revenue_ledger` for brand `60d543dc-…`: 10,009 provisional + 9,467 finalized = 19,476 rows, all INR; `connector_sync_status.state = connected`. Matches QA.

## Over-engineering audit — CLEAN

- No new files beyond the fix surface; no new deployable (core+web+worker only).
- No new dependencies (`pg` already present); security dependency audit confirms none added.
- No new abstractions — no base classes, no registries, no premature generalization. The `since_id=0` fix, the disconnected-tile filter, and the toast surface are minimal.
- Comments are WHY-comments (the since_id stall bug, the NIL-uuid cast rationale, the disconnected-tile reasoning, the 0024/0025 migration intent) — no WHAT-comments.
- `force-dynamic` on the connectors page is a legitimate Next.js constraint of the new `useSearchParams` usage, not gold-plating.
- Surgical: each of the 8 commits maps 1:1 to a named defect; no drive-by refactoring or style drift.

## Verification-validity confirm

- QA negative-control `NC-DTR-A1` is populated, RED-captured, and non-tautological on the money/tenancy path (verified test body at source, not just the artifact JSON). Asserts non-superuser → non-vacuous.
- Security artifacts cite the analytic proof for the NIL-uuid path plus existing non-inert backfill negative controls (T4/T11 under brain_app).
- No bypass-green, no inert probe, no parity tautology observed.

## Hard-rule deviation check — NONE

No dependency violation, no Single-Primitive violation (one secrets seam extended, one analytics query, one sync-status writer), no compliance gap (I-S01/I-S02/I-S07/I-S09 all PASS per security compliance gate, re-spot-checked), no paradigm escalation (tier-0 deterministic; $0/mo model spend — this branch adds no model calls), no un-codified gate-skip. Auto-approvable under delegation.

## Cost paradigm audit

Tier-0 (deterministic) throughout: SQL UPSERTs/UPDATEs, an EXISTS check, secret table read/write, OAuth redirect. **$0/month model spend.** No effort-tier declaration needed (no model path introduced). Consistent with the connector/backfill paradigm.

---

## Risks remaining (tracked, non-blocking — safe to merge)

| ID | Sev | Item | Disposition |
|---|---|---|---|
| SEC-DTR-L1 | LOW | No dedicated NIL-uuid + brand_self_read negative-control test under brain_app (analytically safe; QA's analytics negative-control partially exercises the brain_app RLS-boundary pattern) | Add isolation-fuzz case next sprint. Accepted — analytic proof + partial coverage. |
| SEC-DTR-M1 | MED | `dev_secret.secret_value` stores a plaintext OAuth token in dev Postgres | Accepted dev-vault pattern (prod hard-fails). **Add a shared-dev-DB warning to the 0024 migration header before the pattern spreads.** |
| — | LOW | No connect→disconnect→reconnect lifecycle e2e and no real-pagination (since_id) cursor regression test | Acknowledged. Covered by the recommended follow-up suite (below). Live 10k-order proof + 35-test marketplace + 11-test backfill suites mitigate for now. |
| — | trivial | Stale `revenue-snapshot.ts` JSDoc ("state=no_data: zero finalized rows" — now "zero rows of any kind") | Comment-only; no test depends on it. Fix opportunistically. |
| — | LOW | Worker prod-safety on `WorkerLocalSecretsManager` is single-guard (selector-level only; no class-constructor hard-fail like core's `LocalSecretsManager`). Sound today because `buildWorkerSecretsManager` selects Aws in prod, but worth a belt-and-suspenders constructor guard. | Noted; non-blocking. Recommend a constructor `NODE_ENV==='production'` throw for symmetry. |

None of these sit on the prod isolation or money computation path. **Merge is safe with all four tracked.**

---

## Lessons-learned / recommended follow-up (RECOMMEND — not filed)

**Root cause (single, shared across all 8 fixes):** the connector-marketplace and connector-backfill slices were verified with **single-connect fixtures only** — they never exercised the connect→disconnect→reconnect *lifecycle* (which surfaced the reconnect 23505, the duplicate sync-status row, and the stale "error" tile) nor *real Shopify pagination/data* (which surfaced the `since_id=0` 499-of-10009 stall, the dev cross-process token reachability, and the provisional empty-state). Each of the 8 commits is a bug a fixture-shaped test could not have caught.

**Recommendation (I recommend; I do not file):**
1. **Lessons-learned entry** — "fixture-only connector tests miss lifecycle + real-data failure modes; high-stakes connector slices need a lifecycle + real-pagination regression gate."
2. **A follow-up requirement** — a connector **lifecycle + real-data regression suite**: connect→disconnect→reconnect (UPSERT + sync-status dedup + tile state), real-pagination cursor walk (since_id=0 → full set), and the SEC-DTR-L1 NIL-uuid negative control. This subsumes the two LOW lifecycle/pagination debts above.

**Auto-candidate rule:** NOT triggered. The ≥3-distinct-prior-run threshold for this specific root cause (fixture-only coverage missing lifecycle/real-data) is not met — this is the first run where it is the dominant root cause. (The already-adopted `system-job-force-rls-enumeration` rule is a *different* theme; this branch's NIL-uuid fix is downstream of that rule's exception, not a fresh occurrence.) No rule-proposal written; the human runs `/adopt-rule` only after the Stakeholder weighs the follow-up.

---

## Decision

**PASS → Stakeholder gate (Stage 7).** 0 blocking. I did NOT commit and did NOT advance the Stakeholder gate (per instruction). The orchestrator/Stakeholder weighs the four tracked debts + the recommended lifecycle-regression follow-up at the gate, then commits the explicit product-code paths.
