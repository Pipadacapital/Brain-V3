# Security Review — feat-razorpay-settlement-connector

**Stage:** 4 (Security Reviewer) · **Mode:** FULL (first review of a high-stakes payments surface)
**Reviewed:** 2026-06-18 · **Model:** Opus 4.8 (1M context) · **Branch:** feat/razorpay-settlement-connector
**Scope:** A+B diff (master...feat/razorpay-settlement-connector) — 31 files, ~5.7k insertions. Track C deferred (logged orchestrator decision — not reviewed, not a gap).

## Verdict: PASS (delta re-review supersedes the original BOUNCE — see DELTA RE-REVIEW below)

> The original FULL review (below) BOUNCED on SEC-RZ-H1. That finding is now **RESOLVED in 8e63deb** (both CI gates wired + re-proven non-inert by the delta re-review and the final reviewer). The historical bounce text is retained for the audit trail.

[SEC-RZ-H1 — RESOLVED in 8e63deb, delta re-review] One HIGH finding (SEC-RZ-H1): the C4 PCI card-field lint and the C5 log-grep gate — both bound by the contract as **mandatory CI gates** (C4.4, C5.3 / ADR-RZ-10) — are present as files but NOT wired into `eslint.config.mjs` or any CI workflow. The defense-in-depth backstop layer is dead code. The primary controls (mapper allowlist + boundary-hash) ARE live and proven non-inert, so there is no active data leak — but the mandated second layer that catches future bypass is absent. bounce_target = data-engineer (owns ADR-RZ-10 / C4 / C5).

Everything else verified PASS with file:line + live DB evidence under the real `brain_app` (non-bypassed) security context.

---

## Gate results (file:line evidence)

### HMAC-first / anti-spoof — PASS (with note SEC-RZ-M1)
- HMAC validated over the RAW body via `RazorpayHmac.validateWebhook` using `node:crypto timingSafeEqual`, hex-length-checked, fail-closed on missing sig/secret (`RazorpayHmac.ts:31-56`).
- Invalid/missing signature → 401, zero side effects. Proven NON-INERT: `razorpayWebhookHandler.integration.test.ts:300` forges a signature with the wrong secret, asserts 401 AND zero Kafka messages AND zero map rows (verified via superPool, so absence is real, not an RLS artifact). QA independently forced `hmacValid=true` → test went RED (qa-review.md:44).
- brand_id resolved ONLY from `resolve_razorpay_connector_by_account()` DB ROW, NEVER from the webhook body (`razorpayWebhookHandler.ts:281`; anti-spoof test :346).
- **NOTE SEC-RZ-M1 (MED, informational):** HMAC is not literally the first byte processed — the handler does `JSON.parse` → a read-only SECURITY DEFINER SELECT (`resolve_razorpay_connector_by_account`) → a Secrets Manager read to fetch the per-connector `webhook_secret`, THEN validates HMAC, THEN any write. All pre-HMAC ops are READ-ONLY (no Bronze, no Kafka, no mutation). This is the standard per-tenant-secret-lookup pattern and is acknowledged in ADR-RZ-7. The NN-4 invariant ("no side effect before HMAC") holds. Residual: an unauthenticated caller can force a DB+secrets lookup per request and can probe valid `account_id`s by response differentiation — a minor DoS/enumeration surface. Not a veto. Recommend a rate-limit / WAF rule on the route + uniform 401 timing. **Stakeholder waiver logged 2026-06-18 — SEC-RZ-M1 accepted as tracked tech-debt (MEDIUM, non-blocking); platform WAF/rate-limit hardening tracked.**

### Replay protection (C3) — PASS
- Age check: `event.created_at` older than 5-min window → 400 BEFORE any write (`RedisDedupAdapter.isWithinReplayWindow`, handler :246). Test :390 forces a 6-min-old event → 400.
- Redis `SET NX EX 600` event_id dedup → 409 before Bronze/Kafka (handler :267; adapter :42-52). Test :425 replays same event_id → 409.
- Both controls run in the receiver, before the live-lane emit — a security control separate from Bronze data-correctness dedup, exactly per C3.
- **NOTE SEC-RZ-L1 (LOW):** `RedisDedupAdapter.isDuplicate` fails OPEN on Redis unavailability (`RedisDedupAdapter.ts:48` returns false = allow). The doc comment at line 35 mislabels this "FAIL-CLOSED" while the code is fail-open. Acceptable for a replay control bounded by the 5-min age window + Bronze idempotency, but the comment is wrong and the security posture (replay window briefly widens if Redis is down) should be a conscious decision. Fix the comment; consider a metric/alert on Redis-down.

