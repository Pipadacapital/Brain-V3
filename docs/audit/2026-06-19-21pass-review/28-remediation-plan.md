# Prioritized Remediation Plan (docs/audit)

> Synthesized from the adversarially-verified findings of the 21-pass principal audit. Every item below cites a real `file:line` proven during the audit. Ordering is by **production-blocking criticality first, then dependency sequencing** — not by raw severity label. A "High" maintainability finding that does not block deploy sits below a "Medium" finding that does.
>
> **Headline verdict:** No verified finding is a live cross-tenant data leak or active production incident. The repo is **NOT production-deployable today** — but the blockers are *infrastructure-as-code gaps* (no Dockerfiles, no Helm charts, ArgoCD points at nonexistent paths, no Argo scheduler manifests), not application correctness defects. The application-layer findings are overwhelmingly **dead/inert CI guards** and **bounded-context stubs** (Identity, Billing, Recommendation control-planes absent). Fixing the 4 P0 IaC/scheduler items unblocks deploy; the inert ESLint fences (ARC-1/ARC-2/RS-1) are the highest-leverage P1 because they are the only line of defense for the tenant-isolation seam and are silently passing CI.

---

## Legend & gating

- **P0 — blocks production deploy.** Cannot ship without it; pipeline physically cannot deliver, or a scheduled job that the revenue/finalization loop depends on cannot run.
- **P1 — immediate, pre-GA.** Not a hard deploy blocker, but ships a known correctness/isolation/feature gap into prod. Must land before first paying tenant.
- **P2 — near-term, tracked.** Maintainability, dependency hygiene, phase-marker debt. Schedule within the next 1–2 sprints.
- **P3 — backlog.** Cosmetic / low-blast-radius; track but do not gate.

Effort: **S** ≤ ½ day · **M** ≈ 1–3 days · **L** ≈ 1–2 weeks · **XL** > 2 weeks / multi-person.

---

## P0 — Blocks production deploy (do these first, in this order)

### P0-1 · Create Dockerfiles + Helm charts; un-skip container security scans
- **Findings:** ARC-8
- **Evidence:** `infra/helm/` contains only `README.md` + empty `charts/`; `infra/argocd/envs/prod/core.yaml:13` references `path: infra/helm/core` (does not exist); `find apps/ -name Dockerfile` returns nothing; `.github/workflows/pr.yml:134,142,146` — Trivy/OSV scan step is gated on an affected-set `jq` that falls back to empty string and silently sets `skip=true`.
- **Fix:** (1) Minimal multi-stage Dockerfiles for `apps/collector`, `apps/core`, `apps/stream-worker`, `apps/web`. (2) Helm chart skeletons under `infra/helm/{collector,core,stream-worker}/`. (3) Replace the affected-set fallback in `pr.yml` with an explicit `test -f Dockerfile` existence guard so a missing Dockerfile *fails* the scan step instead of skipping it.
- **Effort:** L
- **Dependencies / sequencing:** None — this is the root blocker. Everything else in CD is downstream. Do first.
- **Acceptance check:** `argocd app sync core-staging` reaches `Synced/Healthy`; `pr.yml` Trivy/OSV steps execute (non-skipped) on a PR touching any app and report at least one scanned image.

### P0-2 · Author Argo CronWorkflow manifests for all scheduled jobs (incl. parity-convergence monitor)
- **Findings:** ARC-6
- **Evidence:** `infra/argocd/README.md:1` promises "Argo Workflow specs"; `grep -l CronWorkflow` across `infra/**/*.yaml` returns nothing; `apps/stream-worker/src/jobs/revenue-finalization.ts:29` says "Usage: … via Argo CronJob"; `docs/requirements/04_…Delivery_Plan.md:347` mandates an hourly runtime convergence monitor as an Argo job. No Argo Workflows Helm chart in `infra/helm/`.
- **Fix:** Create `infra/argo-workflows/` with CronWorkflow manifests for: `revenue-finalization` (nightly), `dbt-build` (off-peak), `parity-convergence-monitor` (hourly — layers 2+3 of the parity oracle, currently *entirely absent*), `retention-erasure` (daily), `dq-freshness-check` (hourly). Add the Argo Workflows Helm chart + an ArgoCD Application for the workflows namespace.
- **Effort:** M
- **Dependencies / sequencing:** Requires **P0-1** (Helm/ArgoCD wiring must exist first). Sequence after P0-1.
- **Acceptance check:** `realized_revenue_ledger` shows `recognition_label='finalized'` rows advancing per active brand after a nightly run; the parity-convergence monitor emits a metric at least hourly (alert if absent > 2h).

