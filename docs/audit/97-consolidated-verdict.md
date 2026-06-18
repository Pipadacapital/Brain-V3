# 97 — CONSOLIDATED VERDICT (Round-2 Convergence, Authoritative)

**Chair:** CTO / Principal Architect (independent, no code attachment)
**Inputs:** 16 board reports + synthesis (00, 90–96), 24 independent persona reviews, 8 Round-1 reconciled theme reports.
**Method:** Every load-bearing claim re-verified against repository code this session. Reconcile, do not average — where the board over- or under-stated and a persona corrected it from code, the corrected position is taken.

---

## 1. THE VERDICT

# NO-GO — conditional-GO after a single, well-scoped Tier-1 hardening phase.

The board's NO-GO is **RIGHT and correctly calibrated** — neither too harsh nor too lenient. It is, on two themes (testing-devops and privacy-compliance), arguably **generous**.

This is not a verdict about code quality. The domain/metric core of this system is **genuinely above the industry median** — a versioned-immutable metric registry, a zero-model deterministic revenue kernel with a tolerance-0 parity oracle that has a real RED negative control, argon2id auth with rotating-refresh family-wipe, HMAC-first webhooks with server-derived brand_id, and hand-built `brain_app` money/RLS live tests that assert `is_superuser=false`. The NO-GO is driven by a **narrow, dense band of release-blocking defects** that are concentrated at three seams: the **runtime tenancy wiring**, the **deploy/observe/rollback substrate (which does not exist)**, and a **Compliance Canon that asserts as live at least six controls that are absent from code**.

The defining characteristic of this codebase: **the correctness kernel is sound; the operational scaffolding and the runtime enforcement of its own designed invariants are unbuilt or inert.** That is a buildable gap, not a rewrite — which is exactly why the verdict is *conditional*-GO, not flat NO-GO.

---

## 2. PERSONA VOTE TALLY

Counting the net go/no-go contribution of all 8 reconciled themes plus the board synthesis (96-go-no-go) and the negative-review board (15). Each theme moderator was an independent principal; their net-contribution line is their vote.

| # | Theme / Reviewer | Vote |
|---|---|---|
| 1 | architecture-code-api | CONDITIONAL-GO (no standalone CRITICAL; 5 Tier-1 P1s) |
| 2 | data-database-tenancy | NO-GO → conditional-GO after Tier-1 |
| 3 | identity-attribution | NO-GO (two independent P0s) → conditional-GO |
| 4 | security-isolation | NO-GO until SEC-01 fixed+proven → conditional-GO |
| 5 | reliability-prodreadiness | NO-GO (decisive; 5 P0s) → conditional-GO |
| 6 | scalability-cost | NO-GO for capacity headroom → conditional-GO |
| 7 | testing-devops | NO-GO (strongest single-theme argument) → conditional-GO |
| 8 | privacy-compliance | NO-GO (arguably generous) → conditional-GO |
| 9 | Board synthesis (96-go-no-go) | NO-GO (conditional-GO after Tier-1) |
| 10 | Negative-review board (15) | NO-GO |

**TALLY: NO-GO (ship today) = 10 / 10. CONDITIONAL-GO after Tier-1 = 10 / 10 (unanimous). Unconditional-GO = 0. Unconditional/permanent NO-GO ("needs a rewrite") = 0.**

**Consensus:** Unanimous NO-GO to ship today; unanimous that a **single bounded Tier-1 hardening phase** (no re-architecture) clears the path to GO. The architecture-code-api theme is the one that frames its own contribution as "conditional-GO" rather than "NO-GO" — but it explicitly defers to the cross-theme blockers (tenancy, deploy, compliance) for the system-level verdict, so it is not a dissent on the final call. **There is no principled dissent from the NO-GO-today / conditional-GO-after-Tier-1 position.**

### Principled dissents recorded (on severity, not on the verdict)
- **Bronze-as-Postgres severity** — board/one persona rated CRITICAL; reconciled to **HIGH** (code is honestly D-4 self-labelled; nothing is broken in prod today; the defect is undisclosed doc divergence + an unservable future promise, not an M1 correctness blocker).
- **Down-migrations severity** — board/DB-persona rated CRITICAL; reconciled to **MEDIUM** (snapshot-restorable append-only design makes forward-only defensible; the real defect is the *misleading declared* `migrate:down`).
- **Probe-absence severity** — prod-readiness rated CRITICAL; reliability rated HIGH; reconciled to **HIGH today, auto-escalating to CRITICAL** the instant a cluster exists (no Deployment exists to wedge yet).
- **LLM-cost severity** — capacity report rated CRITICAL ("1–2 orders of magnitude over budget, unbounded loop"); reconciled to **MEDIUM** — REFUTED in part: a hard `RESOLVER_MAX_OUTPUT_TOKENS=256`, `temperature:0`, one-call-per-NLQ, fail-closed-after-one-retry all exist (`client.ts:34,86`). The surviving finding is narrower: top model tier as default + no per-tenant cap + no gateway config in repo.

