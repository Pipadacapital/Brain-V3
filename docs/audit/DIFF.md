# Audit Diff — PRIOR vs THIS RUN (2026-06-19)

Comparison of two independent engineering audits of the Brain monorepo.

- **Audit A — PRIOR** — merged to `master` via PR #78 (`chore/engineering-audit`), at `docs/audit/` (root: `00`–`16` boards, `90`–`99` synthesis). 16 boards → 24 persona reviews → 8 reconciled themes → **2-round adversarial consolidation** (`97`/`98`/`99`).
- **Audit B — THIS RUN** — at `docs/audit/2026-06-19-21pass-review/`. 21 single-pass boards + synthesis (`00`, `23`–`30`).

> File-path note: in the sections below, bare filenames like `06-database.md` or `23-master-risk-register.md` refer to **Audit B** (`docs/audit/2026-06-19-21pass-review/`); the `97`/`98`/`99` consolidated files and `00`–`16` board files refer to **Audit A** (`docs/audit/` root). Code references (`packages/...`, `apps/...`) are repository paths and unaffected.

Both verdicts: **NO-GO for production.** Both attribute the gap to build-completeness + operational enforcement, not design. They diverge sharply on **why** — and on one crown-jewel control they flatly contradict each other.

---

## 1. Verdict & posture

| Audit | Verdict | Severity (as written in its files) | Method |
|---|---|---|---|
| **A — PRIOR** | NO-GO → conditional-GO after one Tier-1 phase | Board layer 33C/63H/66M/36L (198 raw) → reconciled to **67 ranked, 16 P0** | Two-layer; a second reconciliation round re-verified and **overturned** several board claims |
| **B — THIS RUN** | NO-GO | Register ranks **20**: 4C / 3H / 8M / 5L (board-level raw aggregate was ~117) | Single-pass boards + synthesis; no second reconciliation layer |

Scales are not directly comparable. Both converge to ~12–16 deployment blockers.

> **Number caveat for THIS RUN:** the workflow's raw return reported ~117 board-level findings, but B's own `23-master-risk-register.md` ranks only **20**. The synthesis under-consolidated — B's register is **not** comprehensive against its own board reports.

---

## 2. CONSENSUS — both audits independently flagged it (act on these first)

| Finding | Audit A | Audit B | Confidence |
|---|---|---|---|
| No deploy artifacts (0 Dockerfiles, empty Helm, ArgoCD→nonexistent paths) | R-03/R-04 CRITICAL/P0 | ARC-8 (register Medium/P3 **but** go/no-go P0-A — internal inconsistency) | Very high |
| Trivy/OSV scans silently skipped (`pr.yml:134-146`) | R-15 | ARC-8 / P0-B | Very high |
| No Argo CronWorkflows → revenue-finalization never runs | folded in deploy substrate | ARC-6 Critical | Very high |
| Collector durability = Postgres spool, contradicts ADR-003 disk WAL; Multi-AZ `create=false` | R-09 CRITICAL | ARC-3 High | Very high |
| Inert ESLint metric-engine boundary fence (`eslint.config.mjs:56`) | boundary debt (P2) | RS-1 Critical/P1 (sharper mechanism) | Very high |
| Duplicate `0033_*` migration | R-35 Medium | ARC-7 Medium | Very high |
| Cursor/sync-state logic duplicated 4–5× (both rejected a false GUC-drift sub-claim) | R-41 Medium | CQ-1 Medium | High |
| `dev_secret` plaintext OAuth tokens, no RLS | R-44/R-63 | `10-security.md:109-117` | High |
| `contact_pii` plaintext, not KMS vault doc-08 requires | R-12 CRITICAL | `06-database.md:54` + ARC-4 | High |
| BFF reaches into `workspace-access/internal`; dead `no-restricted-imports` rule | coupling debt R-39/R-42 | ARC-1 (sharper) | High |
| Stub bounded contexts (identity/billing/recommendation `.gitkeep`) | secondary / next-phase | ARC-4+ARC-5 **Critical** headline | High (fact); contested (severity) |

---

## 3. CONTRADICTION — runtime tenant isolation (the one that matters)

**Is RLS actually enforced at runtime?**

- **Audit A — NO, it is inert.** App connects as the table-owning superuser (`.env:3 postgres://brain:brain`; `docker-compose.yml:20`), so FORCE-RLS does not apply; and `@brain/db` runs `SET LOCAL` **outside any transaction** (`packages/db/src/index.ts:201-209` — two separate `rawClient.query()` calls, no `BEGIN`), so the GUC is discarded under autocommit. Isolation rests entirely on app-level WHERE clauses. (R-01/R-02/R-14)
- **Audit B — claims it is safe.** "No cross-tenant data exposure vector found" (`06-database.md:12`); "FORCE RLS prevents bypass" (`06:125`); "`withBrandTxn` enforces BEGIN→GUC→fn→COMMIT" (`20-multi-tenancy.md:12`).