> **Why these two are P0 and the "High"-labelled ESLint findings are not:** Without P0-1/P0-2 the GitOps pipeline cannot deliver a single service and recognized revenue never leaves provisional state for *any* brand. The inert fences (next section) are dangerous but the codebase currently *happens* to apply the correct brand predicate, so they are pre-GA hardening, not deploy blockers.

---

## P1 — Immediate, pre-GA (correctness, isolation seam, and core-feature gaps)

### P1-1 · Repair the metric-engine boundary fence — it is structurally inert; 9 files bypass it undetected
- **Findings:** RS-1 (root cause), ARC-2 (the bypasses + missing resolver)
- **Evidence:** `eslint.config.mjs:54-99` — the `app` descriptor (`apps/*`, line 56) is declared **before** `core-module` (`apps/core/src/modules/*`, line 58); `@boundaries/elements@1.2.0` matches descriptors in declaration order and breaks on first match, so *every* `apps/core/**` file classifies as `app`, never `core-module`, making the `from:['core-module',{module:'!(measurement|analytics)'}]` fence unsatisfiable. Confirmed: `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` exits 0 with the rule active. There is also **no `@brain/*` import resolver** wired (only `eslint-import-resolver-node`), so the alias cannot map to `packages/metric-engine` regardless. 9 production files in `ai`/`attribution`/`data-quality`/`frontend-api` import `@brain/metric-engine` (e.g. `credit-writer.ts:34-35`, `ai/prompt-registry/resolver-prompt.ts:13`, `data-quality/.../get-metric-trust.ts:14-15`, `bff.routes.ts:79-82`).
- **Fix:** (1) Reorder element descriptors so `core-module` precedes `app` (or restrict `app` to `apps/*/src/main.ts`). (2) Add `eslint-import-resolver-typescript` and wire it to `eslint-plugin-boundaries` so `@brain/*` aliases resolve. (3) Verify the fence now fires on `credit-writer.ts`; then resolve the 9 violations by either routing through `analytics`/`measurement` or adding an explicit ADR-justified allow-list entry per module.
- **Effort:** M
- **Dependencies / sequencing:** None; can run in parallel with P0. **This is the single highest-leverage P1** — it is the CI backstop for the brand-scoped `withBrandTxn`/`withSilverBrand` isolation seam and is currently a no-op.
- **Acceptance check:** `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` exits non-zero with a `boundaries/element-types` error before the violations are allow-listed; `describeElement(credit-writer.ts)` returns `type: 'core-module'` while `main.ts` stays `app`.

### P1-2 · Route attribution's direct StarRocks read through the Analytics API (ADR-002)
- **Findings:** ARC-2
- **Evidence:** `apps/core/src/modules/attribution/internal/credit-writer.ts:34-35,160-167` issues a direct `SELECT` on `brain_silver.silver_touchpoint` via `withSilverBrand`, outside the Analytics API; `AttributionCreditWriter`/`createAttributionReversalHook` are exported from `attribution/index.ts:46-48` and ready to wire.
- **Fix:** Move the touchpoint read behind the `analytics` module's read API so the query joins the single isolation-fuzz surface and OTel span. Add a test asserting every StarRocks connection is acquired through the analytics pool factory.
- **Effort:** M
- **Dependencies / sequencing:** Best done **after P1-1** so the repaired fence catches any regression. The brand predicate *is* applied today (no live leak), so this is isolation-surface consolidation, not an active CVE.
- **Acceptance check:** No StarRocks query executes outside an analytics-module OTel span; isolation fuzz suite covers the touchpoint read path.