### Isolation / RLS FORCE (I-S01, MB-1, MB-5) — PASS (verified live under brain_app)
Direct DB checks, dev superuser `brain` excluded (it bypasses RLS — every assertion run under `SET ROLE brain_app`, is_superuser=off):
- `connector_razorpay_order_map`: relrowsecurity=t, relforcerowsecurity=t (pg_class). Policy two-arg fail-closed `current_setting('app.current_brand_id', TRUE)` (`0027_razorpay_settlement.sql:107-109`; NN-1 guard DO-block :434).
- **No-GUC negative control (NON-INERT):** brain_app + no GUC → `SELECT count(*) = 0` rows; superuser sees the 2 seeded rows (so the probe is not inert). brain_app + brand-A GUC → exactly 1 row, brand A only; cross-brand read for brand B → 0.
- `connector_instance` FORCE RLS = t. brain_app direct SELECT no-GUC → 0 rows.
- **SECURITY DEFINER enumeration (durable rule `system-job-force-rls-enumeration`) — NON-INERT:** `list_razorpay_connectors_for_settlement_repull()` prosecdef=t, proconfig=`search_path=public`. Under brain_app with NO GUC it returns the connected razorpay connector (1) and EXCLUDES the disconnected one — i.e. it defeats FORCE RLS by design while the bare SELECT returns 0. Both fns EXECUTE-granted to brain_app only; migration assertion DO-blocks SEC-RZ-0027a-f present and ran (migration applied).
- Re-pull job GUC ordering correct: enumerate via the fn with NO GUC (`run.ts:151/159`), then `set_config('app.current_brand_id',...)` per-brand AFTER, before any cursor read/write (`run.ts:377/429/461/495`). Overlap-lock `FOR UPDATE SKIP LOCKED` per cursor resource (:391-397).

### Secrets / 3-cred / disconnect (C2, I-S09) — PASS
- 3 creds stored as ONE composite bundle under a single `secret_ref`; only the ARN on `connector_instance` (`ConnectRazorpayCommand.ts:71-79`, NN-2). No credential values logged or in event payloads (:138-145).
- `webhook_secret` independently rotatable, key_id/key_secret preserved, same ARN (`RotateWebhookSecretCommand.ts:66-86`). Test :645 asserts key_id/key_secret unchanged.
- Disconnect: deregister webhook → `deleteSecret` (FAIL-LOUD) → status='disconnected' → halt (`DisconnectRazorpayCommand.ts:51-77`). Processing halts structurally because `resolve_razorpay_connector_by_account` filters `status='connected'` (verified live: disconnected acc_B → 0 rows → 401). Test :577 deletes secret → getSecret null → resolve returns 0 rows.
- Diff secret-grep (staged): no hardcoded key_secret/webhook_secret/private keys.

### DPDP boundary-hash (C1) — PASS
- `mapSettlementItemToEvent` applies the allowlist FIRST, then hashes `utr→utr_hash` / `payment_id→payment_id_hash` via `hashRazorpayId = sha256(saltHex ‖ normalized)`; raw values dropped in-frame, never in output (`packages/razorpay-mapper/src/index.ts:377-434`). Raw `razorpay_payment_id` lives ONLY in the RLS-protected map table; never in Bronze events, ledger, or logs.
- `settlement_id` PII assessment documented as opaque batch ref (not person-linkable) — cataloged in the mapper header.
- Unit tests 43/43 (real `vitest run`): C1 asserts raw utr/payment_id absent from the full-JSON serialization of emitted props (non-inert). C5 raw-ID log grep across the diff (webhook + re-pull + client): zero raw `pay_`/`UTR`/response-body log lines.

### PCI card-field allowlist (C4) — mapper PASS / lint FAIL (SEC-RZ-H1)
- Mapper allowlist is the authoritative live control and is enforced + tested: fixture carries all 7 `card_*` fields + a nested `card` object; UT-5 asserts NONE appear in output (`index.test.ts:202-218`, toHaveProperty + JSON.stringify not.toContain). Card data cannot reach Bronze through the mapper. **PASS.**
- **SEC-RZ-H1 (HIGH):** `tools/eslint-rules/no-pci-card-fields.mjs` is NOT imported or registered in `eslint.config.mjs` (grep count = 0; precedent rules no-float-money + no-raw-redis-key ARE wired). The rule never runs in `pnpm turbo run lint` / pr.yml. C4.4 / ADR-RZ-10 bind this as a "mandatory CI gate, not a code-review expectation." The defense-in-depth backstop that would catch a FUTURE code path bypassing the mapper is dead. **BOUNCE.**

### Log-grep gate (C5) — patterns landed / NOT wired (SEC-RZ-H1, same bounce)
- `tools/eslint-rules/log-grep-patterns.json` contains the bound patterns (`pay_[A-Za-z0-9]{14}`, `setl_[A-Za-z0-9]{10}`, `UTR[0-9A-Za-z]{16,22}`).
- The JSON is consumed by NO CI workflow or script (grep across `.github/workflows/**` and package scripts = 0). C5.3 binds the gate to land in the same commit as the connector code. The nightly log-grep job does not read these patterns → the gate is inert. QA explicitly deferred this to Security (qa-review.md:75). **Part of the SEC-RZ-H1 bounce.**

