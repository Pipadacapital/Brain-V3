# EOS Out-of-Band Reconciliation — 2026-06

**Date:** 2026-06-19
**Branch:** `chore/eos-oob-reconciliation`
**Reviewer scope:** read-only engineering assessment of already-merged work; no product code modified.
**Worktree:** `/Users/rishabhporwal/Desktop/Brain V3/worktrees/eos-recon`

This report brings 12 PRs that landed on `master` **outside the formal EOS pipeline** (or via the pipeline but whose run artifacts were never committed) into the system of record. Each PR was reviewed via its squash/merge SHA: `git diff <sha>^1 <sha>` plus `git show --stat <sha>`.

---

## 1. Why the gap happened

Two distinct mechanisms, not one:

1. **PIPELINE-RUN-ARTIFACTS-LOST (the 3 Phase 6/7/8 feature PRs + the realtime-ingestion PR).** The code itself testifies to a real, disciplined EOS run: in-migration assertion blocks, documented invariant IDs (I-S08 / I-ST05 / I-S07 / D-2 / MT-1 / I-S09), non-inert isolation tests with explicit negative controls, a shared house style (RLS ENABLE+FORCE, two-arg fail-closed policy, append-only-by-GRANT, BIGINT-minor money). But the **architect / security / QA / final-review run-folders for these phases are not present on `master`.** The most likely cause: the runs were executed inside feature worktrees and the `.engineering-os/runs/...` artifacts were never committed back when the branch was squash-merged. The audit trail — not the engineering quality — is the hole.