### P1-3 · Implement Phase-1a Identity control-plane + PII vault
- **Findings:** ARC-4
- **Evidence:** `apps/core/src/modules/identity/internal/` contains only `.gitkeep`; `identity/index.ts:7` is `export {}; // TODO`; module imported by nothing. `docs/requirements/04_…Delivery_Plan.md:171` assigns Identity ownership of Brain ID, merge/unmerge, review queue, profile confidence, **PII vault**. `contact_pii` exists only as the unimplemented `MatchPiiPort` interface seam in `notification`. `ResolveIdentityUseCase` is async-resolution-only (no control-plane).
- **Fix:** Implement minimum control-plane in `identity/internal/`: `GET /identity/customer/:brain_id` (Customer 360), `POST /identity/merge`, `POST /identity/unmerge` (admin, audited), and a KMS-encrypted `contact_pii` vault table. Export the public contract from `identity/index.ts`.
- **Effort:** L
- **Dependencies / sequencing:** Blocks the notification send path (no plaintext contact → outbound email/CAPI cannot function) and analytics customer drill-down. Phase-1b is gated on this. Sequence before any outbound-channel GA.
- **Acceptance check:** Customer 360 endpoint returns data for a seeded brand (smoke test); merge/unmerge calls appear in the audit log; notification path resolves plaintext from the vault.

### P1-4 · Extract shared cursor/sync-state repository across repull jobs
- **Findings:** CQ-1
- **Evidence:** `acquireCursorLock`/`getCursorValue`/`upsertCursorValue`/`setSyncState` are near-verbatim copies across `razorpay-settlement-repull/run.ts:360-520`, `gokwik-awb-repull/run.ts:296-438`, `meta-spend-repull/run.ts:268-365`, `shopify-repull/run.ts:440-497` — authors' own comments admit the clone (gokwik L294/L403, meta L266). *Note: the audit verified the copies are currently consistent — the originally-alleged GUC drift was false — so this is maintainability/divergence risk, not an active bug (corrected severity Medium).*
- **Fix:** Extract `apps/stream-worker/src/infrastructure/pg/CursorRepository.ts` exporting the four functions; delete the four private copies; use shopify's already-exported `setSyncState` as the canonical body.
- **Effort:** M
- **Dependencies / sequencing:** Independent. Do before any cursor/GUC hardening so a future fix lands once, not four times.
- **Acceptance check:** All four repull jobs import from `CursorRepository.ts`; no `setSyncState`/`acquireCursorLock` body remains in any `jobs/*/run.ts`; connector e2e suite green for all four providers.

---

## P2 — Near-term, tracked (phase markers, migration integrity, dependency hygiene, duplication)

### P2-1 · Renumber duplicate migration 0033 + add CI duplicate-prefix lint
- **Findings:** ARC-7
- **Evidence:** `db/migrations/0033_consent_record_tombstone.sql` and `db/migrations/0033_send_log.sql` both present; node-pg-migrate tie-breaks alphabetically (consent before send_log) so no live breakage, but the unique-sequence convention is violated and `pr.yml` only runs migrations through 0020.
- **Fix:** Rename `0033_send_log.sql` → next free index (e.g. `0037_send_log.sql`), update `pgmigrations` in all envs. Add CI step: `find db/migrations -name '*.sql' | cut -d_ -f1 | sort | uniq -d | grep .` fails the build on any duplicate prefix.
- **Effort:** S · **Acceptance:** duplicate-prefix CI lint present and green; no two files share a numeric prefix.