### Board claims REFUTED / corrected by the personas (taken as corrected)
- **"No revenue parity in CI; lint+unit+isolation only"** — REFUTED. `pr.yml:65,69` run `test:contract` + a real `test:parity` oracle at tolerance-0 with an explicit RED negative control. The genuine gap is narrower: StarRocks↔Bronze reconciliation + dbt-Silver build + replay-stability are absent from CI. Taking this correction matters because the board's framing would have **misdirected the hardening plan**.
- **"brain_app lives only in synthetic fixtures"** — REFUTED. `pr.yml:53` provisions `CREATE ROLE brain_app LOGIN NOSUPERUSER NOBYPASSRLS` and runs isolation/parity under it. This **narrows** the tenancy blast radius to prod/dev *runtime wiring* (app role + Terraform), and proves the fix harness already exists.
- **CI "through 0020" migration comment** — board rated HIGH (false-green schema); REFUTED-as-high → **LOW** doc-drift (`migrate:up` = `node-pg-migrate up` applies all 37; only a stale comment).
- **"No cost caps on the LLM call"** — REFUTED in part (see LLM-cost dissent above).

---

## 3. THE CENTRAL CROSS-THEME RESOLUTION — Is tenant isolation a CRITICAL given app-superuser, or mitigated?

This is the single most important reconciliation, because four themes touch it and they could appear to conflict.

**Resolution: it is a CRITICAL / P0 — designed-but-inert, not mitigated.** Three independently-verified facts compose:

1. **The app connects as the table-owning superuser.** `.env:3 DATABASE_URL=postgres://brain:brain`; `docker-compose.yml:20 POSTGRES_USER: brain`; Terraform provisions only `brainadmin` (`rds/main.tf:127`); `brain_app` has **zero hits across `infra/`**. Postgres does not enforce RLS — even `FORCE ROW LEVEL SECURITY` — against a table owner/superuser. Every one of the 30 fail-closed policies is therefore **inert at runtime**.

2. **The one place that *would* set the per-request brand context is itself broken.** `packages/db/src/index.ts:201-209` issues `SET LOCAL app.current_brand_id` as one `rawClient.query()` and the business query as a **separate** `rawClient.query()` with **no `BEGIN`**. Under autocommit, `SET LOCAL` dies with its own statement. The code's own comment (`index.ts:88`) admits this. The correct pattern exists three packages over — `metric-engine/deps.ts:46-50` `withBrandTxn` does `BEGIN → set_config(...,true) → COMMIT` — and was never backported to `@brain/db`.

3. **These two are coupled and self-breaking.** Fixing #1 (run as `brain_app`) without simultaneously fixing #2 turns every BFF read fail-closed to **0 rows** — the login path (`auth.service.ts:430,452`) returns `EMPTY_CONTEXT` for every user → total functional outage on cutover. They **must land in one change.**

The C-3 dispute ("RLS correctness depends on ad-hoc ctx-passing") is **resolved in the code's favour**: the BFF threads a consistent `QueryContext` with explicit `organization_id` WHERE clauses, so the *application-layer* isolation is genuinely well-designed. But application-layer filtering is the **only** line of defense today, because the database-layer defense is inert. The "scary RLS-fragility" framing is downgraded; the **CRITICAL stands** — a single forgotten WHERE, or the StarRocks sentinel no-op (`silver-deps.ts:124` `String.replace` is a silent no-op when the sentinel is absent), leaks cross-tenant with no second net.

**Why "not mitigated":** the proof harness already exists in CI (`pr.yml:53` runs the suite under real `brain_app`), which is genuinely reassuring — it means the fix is *provable*. But "provable once fixed" is not "mitigated now." For a multi-tenant Commerce OS whose entire value proposition is a trustworthy per-brand truth ledger, shipping with isolation inert at runtime is non-negotiably P0.

---

## 4. THE ELEVEN CTO QUESTIONS — honest answers

