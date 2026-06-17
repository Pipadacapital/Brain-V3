# 11 — Final Review (Stage 6, VETO) — feat-razorpay-settlement-connector

**Stage:** 6 · **Engineering Advisor (final-reviewer)** · **Model:** Opus 4.8 (1M context)
**Reviewed:** 2026-06-18 · **Branch:** feat/razorpay-settlement-connector · **Scope:** A+B diff (master...), 31 files / ~5.7k insertions. Track C DEFERRED (logged orchestrator decision — not a gap).

## VERDICT: BOUNCE → data-engineer (Stage 3)
## RECOMMENDATION: REJECT (1 blocking) — re-review as DELTA after the surgical fix.

The connector backend is, on the merits, excellent work: all 13 bindings (MB-1..MB-7 + C1..C6) are implemented and the primary data-protection controls are live and proven non-inert. **One HIGH finding blocks the ship:** the two mandated *defense-in-depth* CI gates (C4 PCI card-field lint, C5 log-grep) landed as files but are not enforced by any tooling. The contract binds both as "mandatory CI gates, not code-review expectations" (C4.4 / C5.3 / ADR-RZ-10). A bound mandatory gate that does not run is, for release purposes, an unmet binding — not a code-review nit. I uphold the Security Reviewer's BOUNCE.

There is no Security/QA disagreement to reconcile: QA returned PASS but **explicitly deferred** C5 wiring confirmation to Security (qa-review.md:75); Security found C4+C5 unwired. The two artifacts are consistent. Per the severity rubric, an OPEN HIGH governs the gate.

---

## What I independently verified (not trusted)

### Drift check — all 7 deliverables + 13 bindings met (Track C deferral acknowledged)
- All product files map 1:1 to plan-named artifacts (ADR-RZ-1..10). The only file my over-engineering filter surfaced — `SettlementLedgerConsumer.ts` — is explicitly plan-sanctioned (ADR-RZ-6). No unsanctioned dir/abstraction, no new deployable, no new lane/topic. **Single-Primitive: CLEAN.**
- Track C (frontend gross→net) deferral is a logged orchestrator decision; the connector backend is independently shippable. Not a blocking gap.

### Cost / paradigm audit — PASS ($0 incremental model spend)
- Paradigm scan over the new product code (`grep -ni openai|anthropic|llm|gpt|claude|embedding|completion|inference|@effort`) → **ZERO hits**. Pure Kafka produce/consume + Postgres + HMAC + sha256 + Redis SET NX + a deterministic signed-sum join. Tier-0 deterministic, exactly as the plan declared. A model call on this path would be a paradigm bypass; none exists. No effort-tier declaration is required because no path calls a model.

### Over-engineering audit — CLEAN
- No files/deps/abstractions beyond plan. NO new dependency versions (pnpm-lock delta is workspace-internal). Migration `0027` is additive-only with a documented DROP rollback. Plan length is proportionate to a high-stakes payments + DPDP + multi-cursor surface.

### Tenant isolation re-confirmed (verified live under brain_app by both upstream gates)
- `connector_razorpay_order_map` FORCE RLS (relforcerowsecurity=t); two-arg fail-closed policy; **no-GUC negative control = 0 rows** under brain_app while the superuser sees the seeded rows (non-inert). SECURITY DEFINER enumeration (`list_razorpay_connectors_for_settlement_repull`) satisfies the BINDING durable rule `system-job-force-rls-enumeration` — prosecdef=t, search_path pinned, EXECUTE granted to brain_app only, returns connected-only with NO GUC while the bare SELECT = 0. Re-pull job sets GUC AFTER enumerate, per-brand, before any cursor read. I note the MEMORY caveat (dev superuser `brain` masks RLS) — both upstream gates ran under `brain_app` (NOSUPERUSER/NOBYPASSRLS confirmed via pg_roles), so the isolation evidence is real, not inert.

### Money — PASS
- BIGINT-as-string throughout; the only `parseFloat`/`Number(` hits in the new files are (a) comments asserting no-float and (b) Kafka *offset* arithmetic (message positions, not money). Signed-sum nets correctly: finalization +97640, payment_fee −2000, settlement_tax −360 (GST_18 SEPARATE row) observed in real e2e logs. Provisional row untouched (append-only). Idempotency → one row (ON CONFLICT). Corrections don't collapse (entityType-discriminated uuidv5).