### P2-2 · Add machine-readable phase markers + 503 guards to stub bounded contexts
- **Findings:** ARC-5
- **Evidence:** `billing/`, `recommendation/`, `job-orchestration/` each have only `export {} + TODO` in `index.ts` and a `.gitkeep` under `internal/`; doc-04 assigns each a purpose (billing ~L224-231, recommendation detectors L471-472, M12 cron+overlap-lock L1000); migration `0020_provisional_gmv_as_of.sql` exists for the billing meter.
- **Fix:** Add a `MODULE_READINESS` constant to each stub `index.ts` as a phase marker; add feature-flag-driven `503 PHASE_NOT_IMPLEMENTED` on not-yet-implemented routes. Implement at least the billing GMV meter + period seal and one recommendation detector (CM2-falling) to activate Home/Command Center, and the job-orchestration overlap-lock table.
- **Effort:** L (markers S; first detector + meter M each) · **Dependencies:** billing meter benefits from P0-2 (revenue-finalization CronWorkflow). · **Acceptance:** stub routes return `503 PHASE_NOT_IMPLEMENTED` not `404`; billing meter writes provisional GMV; one recommendation surfaces in Home.

### P2-3 · Fix the workspace-access internal reach-around + make the rule enforceable
- **Findings:** ARC-1
- **Evidence:** `bff.routes.ts:45-53,72-73` has 10 imports reaching into `workspace-access/internal` (OnboardingService/Error/Status, RateLimiter, login keys, Membership/OrganizationRepository); `workspace-access/index.ts:1-21` exports none of them; `npx eslint bff.routes.ts` exits 0 because the `no-restricted-imports` group globs are absolute patterns that never match the relative `../../` specifiers (I-E05 guard is dead).
- **Fix:** Export the 7 symbols from `workspace-access/index.ts`; rewrite the 10 imports to use the barrel; switch the `no-restricted-imports` rule to the `regex` matcher (or wire `eslint-import-resolver-typescript` so `boundaries/element-types` catches relative internal paths).
- **Effort:** M · **Dependencies:** shares the resolver fix with P1-1 — wire `eslint-import-resolver-typescript` once for both. · **Acceptance:** `bff.routes.ts` imports only from `workspace-access/index.js`; a test asserts every BFF symbol resolves from the public barrel; the rule errors on a fresh `../../internal/` import.

### P2-4 · Remove phantom dependencies (mysql2, @brain/config)
- **Findings:** RS-2, RS-3
- **Evidence:** `packages/metric-engine/package.json:14-16` lists `mysql2` but `silver-deps.ts:37-38` explicitly uses structural typing instead and no `from mysql2` import exists; `apps/core/package.json:19` declares `@brain/config` but `grep "from '@brain/config'"` across `apps/core/src/**` is empty (collector uses it, core does not).
- **Fix:** Drop `mysql2` from metric-engine deps and `@brain/config` from core deps; `pnpm install`; rebuild + test.
- **Effort:** S · **Acceptance:** `depcheck` reports no unused deps for both packages; both build + test green; Turbo no longer rebuilds core on `@brain/config` change.

### P2-5 · De-duplicate cross-cutting helpers (consumer DLQ scaffold, authority check, generateToken)
- **Findings:** CQ-2, CQ-3, CQ-4
- **Evidence:** `MAX_RETRY=5`/`RetryKey`/retry-count `Map` identically defined across 5 consumers (`CollectorEventConsumer.ts:25-34`, `ConsentSuppressorConsumer.ts:27-33`, `CapiDeletionConsumer.ts:33-41`, `BackfillOrderConsumer.ts:35-41`, `IdentityBridgeConsumer.ts:21-27`); actor/target authority block duplicated in `auth.service.ts:900-939` + `:1008-1047` + `invite.service.ts:404-423` with a **dead `actorIdx`** at `auth.service.ts:930,1038` proving copy-paste; `generateToken` byte-identical at `auth.service.ts:85-90` and `invite.service.ts:38-43`.
- **Fix:** Extract `BaseKafkaConsumer`/`withRetryAndDlq(maxRetry)`; extract `assertActorAuthority(...)` and remove the dead `actorIdx`; export `generateToken` from one module (or a `token-utils.ts`) and import it.
- **Effort:** M · **Acceptance:** single definition of each; `noUnusedLocals` clean (no `actorIdx`); DLQ unit test covers the shared scaffold; suspend/reactivate critical-path tests green.