**1. Is it production-grade?**
**No — and not close on the operational axis.** The system **cannot build** (zero Dockerfiles; `main.yml:74` builds `-f apps/${app}/Dockerfile`), **cannot deploy** (ArgoCD apps point at `infra/helm/{core,stream-worker,web}` and `infra/k8s/` — all absent; helm tree is `README.md` + one authentik values file), **cannot be observed** (`packages/observability` is a self-declared Sprint-0 stub: `StubSpan.end()` is a no-op, counter sink is `console.info`, zero `@opentelemetry/*`/`prom-client`/`pino`/`sentry` deps), **cannot be rolled back** (`main.yml:197-207` is `echo` banners; the one composite alarm `observability/main.tf:138-149` has no `alarm_actions`/SNS), and on its core promise **loses events under a routine DB blip** (Redis dedup claims the slot at `ProcessEventUseCase.ts:160` *before* the durable Bronze write at `:193`). Each is independently launch-gating.

**2. Is it architecturally correct?**
**Mostly yes — this is the system's redeeming strength.** The domain decomposition, the versioned-immutable metric registry (`metric-engine/registry.ts`), the zero-model deterministic revenue kernel, the append-only ledger design, the accept-before-validate collector spool, and offset-after-write discipline are sound. Only 6 non-test files use `:any`. The debt is **provably localized to the HTTP edge** (two god-files: `bff.routes.ts` 2,554 lines / 46 routes / 8 positional params; `main.ts` 1,657 lines / 40 inline envelopes) and to a few seams (metric-engine absorbing a DB/RLS boundary; webhook security pipeline copy-pasted 3×). No design rot. This is the basis for conditional-GO over a flat rewrite.

**3. Is it scalable to 10,000 brands?**
**No — and not without two named re-architectures, but these bite at growth targets, not at launch.** The continuous ingest scheduler (`ingest-scheduler/run.ts:56-99`) is single-instance, sequential, re-pulls every connector every tick, with **no shard/lease** — a second replica only doubles the work (only per-connector `FOR UPDATE SKIP LOCKED` prevents double-execution). This is the real **~100-brand ceiling**. The second wall (~500 brands) is Postgres-as-Bronze: `bronze_events` (`0016`) is an unpartitioned heap with no TTL sharing IOPS with OLTP. The system is **fine below ~100 brands**; reaching 1k needs the work-queue + pooler + bronze partitioning; 10k needs the deferred lakehouse. Precisely located, not far-horizon.

**4. Is it secure?**
**The auth/crypto spine is genuinely strong; tenant data-plane isolation is inert at runtime (see §3).** Positives are real: argon2id with dummy-hash anti-enumeration, rotating-refresh with family-wipe, session-revocation denylist, RBAC, CSRF double-submit, HMAC-first webhooks with server-derived brand_id, per-brand CMK with ARN-only DB rows, prod fail-closed guards on JWT/cookie/KMS keys. **No unauthenticated route exposes tenant data; brand is never body-sourced.** But: RLS inert under superuser (P0), StarRocks analytics password defaults to a repo-public dev credential with no `isProduction` guard (`main.ts:191`, P1), the audit hash-chain forks under concurrent same-brand appends (non-locking SELECT-then-INSERT, no per-brand `seq`, P1), and the Silver OLAP gateway is opt-in by a sentinel string that silently no-ops if forgotten (P2).

**5. Is it resilient?**
**No.** Beyond the dedup-before-durable-write data-loss path (P0): the collector never implements `503 SPOOL_FULL`+`Retry-After` and the spool is unbounded (P0 — contract violation + shared-RDS exhaustion); per-(partition,offset) retry counters are in-memory across 9 consumers, so poison messages never reach the DLQ across restarts (P1); connector HTTP clients have no request timeout (P1); no circuit breakers anywhere (P2); no liveness/readiness probes and the stream-worker has no HTTP port to probe (P1, escalates to P0 once deployed); core `/health` is static with no dependency check. The recovery runbook (RB-2) is itself non-executable because it re-syncs the non-existent manifests.

**6. Is it maintainable?**
**Yes, with localized debt.** The core is clean and well-typed. The maintainability tax is concentrated and nameable: two HTTP-edge god-files, the webhook security pipeline duplicated 3× (~1,256 LOC — a HMAC/replay-guard drift hazard), `ratePct` and cursor/sync-state primitives duplicated across 5 files each (Single-Primitive violations), and 395 hand-rolled error envelopes with no shared helper. All are mechanical extractions, not redesigns.

**7. Is it cost-efficient?**
**Mostly, with one paradigm violation to correct.** The cost-routing discipline is largely honored — output is hard-capped at 256 tokens, temperature 0, one model call per NLQ, fail-closed after one retry. **But** the NLQ resolver defaults to the **most expensive model tier** (`DEFAULT_RESOLVER_MODEL = 'claude-opus-4-8'`, `client.ts:31`) for a schema-constrained selection a small model handles — a direct cost-routing-paradigm breach (defaulting to a large model where a small model clears the bar) — with **no per-tenant spend cap** and **no gateway config checked into the repo** (so the claimed prompt-caching is unverified). The capacity board's "1–2 orders of magnitude over budget" was overstated and is corrected to Medium; the cheaper-default-tier + per-tenant cap remain a P1 hardening item.

