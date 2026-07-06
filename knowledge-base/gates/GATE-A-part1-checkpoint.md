<!-- SPEC: 0.2 -->
# GATE-A — Part-1 Checkpoint (WA-00 … WA-10, pre-gate evidence)

**Date:** 2026-07-06 · **Branch:** `feat/commerce-os-program` (base = master `d73caf6d`, current head) · **Verifier:** Wave A checkpoint agent
**Scope:** Stage 0 + Stage 1 of the Wave A work breakdown (knowledge-base/01-delta-plan.md §"WAVE A WORK BREAKDOWN"). Stage 2–5 (WA-11…WA-23) not yet implemented — expected.

---

## 1. Gate command (per AMD-22, BINDING)

`pnpm turbo build lint test:unit --continue --output-logs=errors-only`

**Result: 97 / 103 tasks successful.** All 38 `build` tasks green. Six failures — **every one verified pre-existing on master `d73caf6d` or live-stack-composition-shaped; zero caused by Wave A**:

| Failing task | Detail | Verdict |
|---|---|---|
| `@brain/razorpay-mapper#lint` | 7 × `brain-pci/no-pci-card-fields` in `src/__tests__/index.test.ts:74–80` (card-field FIXTURE that tests the drop-at-boundary rule). | **Pre-existing on master** — reproduced identically on a master worktree with master's config. Test-file-only; `lint:boundaries` (which gates boundaries) excludes tests and is green. |
| `@brain/core#lint` | 15 errors: 14 stale `@typescript-eslint/no-explicit-any` disable-directives (rule not defined in flat config) in 5 TEST files + 1 `brain-redis/no-raw-redis-key` in `apps/core/src/modules/connector/webhooks/tests/WebhookPipeline.integration.test.ts:337`. | **Pre-existing on master** — same errors reproduced on master worktree (incl. the raw-redis-key one). |
| `@brain/stream-worker#lint` | 15 stale `@typescript-eslint/no-explicit-any` disable-directives in 5 TEST files. | **Pre-existing on master** (same reproduction). |
| `@brain/collector#test:unit` | Env-shaped (full `.env` poisons OAuth fixtures). Re-run per checkpoint instruction with ONLY `DATABASE_URL` + `KAFKA_BROKERS`: **10 files / 118 tests — ALL PASS** (includes a11, a12, wa03 suites). | Green under prescribed env. |
| `@brain/core#test:unit` | Same env shape. Re-run with ONLY `DATABASE_URL` + `KAFKA_BROKERS`: **75 files / 597 tests — ALL PASS** (includes admin-flags.routes.test). | Green under prescribed env. |
| `@brain/stream-worker#test:unit` | 678 passed / 6 failed / 10 skipped. The 6 are e2e-in-unit-lane suites requiring the live Bronze landing path: `backfill.e2e` (×2 MERGE-dedup/isolation counts), `ingest-hardening.e2e` R4 dedup, `live-connector.e2e` T3 dedup (all "expected 1 row, got 2"), `spend-repull-smoke` SM1/SM2. Live stack currently runs **no Spark Bronze sink container** (kafka-connect container is up instead) → un-deduped double landing. The 5 test files AND all code under test are **byte-identical to master** (branch touched only `AnalyticsCacheInvalidateConsumer.{ts,test.ts}` + 2 one-line stale-directive removals in stream-worker). | Pre-existing / live-stack composition. NOT a Wave A regression. |