2. **NO-PIPELINE (the 5 UI contract hotfixes, 1 auth/session hotfix, 4 dev-infra/config fixes).** These are genuine inline hotfixes (web type↔core-DTO contract drift, a session brand-context bug, docker-compose/profile and dev-credential fixes). They were done agent-driven, surgically, with no spec/design/QA/security artifacts because no formal run was ever opened. For most this is acceptable (display-only, dev-only). The two that deserve a record: an **auth/multi-tenancy change (#69) reached `master` with no security review**, and a **prod secrets-path fix (#75) / dev-credential default (#65)** carry prod-correctness implications.

**Recommendation:** reconstruct or stub a run-record note per feature phase (PRs #68/#71/#74/#73) in the system of record so the audit trail isn't a hole, and adopt a merge check that fails if a feature branch's `runs/` artifacts are absent at squash time.

---

## 2. Per-PR reconciliation table

| PR | SHA | What shipped | Classification | Correctness | Debt / follow-up | Stakeholder-attention |
|---|---|---|---|---|---|---|
| #68 feat/capi-conversion-feedback | `17215034ecb6` | Consent-gated read-only Meta CAPI conversion passback + withdrawal-driven deletion + analytics UI; migration `0034`. | PIPELINE-RUN-ARTIFACTS-LOST | OK — gate fires first, idempotent `ON CONFLICT`, I-S08 holds; 4-way consent test passes. | Currency `/100` exponent hardcode (JPY/KWD off by 100×/10×); advertising skips 9–9 IST send-window (compliance call); `pixelId:''` seam. | **YES** — currency-exponent latent money bug + send-window compliance call made inside an uncommitted run. |
| #71 feat/data-quality-engine | `fc69b763e5d7` | Deterministic DQ engine (freshness/completeness/schema/reconciliation) → frozen letter grade gating metric trust + DQ dashboard; migration `0035`. | PIPELINE-RUN-ARTIFACTS-LOST | OK — pure/deterministic grade, fail-closed to 'D', gate wired in `getMetricTrust`; non-inert RLS test w/ negative control. | No `@effort` decl (cosmetic; all Tier-1 deterministic); pkg version + lockfile bump (expected). | No |
| #74 feat/decision-intelligence-inputs | `2b5397e61175` | "Ask Brain" NLQ → model resolves only to certified `metric_id`+version+allow-listed params (never SQL/number); engine computes; redacted reproducible provenance; migration `0036`. | PIPELINE-RUN-ARTIFACTS-LOST | OK — no-model-SQL (schema-constrained binding\|refusal), read-only MCP (CI-asserted 0 write tools), redaction before insert, byte-identical reproducibility; non-inert fuzz test w/ mutation control. | **No machine-readable `@effort` on the only model call** → invisible to cost-mix dashboard + cost-routing CI gate; no per-tenant spend-cap evidence in diff. | **YES** — cost-observability hole on the sole model call (not a safety hole). |
| #73 feat/realtime-ingestion-pipeline | `9bb08b590e06` | Deterministic per-brand dev salt (`resolveSaltHex`) + ~45s near-real-time ingestion scheduler reusing claimer primitives + honest live-refresh UI; no migration. | PIPELINE-RUN-ARTIFACTS-LOST | OK — 13/13 salt tests replicated green, conformance vector recomputed; prod salt path + D-2 guard provably untouched; scheduler fail-isolated, overlap-safe (SKIP LOCKED), non-inert `brain_app` test. | "Real-time" is polling not webhook push (honest framing); `loadRun` has no gokwik case (pre-existing); dev-salt master constant should have a CI guard against prod reach. | No (one framing note: near-real-time polling, not push). |
| #67 fix/analytics-contract-audit | `b3a75b7c90a1` | Aligned web analytics TS types + consumers to core BFF DTOs (6 contract-drift fixes), removing one fabricated metric; web-only, no migration. | NO-PIPELINE | OK — all 6 fixes verified field-for-field against core DTOs; incl. removal of fabricated real-vs-synthetic touch split. | Web `JourneyTouchpointRow` still omits `event_type`; no contract/codegen test pinning web↔core (drift can silently recur). | **YES** (low) — journey-mix screen previously showed a fabricated "real vs synthetic touches" split core never produced; now honest counts. |
| #69 fix/session-brand-context | `6f2665cb5ba7` | `resolveActiveContext` resolves brand-level membership in the preferred org (new `findActiveByUserAndOrg`) so fully-onboarded users get `brand_id` in JWT instead of `null`; no migration. | NO-PIPELINE | OK — strictly safer than the replaced null-brand path; new query RLS-bound + membership-gated caller (403 on non-member); non-inert LIVE regression test. | Multi-brand-in-one-org last-used-brand memory still deferred (MA-13); REG test silently skips if Postgres unreachable. | **YES** (low/process) — auth/session brand-resolution change merged with no security review + only a DB-gated test. |
| #63 fix/attribution-field-mismatch | `c11bde73ae91` | Realigned attribution UI types/components to core's actual contract (`attributed_gmv_minor`/`by_channel`, etc.); made per-channel `share_pct`/`confidence_grade` optional; web-only. | NO-PIPELINE | OK — verified field-for-field vs `get-attribution-by-channel.ts`; old fields were undefined → broken render. | Core types `currency_code: string \| null` but UI types it non-nullable + `as CurrencyCode` — null currency would mislabel/crash formatter. | No |
| #66 fix/journey-field-mismatch | `9bbe17c35267` | Removed non-existent `real_touch_count`/`synthetic_touch_count` from first-touch-mix type; derives coverage from `total`+`data_source`; web-only. | NO-PIPELINE | OK — old `BigInt(undefined)` threw → journey page crashed at runtime; fix is honest window-level interpretation core supports. | Coverage now whole-window binary; revisit if core later emits a true per-touch split. | No |
| #70 chore/dev-worker-tier | `148d5a6` | Added minio/minio-init to `ingest` compose profile; `pnpm dev` boots core+ingest, split `dev:core`; no migration. | NO-PIPELINE | OK for its goal, but **largely superseded by #72** (minio→ingest decision reversed). | Churned intermediate state; no residual debt after #72. | No |
| #72 fix/dev-nessie-profile | `7fb9fe8` | Moved minio/minio-init/nessie into opt-in `lakehouse` profile (nessie `0.90.2` unpullable broke `pnpm dev`); added `dev:lakehouse`; no migration. | NO-PIPELINE | OK and well-reasoned; verified profile assignments. | Stale `docker-compose.yml` header (lines 5/7-8) now actively wrong re: nessie/lakehouse; `nessie:0.90.2` unpinnable → `dev:lakehouse` non-functional until re-pinned. | No (dev-only; lakehouse path broken until image re-pinned). |
| #75 fix/worker-secrets-aws-import | `0dcf973` | Fixed cross-package `require()` path (6×`../`→4×`../`) the stream-worker uses to load core's `AwsSecretsManager` in prod; local inline ctor type; no migration. | NO-PIPELINE | OK — **genuine prod bug**: old path resolved outside repo → `MODULE_NOT_FOUND`; prod Shopify token retrieval was broken on the secrets path. Verified at source-tree layout only. | Fragile deep cross-package relative reach; lost cross-package type check; runtime depends on deployed bundle layout. | **YES** — prod Shopify secret loading was previously broken; confirm exercised end-to-end post-merge + bundle layout matches. |
| #65 fix/starrocks-analytics-dev-password | `9678ac3` | Changed StarRocks analytics-user password default `''`→`'brain_analytics_dev'` in core to match `bootstrap.sql`; no migration. | NO-PIPELINE | OK — empty default caused `ER_ACCESS_DENIED` 500s on every Silver-read on fresh `pnpm dev`; makes core consistent with worker. | Hardcoded dev secret as code default; same default in 3 places; **no in-repo prod wiring for `STARROCKS_ANALYTICS_PASSWORD`** → weak-default footgun if prod ships without it. | **YES** (low) — confirm prod always injects `STARROCKS_ANALYTICS_PASSWORD`; prefer fail-loud over weak default in prod. |

**Counts:** 12 PRs · 4 PIPELINE-RUN-ARTIFACTS-LOST · 8 NO-PIPELINE · 0 CRITICAL/HIGH defects · 5 stakeholder-attention flags (1 of them is two related items, #65 + #75 prod-config).

---

## 3. Invariants that survived (feature PRs)

- **#68 CAPI:** I-S08 read-only/consent-gated ✅ (caveat: currency-exponent + send-window).
- **#71 DQ:** dq_grade gate + per-brand RLS ✅, strong negative control, no money/PII surface.
- **#74 DI:** no-model-SQL + read-only MCP + redacted-reproducible ✅ (caveat: cost-observability).
- **#73 Realtime:** prod salt + D-2 hard-crash guard provably untouched, MT-1 isolation intact ✅.

Every feature migration (`0034`/`0035`/`0036`) is RLS ENABLE+FORCE, two-arg fail-closed policy, append-only-by-GRANT, in-migration assertion blocks, no float-money (BIGINT minor + CHAR(3) currency).

---

## 4. Consolidated follow-ups / tech-debt (full list)

**Money / correctness:**
1. **[#68]** CAPI `/100` currency-exponent hardcode in `apps/core/src/modules/notification/internal/capi-passback.service.ts` — wrong for zero-/3-decimal currencies (JPY/KWD/BHD). Make exponent-table-driven before multi-currency.
2. **[#75]** Confirm prod Shopify secret loading (`AwsSecretsManager` via the corrected `require()` path) is exercised end-to-end against the **deployed bundle** layout; replace fragile cross-package relative reach with a shared package/interface export.

**Cost / observability:**
3. **[#74]** Add a machine-readable `@effort("large_model"|"small_model", token_budget=...)` to the NLQ resolver call in `packages/ai-gateway-client/src/client.ts` so it counts in the cost-mix dashboard + cost-routing CI gate; confirm per-tenant model spend-cap is live (may be in gateway/Canon).

**Compliance:**
4. **[#68]** Advertising path deliberately skips the 9–9 IST send-window ("measurement signal, not human contact") — confirm legal/compliance signed off (decision was made inside an uncommitted run).

**Config / prod-leakage:**
5. **[#65]** No in-repo prod wiring for `STARROCKS_ANALYTICS_PASSWORD` (grep of terraform/helm empty). Verify deploy always injects it; prefer `getEnvOrThrow` in prod over falling back to `brain_analytics_dev`. Same default duplicated in `bootstrap.sql` + core + stream-worker.
6. **[#72]** `projectnessie/nessie:0.90.2` is unpullable → `dev:lakehouse` non-functional until a working tag is pinned. Stale `docker-compose.yml` header (lines 5/7-8) now contradicts the lakehouse-profile change — fix the comment.

**Contract / test-coverage:**
7. **[#67/#63]** No web↔core contract/codegen test — analytics type drift can silently recur. Add a shared contract package or a generated-types check. Web `JourneyTouchpointRow` still omits `event_type`.
8. **[#63]** Reconcile `currency_code` nullability: core emits `string | null` in `has_data`; `apps/web/lib/api/types.ts` types it non-nullable + `as CurrencyCode`. Either core narrows or UI guards null.
9. **[#69]** Backfill a non-DB-gated unit/contract test for the brand-resolution path (current REG test silently skips if Postgres is down). Multi-brand-in-one-org last-used-brand memory (MA-13) still deferred.
10. **[#73]** Scheduler `loadRun` has no `gokwik` case (gokwik connectors got the salt change but ride a different trigger) — confirm intended. Add a CI guard that the dev-salt master constant is unreachable when `NODE_ENV=production`.

**Audit trail (the dominant finding):**
11. **[#68/#71/#74/#73]** Reconstruct or stub a per-phase run-record note in the system of record; adopt a squash-merge check that fails when a feature branch's `runs/` artifacts are absent.

---

## 5. Honest bottom line

The engineering is mature and the high-stakes invariants survived across all four feature PRs — this was **not** sloppy work thrown over the wall. The systemic finding is **process, not code**: feature-run artifacts were lost at squash time, and an auth/multi-tenancy change plus two prod-config fixes reached `master` with no formal pipeline. Five stakeholder-attention items (one latent money bug, one cost-observability hole, one prod-secrets confirmation, one prod-credential confirmation, one previously-fabricated analytics number) and eleven follow-ups are tracked above. No CRITICAL/HIGH defects.