**8. Is it privacy-compliant?**
**No — and this is the most serious documentation-integrity failure in the audit.** `COMPLIANCE.md` (a ratified VETO Canon) asserts as **enforced** at least six controls that **do not exist in code**: (a) the crypto-shred erasure pipeline — `pii_erasure_log` has zero hits, the cited CI-gate evidence table is fictional; (b) the KMS-ciphertext PII vault — `pii_ciphertext` is a comment, not a column; `contact_pii.pii_value` is plaintext `TEXT` with no DELETE grant, so there is **no destruction primitive at all**; (c) DSAR / data export — zero source hits, not even flagged deferred; (d) the WORM S3-Object-Lock anchor + quarterly chain-walk verifier — zero implementation; (e) region-routing / mismatch hard-error — stored attribute only, no Checkov region-tag policy; (f) the per-brand audit `seq` (the chain PK is `id BIGSERIAL`, so a fork is *undetectable*). Under the compliance-engine doctrine, a Canon that overclaims live controls **is itself the breach**. Consent suppression + ad-platform deletion-request *is* genuinely production-grade — but that is not erasure.

**9. Is it next-phase-ready?**
**The foundation yes, the scaffolding no.** The clean core, versioned registry, parity oracle, and CI `brain_app` harness are an excellent base for Phase 2 (Authentik, Iceberg, lakehouse). But next-phase work cannot begin on an unbuilt deploy substrate, a stub observability layer, and a Canon whose claims diverge from code. Tier-1 is the prerequisite for *any* phase, including the next one.

**10. Production-grade overall?**
**No.** Five independent launch-gating P0s (deploy substrate, observability, rollback, tenancy runtime, event-loss-on-DB-blip + back-pressure) plus inert privacy controls. None require a rewrite; all close in one focused phase.

**11. Must-fix-before-prod vs deferred-tracked?**
- **Must-fix (P0, blocks any tenant data):** tenancy runtime (`brain_app` role + GUC-in-transaction, landed together + proven), Dockerfiles, one deploy-manifest toolchain + ECR push role + OIDC trust fix, observability backend + alert rules, wired rollback, dedup-after-durable-write, collector 503 back-pressure, attribution write-side wired into the live path + a clawback non-negativity clamp, erasure/DSAR built-or-the-Canon-reconciled, StarRocks prod-password fail-closed guard. **The createPool path must be proven under `brain_app` with a negative control, smoke must run in CI, and the StarRocks negative control must execute on a real engine in CI** — a green test under bypass is not a PASS.
- **Deferred-tracked (P1/P2, pre-1k-brand or hardening):** ingest work-queue + shard/lease, bronze partitioning/retention, connection pooler + statement_timeout, per-tenant LLM cap + cheaper default resolver, in-memory→durable retry counters, connector timeouts, probes (auto-escalates once deployed), error-envelope helper + wire-contract CI gate, idempotency-key enforcement on connector-connect/consent writes, audit-chain serialization, webhook-pipeline extraction, mutation/coverage floors, JSON→Avro on the wire, the dbt+StarRocks reconciliation CI job.

---

## 5. PRESSURE-TESTING THE NO-GO — is it too harsh?

A reviewer tempted to call NO-GO too harsh should weigh the single highest-confidence, single-board reliability finding the cross-exam confirmed: **the Redis dedup claims the dedup slot before the durable Bronze write**, so any routine RDS failover silently drops events, suppresses them for 7 days, and — because observability is a stub that emits the drop as a normal counter — **the loss is undetectable.** That alone would silently corrupt the financial-truth ledger this entire product exists to protect. Combined with inert tenant isolation and a Compliance Canon asserting controls that do not exist, NO-GO is not harsh; it is the floor. **The board got it right.**

The honest counter-weight, equally important: this is **unbuilt scaffolding over a sound core, not architectural rot.** There is no evidence of a doomed design. Every blocker is closable in one phase without a rewrite. That is why the verdict is **conditional**-GO, and why the company should fund the Tier-1 phase rather than reconsider the architecture.

---

## 6. THE BOTTOM LINE

**Ship nothing to a real tenant today. Fund one Tier-1 hardening phase (see 99-final-remediation-plan.md). Re-gate against the Tier-1 exit criteria — every fix proven under the production `brain_app` role with a negative control, smoke + isolation + parity + StarRocks negative-control all executing in CI, and the Compliance Canon reconciled line-by-line to code. On that exit, this is a GO.** The core is worth the investment; the gap is operational, not foundational.