**Honest bottom line:** the one-line gate command is red on master itself (37 test-file-only lint errors). This debt must be paid (or the lint lane's test-file scope decided) before GATE-A can cite a green one-line run. It is outside Wave A's file scope; NOT fixed here per checkpoint instructions.

## 2. `pnpm run lint:boundaries` — **PASS (exit 0, zero errors/warnings)**
The 16-error debt from the delta plan is paid; the 2 stale directives it flagged (`EraseSubjectUseCase.ts:90`, `Backfill.ts:263`) are removed; the new hexagonal rules (domain-zone `boundaries/element-types` + `boundaries/external` driver ban) are active, with `packages/domain-journey` as first occupant + `spec-0-5-hexagonal-boundary.test.ts`.

## 3. WA-06 cross-language hash property test (A.5.2) — **PASS**
`packages/identity-normalization/scripts/run-a52-property-test.sh` →
`ROWS=12000 HASHED=9485 NULL_IDENTIFIER=2515 MISMATCHES=0` (requirement: 0 mismatches over 10k+). TS `@brain/identity-normalization` ⇄ Python `db/iceberg/spark/_identity_normalization.py`, byte-identical normalized + interop + internal hashes. Also green as vitest suite `src/a52-cross-language-property.test.ts` and `a13-normalization.test.ts`.

## 4. WA-09 bridge-fix proof (AMD-01 R1) — **PASS in all four mappers**
Test `A1.4.3 BRIDGE-FIX PROOF: connector interop hash === pixel client-side hash of the same email`:
- `packages/shopify-mapper/src/a14-identity-dual-write.test.ts` — 3/3 pass (25/25 pkg)
- `packages/woocommerce-mapper/src/a14-identity-dual-write.test.ts` — 3/3 pass (29/29 pkg)
- `packages/shopflo-mapper/src/__tests__/a14-identity-dual-write.test.ts` — 4/4 pass (24/24 pkg)
- `packages/gokwik-mapper/src/__tests__/a14-identity-dual-write.test.ts` — 4/4 pass (24/24 pkg)
Each suite also proves `A1.4.1 flag OFF → byte-identical envelope` (§0.5) and `A1.4.2 flag ON → interop fields ADDED, salted unchanged`.

## 5. Repo guards — **both PASS**
- `tools/lint/v4-naming-guard.sh` → "✓ passed — no retired-dbt-DB refs, no dbt invocations, no feature precompute, no StarRocks coupling."
- `tools/lint/serving-pii-guard.sh` → "✓ passed — 45 view file(s) scanned; no raw-PII column projected into serving."

## 6. Flags-off spot check — **PASS (unit-level; byte-regression deferred to GATE-A)**
Live Redis: `SCAN *flag*` → **0 keys** (every new flag absent ⇒ default OFF everywhere).
Tests asserting pre-wave behavior with flags OFF (all green in the runs above):
- `apps/collector/tests/pixel-identify.a11.test.ts` — "flags OFF (no identity bootstrap) ⇒ LEGACY identify only — wire behavior unchanged"; "autodetect flag OFF ⇒ blur captures NOTHING".
- `apps/collector/tests/pixel-consent.a12.test.ts` — "pixel.identify flag OFF (default) ⇒ null ⇒ legacy asset"; "autodetect flag OFF ⇒ autodetect:false even when brand config says autodetect".
- `apps/collector/tests/pixel-asset-equivalence.wa03.test.ts` — built pixel asset ≡ legacy IIFE served behavior (fixture `tests/fixtures/legacy-pixel-iife.ts`).
- 4 × mapper `A1.4.1 flag OFF → byte-identical envelope` (files in §4).
- `packages/pixel-sdk/src/asset/a14-checkout-session.test.ts` — "no provider global → field honestly ABSENT (byte-identical legacy event)".
- `packages/platform-flags/src/flags.test.ts` + `apps/core/.../admin-flags.routes.test.ts` — default-OFF semantics; only literal `true` enables (Python twin: `db/iceberg/spark/_platform_flags_test.py`, 4/4 PASS).
- `db/iceberg/spark/backfill_interop_hashes_guard_test.py` — `test_flag_gate_is_connector_identity_fields` (job no-ops flag-off).
Full golden byte-regression: **N/A until GATE-A** — baseline snapshot to be captured by the orchestrator (`packages/testing-golden/snapshots/baseline/` is intentionally empty; `scripts/capture-baseline.sh` ready).

## 7. git status / additivity audit
Committed Wave A work: 2 commits on branch (`f42e5a6c` Phase-0 docs, `0ba83a3f` implementation — 156 files, +9,297/−601; deletions are refactor-internal line removals, mainly `pixel-asset.route.ts` hand-maintained IIFE → built artifact).
`git diff master..HEAD --diff-filter=D` → **0 deleted files**. Migration `db/migrations/0121_brand_consent_config.sql`: additive columns/function only — `DROP` appears **solely inside the rollback comment block** (lines 30–31). **No table/column drops anywhere.**
Working tree (uncommitted — orchestrator must commit with Part 1):
- `M apps/core/.../WooCommerceWebhookStrategy.ts` — fixes out-of-scope `ctx.identityFieldsEnabled` reference inside `mapOrder` (compile fix; parameter-threaded). REQUIRED.
- `M db/iceberg/spark/run-backfill-interop-hashes.sh` — pins `phonenumbers==9.0.34` install into the vanilla spark image (matches Dockerfile pin). REQUIRED for WA-10 execution.
- `?? packages/{gokwik,shopflo,woocommerce}-mapper/**/a14-identity-dual-write.test.ts`, `?? packages/pixel-sdk/src/asset/a14-checkout-session.test.ts` — 4 spec-named test files (all green). REQUIRED.
- `?? infra/terraform/envs/prod/terraform.tfvars` — pre-existing local file, present before Wave A started; NOT program work; do not commit (gitignored-by-intent secrets-shaped).

---

## Per-item status (WA-00 … WA-10)

| Item | Files (primary) | Tests (spec-named) | Status |
|---|---|---|---|
| **WA-00** amendments | `knowledge-base/amendments/AMD-01…AMD-23` (23 filed, incl. required AMD-01..09, AMD-12) + `ADR-normalization-gmail.md` | n/a (binding docs) | **DONE** |
| **WA-01** platform-flags | `packages/platform-flags/src/{domain/flag-service.ts, infrastructure/redis-flag-store.ts, registry.ts, index.ts}`; Spark twin `db/iceberg/spark/_platform_flags.py` (dep-free RESP client = the Spark-side flag-read decision); `apps/core/.../routes/admin-flags.routes.ts`; key-builder additions in `packages/tenant-context/src/index.ts`; AMD-23 | `flags.test.ts` (pass, in turbo); `admin-flags.routes.test.ts` (pass); `_platform_flags_test.py` 4/4 PASS | **DONE** — default OFF; live Redis flag keys = 0 |
| **WA-02** ESLint debt + hexagonal rule | `eslint.config.mjs` (+domain zone, +2 hexagonal rules); reroutes via `packages/metric-engine/src/{finalized-purchases-window.ts, ledger-presence.ts}` + `apps/core/src/modules/analytics/index.ts`; stale directives removed (`EraseSubjectUseCase.ts`, `Backfill.ts`, `replay-identity.ts`); `packages/domain-journey/` first occupant | `spec-0-5-hexagonal-boundary.test.ts` (pass); `pnpm run lint:boundaries` exit 0 | **DONE** |
| **WA-03** pixel build unification | `packages/pixel-sdk/src/asset/{runtime,entry,constants,auto-instrument,identify-autodetect,identify-normalize}.ts`, `tools/{build-pixel-asset,pixel-asset-bundle}.mjs`, `src/asset/generated/pixel-asset.built.ts`; `apps/collector/src/interfaces/rest/pixel-asset.route.ts` (serves built artifact) | `pixel-asset-equivalence.wa03.test.ts` (pass), `pixel-asset-build.test.ts` (pass), fixture `legacy-pixel-iife.ts` | **DONE** |
| **WA-04** testing-golden | `packages/testing-golden/src/{prng,ids,fixtures,envelopes,scenarios,generator,cli}.ts`, `scripts/{capture-baseline.sh,seed-golden-brands.sh,produce-jsonl.mjs}` | `spec-1.10-golden-dataset.test.ts` (pass — determinism/scenario coverage) | **CODE DONE**; baseline snapshot capture = orchestrator step at GATE-A |
| **WA-05** Apicurio governance | `packages/events/src/index.ts` (idempotent compat-rule boot + 404-as-pass client bug FIXED, per AMD-03); `packages/contracts/src/events/json-schema/brain.pixel.identify.v1.json` | `spec-1-7-schema-compat.test.ts` 8/8; `spec-1-7-schema-compat.live.test.ts` 2/2 vs live Apicurio | **DONE** |
| **WA-06** identity-normalization | `packages/identity-normalization/src/index.ts` (NFC email, libphonenumber-js E.164 IN/AE/SA/QA/BH/KW/OM, unparseable→no identifier); Python twin `db/iceberg/spark/_identity_normalization.py` + `_identity_normalization_xlang_test.py`; `db/iceberg/spark/Dockerfile` pins `phonenumbers==9.0.34` | `a13-normalization.test.ts` (pass); **A.5.2 property test: 12,000 rows, MISMATCHES=0** | **DONE** |
| **WA-07** pixel.identify.v1 | schema (see WA-05); explicit `brain.identify` + phone + `source` + `consent_state` + sessionStorage dedupe in `runtime.ts`/`identify-normalize.ts`; MutationObserver+blur autodetect w/ password-guard in `identify-autodetect.ts`; per-brand bootstrap `apps/collector/src/interfaces/rest/pixel-identity-config.ts` | `pixel-identify.a11.test.ts` (pass), `identify-normalize.a11.test.ts` 10/10 | **DONE** behind `pixel.identify` / `pixel.autodetect` flags (OFF) |
| **WA-08** consent config | `db/migrations/0121_brand_consent_config.sql` (additive; seeds current behavior per AMD-04); `brand.service.ts`; TCF `__tcfapi` reader (pixel runtime); Silver denied-VALUE drop `db/iceberg/spark/silver/silver_collector_event.py` + `_silver_technical.py` | `pixel-consent.a12.test.ts` (pass); `silver/a12_identify_consent_denied_test.py` 5/5 PASS (denied-value drop, garbage fails closed, non-identify never value-gated) | **DONE** |
| **WA-09** connector identity fields | `packages/connector-core/src/contracts/IdentityFields.ts`; 4 mappers dual-write interop hash flag-gated (`connector.identity_fields`, fail-closed OFF); Shopflo legacy-name unification; GoKwik + pixel `checkout_session_id`; webhook pipeline threads `identityFieldsEnabled` (`IWebhookStrategy.ts`, `WebhookPipeline.ts`, 4 strategies) | 4 × `a14-identity-dual-write` suites incl. **BRIDGE-FIX PROOF** (all pass); `a14-checkout-session.test.ts` 5/5 | **DONE** — note working-tree compile fix + 4 uncommitted test files (§7) |
| **WA-10** interop-hash backfill | `db/iceberg/spark/backfill_interop_hashes.py` + `run-backfill-interop-hashes.sh` (bronze raw→silver additive MERGE, erasure-ledger anti-join skip, flag-gated) | `backfill_interop_hashes_guard_test.py` 6/6 PASS (idempotent, tenant-first, additive, no raw PII in target, shredded-subject skip encoded) | **CODE DONE**; live execution = gate/run-time step, not yet run |

---

## §1.9 invariant checklist — rows assessable at Part-1

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | No new datastore/queue/framework | **PASS** | New deps only: `libphonenumber-js` (spec-sanctioned, A.1.3), `esbuild` (devDep, pixel bundling), `ioredis` (existing house driver, new consumer). Spark flag-read uses a dep-free RESP client (`_platform_flags.py`) — no Python redis lib added. |
| 2 | New monetary columns = integer minor units + currency | **PASS (vacuous) / N-A** | Wave A Part-1 adds NO monetary columns; testing-golden fixtures emit `*_minor` + `currency_code` per house convention. |
| 3 | New subject-linked tables in shred manifest | **N-A-until-gate** | No new subject-linked TABLE in Part-1 (0121 adds brand-level config enums; backfill writes to EXISTING silver tables already covered by hash-only posture). `knowledge-base/privacy/shred-manifest.md` still to be authored when WA-13/WA-16 tables land — tracked. |
| 4 | No unhashed PII in new topic/log/table | **PASS** | `brain.pixel.identify.v1.json` carries only `email_sha256?/phone_sha256?`; pixel hashes client-side, raw discarded (a11 tests); guard test `test_lanes_are_raw_connect_and_target_stores_no_raw_pii`; serving-pii-guard green. |
| 5 | Zero probabilistic rows in attribution (data test) | **N-A-until-gate** | Probabilistic layer = WA-20 (not built); structural exclusion unchanged from baseline. |
| 6 | brand_id on all new tables/keys + isolation | **PASS (assessable part)** | Flags keyed `{brand_id}:flag:*` via sanctioned `brandKey()`; `pixel.identify.v1` requires `brand_id`; 0121 columns live ON `tenancy.brand`; backfill MERGE is tenant-first (guard test). Full isolation-fuzz lane re-run = GATE-A. |
| 7 | New topics schema-registered, compat rule live | **PASS** | Per AMD-03: `brain.pixel.identify.v1` registered; idempotent compat-rule boot step + 404-bug fix in `@brain/events`; `spec-1-7-schema-compat` unit 8/8 + live 2/2 against the running Apicurio. |
| 8 | Flags OFF byte-identical golden outputs | **N-A-until-gate** | Baseline snapshot not yet captured (orchestrator). Unit-level flag-OFF equivalence proven (§6). |
| 9 | ESLint hexagonal boundary rule passes | **PASS** | `pnpm run lint:boundaries` exit 0 (§2). |
| 10 | Bi-temporal access only via sanctioned views | **N-A-until-gate** | `identity_current_v`/`identity_asof` = WA-13/WA-14 (Stage 2, not yet started). |

---

## Defects reported (NOT fixed here, per checkpoint instructions)

1. **Master lint debt (blocks the one-line gate command):** 37 test-file-only errors on master `d73caf6d` — razorpay-mapper 7 × PCI-fixture, core 14 stale `no-explicit-any` directives + 1 `no-raw-redis-key` (`WebhookPipeline.integration.test.ts:337`), stream-worker 15 stale directives. Pay before GATE-A cites `pnpm turbo build lint test:unit test:contract` green, or record a scope ruling for test files in the lint lane.
2. **stream-worker e2e-in-unit-lane failures (6):** live stack currently runs NO Spark Bronze sink container (kafka-connect is up) → dedup counts land 2. Restore the Spark sink profile before GATE-A live evidence runs. Files + code under test byte-identical to master.
3. **Uncommitted required working-tree changes** (§7) — must be committed by the orchestrator (agent forbidden to commit): WooCommerce `ctx` compile fix, backfill runner `phonenumbers` pin, 4 green spec-named test files.
4. `packages/testing-golden` baseline snapshot pending orchestrator capture (GATE-A precondition for invariant row 8).