**Ground truth: Audit A is correct.** `connect()` (`packages/db/src/index.ts:188`) does a bare `pool.connect()` with no `BEGIN`; `SET LOCAL` (`:203`) and the business query (`:209`) are separate autocommit statements. The repo's own test confirms it: `ad-spend-metrics.live.test.ts:25` — *"dev superuser 'brain' bypasses RLS — would be inert."* Corroborated by the project memory note *"Dev DB superuser masks RLS — only truly enforced under prod `brain_app`."*

**Why B missed it:** B verified the policy/migration layer (FORCE RLS present, `brain_app` NOBYPASSRLS) and the one correct path (`withBrandTxn` in `metric-engine/deps.ts`), but never checked **which role the running app connects as**, nor that the main BFF path (`@brain/db`) skips the transaction wrapper. This is B's most consequential **false-negative**: it clears the crown-jewel control that is in fact inert.

**This supersedes the "isolation holds in practice" line in `00-executive-summary.md:22`.**

---

## 4. UNIQUE to Audit A (missed/under-weighted by THIS RUN)

- **R-01/R-02/R-14** — runtime RLS inert (see §3). *Highest-priority item across both audits.*
- **R-08** — Redis dedup claims the slot **before** the durable Bronze write (`ProcessEventUseCase.ts:160` vs `:193`) → a routine DB blip permanently, silently drops events.
- **R-10** — attribution write-side is dead code; `attribution_credit_ledger` never populated in prod → every attribution surface reads 100%-unattributed, indistinguishable from honest no-data.
- **R-11/R-62** — clawback has no over-reversal guard → attributed revenue can go negative; rate formatter masks small negatives.
- **R-05** — observability is a Sprint-0 stub (no-op spans, `console.info` sink, zero OTel/Prom/pino/Sentry deps).
- **R-06/R-07** — "auto-rollback" is `echo` banners over an actionless alarm; no SLO/burn-rate/DLQ/lag alert rules (`main.yml:197-207`).
- **R-19** — audit hash-chain forks under concurrent same-brand appends (`BIGSERIAL` PK, no per-brand `seq`); Canon overclaims `PK(brand_id,seq)`.
- **R-27** — events produced as JSON not Avro; Apicurio registration decorative.
- **R-12/R-13/R-51/R-53** — `COMPLIANCE.md` (a VETO Canon) asserts ≥6 controls ENFORCED that don't exist (erasure, PII vault, DSAR, WORM, region-routing, audit `seq`).
- **R-26** — Order Silver mart built from OLTP ledger, not Bronze → Bronze-replay broken for finance.

## 5. UNIQUE to THIS RUN (missed/under-weighted by PRIOR) — B is sharper on static/boundary mechanics

- **RS-1** — exact inert-fence mechanism: `@boundaries/elements` matches descriptors in declaration order; `app` (`eslint.config.mjs:56`) precedes `core-module` (`:58`) so every `apps/core/**` file classifies as `app`; plus no `@brain/*` import resolver wired. `npx eslint …credit-writer.ts` exits 0.
- **ARC-1** — `no-restricted-imports` BFF guard dead: absolute globs never match relative `../../internal/` specifiers (`eslint.config.mjs:102-114`).
- **RS-4** — `attribution/index.ts` re-exports `analytics` journey-reads as `journeyReads` — cross-context re-export the `/internal/` rule can't catch.
- **RS-2/RS-3** — phantom prod deps: `mysql2` in metric-engine, `@brain/config` in core (zero importers).
- **DP-1** — `SharedUtilityPolicy` phone-guard is dead code; `IdentityResolver` reimplements it inline with different threshold semantics; unit tests exercise the dead path.
- **RS-5 / CQ-5** — Fastify v4 (collector) vs v5 (core) split; 8 stream-worker pools missing `idleTimeoutMillis`/`statement_timeout`.

---

## 6. Net assessment

- **Bottom line:** both NO-GO; agree it's a build/enforcement gap, not design rot; both prescribe one hardening phase.
- **More rigorous where they diverge: Audit A.** It ran a second adversarial reconciliation round (overturned several of its own board claims), and it is **correct on the single highest-stakes question** (runtime isolation), which THIS RUN got wrong.
- **THIS RUN is sharper on static analysis / boundary-enforcement mechanics** (the lint diagnoses, phantom deps, dead policy).
- **The trustworthy artifact is the union:** THIS RUN's lint/boundary precision layered onto the PRIOR audit's runtime/operational rigor — with the PRIOR audit winning every runtime-correctness disagreement.

**#1 action item across both audits:** runtime tenant isolation is inert (A's R-01/R-02). Do not rely on this run's clean bill of health for multi-tenancy.