### P2-6 · Reconcile the dead SharedUtilityPolicy phone-guard with IdentityResolver
- **Findings:** DP-1
- **Evidence:** `SharedUtilityPolicy.ts:26-66` (`evaluate` uses `distinctBrainIdCount > threshold`) is dead code; `IdentityResolver.ts:117-159` re-implements the check with `existingCount + 1 > threshold` (line 141) — **different threshold semantics**; SharedUtilityPolicy's unit tests exercise logic that never runs in production.
- **Fix:** Make `IdentityResolver` call `SharedUtilityPolicy.evaluate` (single source of truth) and reconcile the off-by-one threshold semantics, or delete the dead class and its tests. Decide which threshold form is correct and document it.
- **Effort:** S–M · **Dependencies:** touches identity domain — coordinate with **P1-3**. · **Acceptance:** one phone-guard threshold implementation, with the chosen semantics covered by a live (not dead) test.

### P2-7 · Remove the attribution→analytics journeyReads re-export coupling
- **Findings:** RS-4
- **Evidence:** `attribution/index.ts:21-30` imports `getJourneyFirstTouchMix`/`getJourneyStitchRate`/`getJourneyTimeline` from `../analytics/index.js` and `:60-64` re-exports them as `journeyReads` — a pure re-export that creates a cross-bounded-context coupling the reach-around rule does not catch (it only blocks `/internal/`).
- **Fix:** Delete the `journeyReads` re-export + the analytics import; callers import journey reads from `analytics` directly.
- **Effort:** S · **Acceptance:** no `from '../analytics/index.js'` in `attribution/index.ts`; import graph shows no attribution→analytics edge.

---

## P3 — Backlog (low blast radius; track, don't gate)

| ID | Finding | Evidence | Fix | Effort |
|----|---------|----------|-----|--------|
| P3-1 | RS-5 | `apps/collector/package.json:16` Fastify `^4.28.0` vs `apps/core/package.json:36` `^5.7.2` — major split | Upgrade collector to Fastify v5 (4 route files + main.ts; mind the v4→v5 generic/content-type changes) | M |
| P3-2 | CQ-5 | `stream-worker/src/main.ts:199,243,263,294` + 4 repull pools omit `idleTimeoutMillis`/`statement_timeout` that `LedgerWriter.ts:67-68` etc. set | Add `createWorkerPool(connStr,max)` factory (always 30s idle / 15s stmt timeout); replace 8 bare `new Pool(...)` | S |
| P3-3 | CQ-6 | `auth.service.ts:254` floating `Promise.resolve().then(...)` not `void`-prefixed unlike `:1098` | Prefix with `void` to match the MA-15 pattern | S |

---

## Sequencing summary

```
P0-1 (Dockerfiles/Helm/scan) ──► P0-2 (Argo CronWorkflows) ──► [DEPLOYABLE]
        │                                    │
        │                                    └──► P2-2 billing meter (needs revenue-finalization cron)
        │
  (parallel) P1-1 (fence reorder + TS resolver) ──► P1-2 (attribution→analytics read)
        │                          └── shares TS resolver with ──► P2-3 (bff barrel)
        │
  (parallel) P1-3 (identity control-plane + PII vault) ──► gates outbound-channels GA; coordinate P2-6
        │
  (parallel) P1-4 (CursorRepository) ──► future cursor hardening lands once
```

**Deploy gate:** P0-1 + P0-2 only.
**First-paying-tenant gate:** add P1-1, P1-3 (isolation backstop + Customer 360/PII vault for outbound).
**Everything in P2/P3 is deferred-but-tracked** — none blocks deploy; P2-1 (migration lint) and P2-4 (phantom deps) are the cheapest wins and should be batched into the first cleanup PR.