### Money / append-only / idempotency (I-S07, I-E02, I-ST04) — PASS
- All amounts BIGINT-as-string with `::bigint` casts; mapper `paisaToMinorString` rejects non-integer (throws — tested at `index.test.ts:1789`). LedgerWriter settlement methods use signed BIGINT strings, no parseFloat (`LedgerWriter.ts` settlement block). No float-money in the new path (diff grep clean except timestamps/sleep).
- Idempotency: `ON CONFLICT (brand_id, order_id, event_type, occurred_at::date) DO NOTHING` on every settlement write; entityType-discriminated uuidv5 event_id (MB-2) prevents correction-collapse. GUC set before every insert.
- Ledger writes are new signed rows (provisional row untouched); brand-level rows use synthetic `__brand_level__:settlement_id` spine key.

### Traceability — PASS
- correlation_id propagated from header → request → Kafka envelope + headers (`razorpayWebhookHandler.ts:116, 378-394`). PII-free structured logs (verified by C5 diff grep).

### Wiring (MB-4) — PASS
- `SettlementLedgerConsumer` instantiated (`stream-worker/src/main.ts:121`), `.start()` awaited (:183), `.stop()` in shutdown Promise.all (:137). QA un-wired `.start()` → e2e wiring test SW1 went RED (qa-review.md:34) — non-inert. Occurrence-#3 watch satisfied.

---

## Verification-validity check — PASS
- All isolation/auth assertions confirmed under real `brain_app` (NOSUPERUSER/NOBYPASSRLS — confirmed via pg_roles). My own DB probes used `SET ROLE brain_app` and showed the inverse (superuser sees rows, brain_app no-GUC sees 0) — non-inert.
- Negative controls present and captured RED by QA (forged HMAC→401, forced-true→RED; un-wired consumer→RED; no-GUC FORCE-RLS→22P02). 43/43 mapper unit re-run live by me (real `vitest run`, not skipped). No bypass-green, no inert probe, no superuser DSN in tests.

## Scanners
- Diff secret-grep + C5 raw-ID log-grep run by hand on the A+B diff → clean.
- gitleaks/TruffleHog/Semgrep/Trivy not installed locally (CI-only) — full suite is the pr.yml/main.yml gate; not re-run here. No new dependency versions introduced (pnpm-lock delta is workspace-internal).

## Findings summary
| ID | Severity | Status | One-line |
|---|---|---|---|
| SEC-RZ-H1 | HIGH | OPEN (BOUNCE) | C4 card-field lint (`no-pci-card-fields.mjs`) not registered in eslint.config.mjs + C5 log-grep JSON consumed by no CI job — both bound as mandatory CI gates (C4.4/C5.3); defense-in-depth backstop is dead. Primary mapper/hash controls are live, so no active leak. |
| SEC-RZ-M1 | MED | WAIVED | HMAC preceded by read-only JSON-parse + DB lookup + secret fetch (necessary for per-connector secret); no side effect before HMAC, but unauthenticated DB/secret lookup = DoS/enumeration surface. Recommend route rate-limit/WAF + uniform 401 timing. **Stakeholder waiver logged — accepted as tracked tech-debt.** |
| SEC-RZ-L2 | LOW | WAIVED | log-grep-gate scans filesystem not git ls-files (local-only .terraform false-positive; CI unaffected). **Stakeholder waiver logged — tracked tech-debt.** |
| SEC-RZ-L1 | LOW | NOTE | RedisDedupAdapter fails OPEN on Redis-down but comment says "FAIL-CLOSED"; bounded by age-window + Bronze dedup. Fix comment; add Redis-down metric. |

## Remediation for the bounce (small, surgical)
1. `eslint.config.mjs`: `import noPciCardFields from './tools/eslint-rules/no-pci-card-fields.mjs';` add plugin `'brain-pci': { rules: { 'no-pci-card-fields': noPciCardFields } }` and `'brain-pci/no-pci-card-fields': 'error'` in the TS rules block (mirror the no-float-money wiring). Add an `eslint-disable` on the mapper's `applyFieldAllowlist`/`CARD_FIELDS_BLOCKED` lines (the rule's own message instructs this) so the boundary file itself lints clean.
2. Wire `log-grep-patterns.json` into the nightly log-grep CI step (the job referenced by COMPLIANCE.md:172) so it actually reads the Razorpay patterns; add a CI assertion that the file is consumed.
3. Re-review as DELTA: scope = SEC-RZ-H1 + the changed config/CI lines only.