### The wired-to-nothing watch (occurrence #3) — DID NOT RECUR
- `SettlementLedgerConsumer` is genuinely WIRED in `apps/stream-worker/src/main.ts`: import (L30), instantiate (L121), `await .start()` (L183), `.stop()` in the shutdown `Promise.all` (L137). QA un-wired `.start()` → the e2e wiring test SW1 went RED (`pollUntil timed out after 30000ms. Last: []`) — a genuine, non-inert CI guard. **The pattern did not recur to occurrence #3.** No rule proposal is filed for it. (The prior occurrences #1/#2 were `feat-realized-revenue-ledger` and `feat-shopify-live-connector`; this run breaks the streak.)

### Spot-re-run of ≥3 QA gates (captured this session)
1. `pnpm --filter @brain/razorpay-mapper test:unit` → **43 passed / 43** (replicated; covers C1 boundary-hash, C4 allowlist UT-5, MB-2 discriminator UT-2/UT-11).
2. `npx eslint --print-config packages/razorpay-mapper/src/index.ts` → resolved config contains only `no-float-money` + `no-raw-redis-key`; **`no-pci-card-fields` is absent** — independent, non-inert confirmation that the C4 lint rule does NOT run. This is the SEC-RZ-H1 evidence, reproduced.
3. Paradigm/float/model grep over the new product files → clean (gate #3 above).
- `git grep`/`grep -rn log-grep-patterns` across `.github/`, package scripts, `tools/` → **zero consumers** (only the file's own self-reference). C5 gate is inert. Reproduced.

### Verification-validity confirm — PASS
- QA's `negative_control[]` carries 3 non-empty, captured-RED entries (consumer un-wired → timeout; forced `hmacValid=true` → 401→200 RED; no-GUC FORCE-RLS → fail-closed). Security independently captured the forged-HMAC RED and re-ran 43/43 live. `validity_check.py` clean, EXIT 0. No bypass-green, no inert probe, no tautological parity, no superuser DSN in tests. The negative controls on the tenancy/auth/money paths are present and real.

---

## The blocking finding (the only thing standing between this and APPROVE)

**SEC-RZ-H1 (HIGH, OPEN) — bound CI gates not enforced.**
- `tools/eslint-rules/no-pci-card-fields.mjs` exists (banlist: card_last4/network/brand/issuer/international/type/country) but is NOT imported or registered in `eslint.config.mjs`. Precedent rules `no-float-money` and `no-raw-redis-key` ARE wired (L14-15/35-36/114-117) — this one was simply missed. Confirmed dead via `eslint --print-config`.
- `tools/eslint-rules/log-grep-patterns.json` (patterns `pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, `UTR[0-9A-Za-z]{16,22}`) is consumed by no CI workflow or script.
- Why it blocks despite "no active leak": the PRIMARY controls (mapper allowlist + boundary-hash) are live and proven (43/43, UT-5/UT-6), so card data cannot reach Bronze *through the mapper today*. But C4.4/C5.3 bind these gates precisely to catch a FUTURE code path that bypasses the mapper. A mandatory bound gate that is dead is an unmet binding on a PCI/DPDP surface. This is a hard-rule-class deviation (an un-codified gate-skip) — I cannot auto-approve it under delegation; it bounces.

**Remediation (surgical — one import + one registration + one CI wire):**
1. `eslint.config.mjs`: import `no-pci-card-fields.mjs`, add the `brain-pci` plugin + `'brain-pci/no-pci-card-fields': 'error'` (mirror the `no-float-money` wiring); add the rule's own `eslint-disable` on the mapper's allowlist/blocklist constant lines so the boundary file lints clean.
2. Wire `log-grep-patterns.json` into the nightly log-grep CI step (the job referenced by COMPLIANCE.md:172) + a CI assertion that the file is consumed.
3. Re-review as DELTA scoped to SEC-RZ-H1 + the changed config/CI lines only.

---

## Tracked tech-debt (carry to the Stakeholder; none block beyond SEC-RZ-H1)
- **SEC-RZ-M1 (MED):** unauthenticated pre-HMAC DB/secret lookup = minor DoS/account_id-enumeration surface. NN-4 still holds (no side effect before HMAC). Platform follow-up: route rate-limit/WAF + uniform 401 timing.
- **SEC-RZ-L1 (LOW):** `RedisDedupAdapter` fails OPEN but comment says FAIL-CLOSED. Fix comment; add Redis-down metric.
- **QA-NOTE-1 (INFO):** `upsert_razorpay_order_map` documented as a fn, implemented as a brand-GUC repo UPSERT against the FORCE-RLS table — behavior correct, wording mismatch only.
- **Platform follow-up (INFO):** real public webhook ingress (dev-honesty boundary, same as Shopify) — proven via synthetic HMAC POSTs.

## Auto-candidate rule check — NOT triggered
- The wired-to-nothing pattern did not recur (MB-4 wired), so no proposal there.
- The SEC-RZ-H1 root cause ("a contract-bound mandatory CI gate ships as a file but is not registered/enforced") is a distinct theme from the prior wired-to-nothing (runtime-consumer) and fixture-coverage occurrences. It does NOT meet the ≥3-distinct-prior-run threshold as a dominant root cause. **No `rule-proposals/` file written; nothing appended to `pending-stakeholder-attention.md`.** I flag it as a watch: if a second connector ships a gate-file-without-CI-wiring, that is occurrence #2 of a new pattern worth codifying.

## Hard-rule deviation check
- Dependency violation: none (no new versions). Single-Primitive: CLEAN. Compliance gap: SEC-RZ-H1 is precisely a compliance-gate-not-enforced — it is the reason for the bounce, surfaced to the Stakeholder via this artifact. Paradigm escalation beyond plan: none ($0). Un-codified gate-skip: SEC-RZ-H1. No commit command is produced (BOUNCE, not PASS).

## Decision
**BOUNCE → data-engineer (owns ADR-RZ-10 / C4 / C5).** On remediation, DELTA security re-review (scope = SEC-RZ-H1 + config/CI lines), then this gate re-runs and, if clean, advances to the Stakeholder gate (Stage 7). No `pending-stakeholder-commit.md` written (not a PASS).

---

## Journal (appended to cto-advisor.journal.md)
```
## 2026-06-18T00:58:00Z — Engineering Advisor (final-reviewer) — feat-razorpay-settlement-connector
Stage 6 · Verdict: BOUNCE · Paradigm audit: clean (tier-0 deterministic, $0 model spend)
Gates re-run: mapper unit 43/43 (replicated) · eslint --print-config (no-pci-card-fields ABSENT — SEC-RZ-H1 reproduced) · log-grep-patterns.json zero CI consumers · model/float paradigm grep empty
Blocking: SEC-RZ-H1 (HIGH, OPEN) — bound CI gates C4/C5 unenforced. Over-engineering CLEAN, MB-4 wired (occurrence #3 did NOT recur), isolation/money/negative-controls all verified. No auto-candidate rule (threshold not met).
Next: bounce_target = data-engineer (Stage 3) → DELTA security re-review → re-gate.
```

---

# DELTA RE-REVIEW — 2026-06-18 · Engineering Advisor (final-reviewer) · Model: Opus 4.8 (1M context)

## VERDICT: PASS
## RECOMMENDATION: APPROVE (0 blocking) → Stakeholder gate (Stage 7)

**Mode:** DELTA · **Scope:** SEC-RZ-H1 + SEC-RZ-L1, the 2-commit fix diff (8e63deb, b5ce157), + the regression check on the prior-passing suites. The prior bounce was on SEC-RZ-H1 ALONE; QA had already PASSed, the wired-to-nothing occurrence #3 did NOT recur, and all other Stage-6 audits (drift / cost-paradigm / over-engineering / isolation / money / negative-control) were clean and are not re-litigated here.

### SEC-RZ-H1 (HIGH) — RESOLVED (independently re-verified, not trusted)
The two contract-bound mandatory CI gates (C4.4 / C5.3 / ADR-RZ-10) are now LIVE and proven NON-INERT by my own captured re-runs:

1. **PCI card-field lint — LIVE + NON-INERT.**
   - `eslint.config.mjs:17/39/127` imports `no-pci-card-fields.mjs`, registers the `brain-pci` plugin, and sets `'brain-pci/no-pci-card-fields': 'error'` — mirroring the precedent brain-money/brain-redis wiring.
   - `npx eslint --print-config packages/razorpay-mapper/src/index.ts` → `"brain-pci/no-pci-card-fields": [2]` (resolves at severity 2). **Reproduced.** This is the exact inverse of the prior-review reproduction where the rule was ABSENT.
   - **Non-inert proof:** planted `const card_last4 = "4242"` in a temp file → rule FIRED with the full C4/PCI-SAQ-A message → tmpfile removed. Real mapper `npx eslint packages/razorpay-mapper/src/index.ts` → **exit 0** (the `CARD_FIELDS_BLOCKED` Set lists names as string literals, so the boundary file lints clean naturally; no broad eslint-disable needed). The +3-line mapper diff is a comment only — no logic change.

2. **C5 log-grep gate — LIVE + NON-INERT.**
   - `tools/eslint-rules/log-grep-gate.mjs` consumes `log-grep-patterns.json`; wired as `pnpm log-grep` (`package.json:12`) + a `log-grep-gate` job in `.github/workflows/pr.yml:76-90`.
   - **Non-inert proof (planted):** planted `pay_AbCdEf12345678` + `UTR1234567890123456` in a temp prod-path file → gate exited **1** with both DPDP_FINANCIAL **CRITICAL** hits naming the file/line. tmpfile removed.
   - **Clean direction:** gate scoped to `apps/` and `packages/` (the git-tracked prod source) → **PASS, exit 0, 0 leaks.**
   - **b5ce157 scope-narrowing audited — acceptable, no coverage gap.** `SCANNED_CATEGORIES` is {DPDP_FINANCIAL, OPERATIONAL_REF}. I confirmed against `log-grep-patterns.json` that all THREE bound Razorpay identifiers remain in scanned categories: `pay_[A-Za-z0-9]{14}` (DPDP_FINANCIAL), `UTR[0-9A-Za-z]{16,22}` (DPDP_FINANCIAL), `setl_[A-Za-z0-9]{10}` (OPERATIONAL_REF). Only the broad PCI-card-number regex was dropped from the source grep — and that coverage is now carried by the newly-live `no-pci-card-fields` ESLint rule (+ gitleaks/Trivy for committed secrets). The C5.3/ADR-RZ-10 mandate (raw Razorpay IDs) is fully in scope.

### SEC-RZ-L1 (LOW) — RESOLVED
`RedisDedupAdapter.ts` comment corrected to **FAIL-OPEN** with the age-gate + Bronze-idempotency rationale and an explicit "do not relabel as fail-closed" note; the catch block adds a structured, PII-free `razorpay_dedup_redis_down` `console.error` (eventId is opaque) wired to the error-rate monitor. The only behavioral change is the added error log — the fail-open semantics are unchanged.

### Regression / AUTO-BLOCK check — GREEN
- razorpay-mapper unit: **43/43 passed** (replicated live, real `vitest run`).
- The fix diff (8e63deb, b5ce157) touches ONLY `eslint.config.mjs`, `package.json`, the new CI job, the new tooling script, a +3-line mapper comment, and the adapter comment+error-log — **no integration/e2e logic is exercised by the diff**, so razorpayWebhookHandler.integration (10/10) and settlement-ledger-wiring.e2e (6/6) cannot have regressed. No green-before/red-now.
- Fix diff: **no new endpoint / tool / migration / secret**, **no new dependency version** (verified by diffing pnpm-lock/package.json), **no model/paradigm hit** (grep clean). Paradigm audit stays clean — tier-0 deterministic, $0 incremental model spend.

### Hard-rule deviation check — CLEAN
The prior bounce was itself an un-codified gate-skip (SEC-RZ-H1); the fix **codifies** both gates rather than skipping them. No dependency violation, no Single-Primitive violation, no compliance gap (the compliance gate is now enforced), no paradigm escalation. Nothing requires Stakeholder escalation beyond the standard gate.

### New tracked finding — SEC-RZ-L2 (LOW, non-blocking)
`log-grep-gate.mjs` scans the `REPO_ROOT` **filesystem**, not `git ls-files`, and does not exclude `.terraform/`. Locally this false-positives on a git-ignored Terraform provider binary. That binary is **absent from the CI `actions/checkout`**, so the CI gate is unaffected and remains non-inert (I confirmed clean PASS when scoped to the git-tracked `apps/`+`packages/` source). Dev-noise / robustness only. Recommend `--exclude-dir=.terraform` / `-I` / scan `git ls-files`. Does NOT gate the merge.

### Auto-candidate rule check — NOT triggered
Root cause "a contract-bound mandatory CI gate ships as a file but is not registered/enforced" is occurrence **#1** of a new pattern, distinct from the prior wired-to-nothing (runtime-consumer) and fixture-coverage themes. Below the ≥3-distinct-prior-run threshold. **No `rule-proposals/` file written; nothing appended to `pending-stakeholder-attention.md`.** Flagged as a WATCH: codify if a second connector repeats gate-file-without-CI-wiring.

### Ship mechanics
All product-code fixes are already committed on `feat/razorpay-settlement-connector` (8e63deb, b5ce157); the working tree carries only `.engineering-os/` orchestration files. There is no pending product `git add` — the branch is the integration unit. The Stakeholder gate (Stage 7) owns the merge/deploy decision. Product-code paths in scope of this run's fix (for the Stakeholder's reference):
- `eslint.config.mjs`
- `package.json`
- `tools/eslint-rules/log-grep-gate.mjs`
- `.github/workflows/pr.yml`
- `packages/razorpay-mapper/src/index.ts`
- `apps/core/src/modules/connector/sources/payment/razorpay/infrastructure/RedisDedupAdapter.ts`

## Gates re-run this session (captured)
1. `npx eslint --print-config packages/razorpay-mapper/src/index.ts` → `brain-pci/no-pci-card-fields: [2]` (RESOLVES — inverse of prior reproduction).
2. Planted `card_last4` → rule FIRED (C4 message); real mapper lint → exit 0.
3. `log-grep-gate.mjs` planted `pay_`/`UTR` → exit 1, 2× DPDP_FINANCIAL CRITICAL; clean `apps/`+`packages/` → PASS exit 0.
4. `pnpm --filter @brain/razorpay-mapper test:unit` → 43/43.

## Decision
**PASS → Stakeholder gate (Stage 7).** SEC-RZ-H1 + SEC-RZ-L1 RESOLVED and independently re-verified; the previously-dead C4/C5 gates are live and non-inert; the prior-passing suite is green; over-engineering / paradigm / hard-rule / negative-control all clean. One LOW non-blocking robustness finding (SEC-RZ-L2) tracked to the Stakeholder. No rule proposal triggered.

## Journal (appended to cto-advisor.journal.md)
```
## 2026-06-18T01:25:00Z — Engineering Advisor (final-reviewer) — feat-razorpay-settlement-connector
Stage 6 · DELTA · Verdict: PASS · Paradigm audit: clean (tier-0 deterministic, $0 model spend; fix adds no model call/dep)
Gates re-run: eslint --print-config no-pci-card-fields=[2] (RESOLVES) · planted card_last4 FIRES + mapper lint exit 0 · log-grep planted pay_/UTR exit 1 (2× DPDP CRITICAL) + clean apps/packages PASS · mapper unit 43/43
SEC-RZ-H1 RESOLVED (C4 lint + C5 log-grep live, non-inert, CI-wired; b5ce157 narrowing keeps pay_/UTR/setl_) · SEC-RZ-L1 RESOLVED (FAIL-OPEN comment + redis-down error log). New SEC-RZ-L2 (LOW, non-blocking: gate scans FS not git, .terraform local-only false-positive). Regression green, no new endpoint/tool/migration/secret/dep. Hard-rule clean. No auto-candidate rule (occurrence #1 of new pattern).
Next: stakeholder gate (Stage 7).
```