---

## DELTA RE-REVIEW — 2026-06-18 · Model: Opus 4.8 (1M context)

**Mode:** DELTA · **Verdict: PASS** · **Delta scope:** SEC-RZ-H1 + SEC-RZ-L1, the 2-commit fix diff (8e63deb, b5ce157), + a regression run of the 3 prior-passing suites.

### SEC-RZ-H1 (HIGH) — RESOLVED
- **PCI card-field lint now LIVE + NON-INERT.** `eslint.config.mjs:17,39,127` registers `brain-pci` plugin + `'brain-pci/no-pci-card-fields': 'error'`, mirroring brain-money/brain-redis. `npx eslint --print-config packages/razorpay-mapper/src/index.ts` → rule resolves at severity **2** (verified). Planted `const card_last4 = "4242"` in a temp file → rule FIRED with the C4/PCI-SAQ-A message → file removed (non-inert). Real mapper `npx eslint packages/razorpay-mapper/src/index.ts` → **exit 0, 0 errors** (the boundary `CARD_FIELDS_BLOCKED` lists names as string literals, so the rule passes naturally; no broad eslint-disable needed).
- **C5 log-grep gate now LIVE + NON-INERT.** `tools/eslint-rules/log-grep-gate.mjs` consumes `log-grep-patterns.json`; wired as `pnpm log-grep` (`package.json:12`) + a `log-grep-gate` CI job in `.github/workflows/pr.yml:71-90`. Planted `pay_AbCdEf12345678` + `UTR1234567890123456` in a temp prod-path file → gate exited **1** with both DPDP_FINANCIAL CRITICAL hits (non-inert). Clean git-tracked source has **0** Razorpay-ID leaks.
- **b5ce157 scope-narrowing assessed — acceptable.** `SCANNED_CATEGORIES` narrowed to {DPDP_FINANCIAL, OPERATIONAL_REF}, dropping PCI-card-number + broad PII (email/phone/PAN) regexes from the source grep. The C5.3/ADR-RZ-10 mandate is specifically the raw Razorpay identifiers (pay_/UTR/setl_) — all three remain scanned. PCI card-field coverage is now carried by the (newly-live) `no-pci-card-fields` ESLint rule; email/phone/PAN committed-secret detection is covered by gitleaks + structured-log redaction. No C5 coverage gap on the bound patterns.

### SEC-RZ-L1 (LOW) — RESOLVED
- `RedisDedupAdapter.ts:36-43` comment now reads **FAIL-OPEN** with the age-gate + Bronze-idempotency rationale and an explicit "do not relabel as fail-closed" note. The catch block (`:54-63`) emits `console.error(JSON.stringify({ msg: 'razorpay_dedup_redis_down', ... }))` — structured, PII-free (eventId is opaque), wired to the error-rate monitor.

### Regression suite (AUTO-BLOCK check) — ALL GREEN, no green-before/red-now
- razorpay-mapper unit: **43/43 passed** (real `vitest run`).
- razorpayWebhookHandler.integration: **10/10 passed**.
- settlement-ledger-wiring.e2e: **6/6 passed**.

### Regression check on changed lines
No new endpoint / tool / migration / secret introduced by 8e63deb or b5ce157. Diff touches only: eslint.config.mjs, package.json, mapper comment (+3 lines, no logic), a new CI job, a new tooling script, and the adapter comment+error-log. Diff secret-grep on the 2 commits: clean.

### New finding (LOW, non-blocking) — SEC-RZ-L2
`log-grep-gate.mjs` scans the **filesystem** (`REPO_ROOT`), not `git ls-files`, and does not exclude `.terraform/` or other vendored/git-ignored binary artifacts. Locally, `pnpm log-grep` reports `Binary file infra/terraform/envs/dev/.terraform/providers/.../terraform-provider-aws...x5 matches` and exits 1. That binary is **git-ignored and absent from the CI `actions/checkout`**, so the CI gate is unaffected (passes on the clean tree) and the gate is NOT inert. This is a local-dev noise / robustness gap only — recommend the gate add `--exclude-dir=.terraform`, `-I` (skip binary files), or scan `git ls-files` output. Non-blocking; does not gate the merge.

### Findings summary (delta)
| ID | Severity | Status |
|---|---|---|
| SEC-RZ-H1 | HIGH | RESOLVED (lint + log-grep both live, non-inert, CI-wired) |
| SEC-RZ-L1 | LOW | RESOLVED (FAIL-OPEN comment + redis-down error log) |
| SEC-RZ-L2 | LOW | NEW, non-blocking (gate scans FS not git; .terraform false-positive locally only) |

**DELTA verdict: PASS.** The prior HIGH bounce is cleared; the mandated CI gates are live and proven non-inert; the full prior-passing suite is green. → Reconcile with QA.
