# 11 — Final Review (Stage 6 · Go/No-Go) — feat-m1-app-foundation

**Date:** 2026-06-15T18:12:00Z
**Agent:** Engineering Advisor (final-review hat) · **Stage:** 6
**Tier:** Opus (deep judgment) · **Authority:** VETO (expressed as BOUNCE)
**Upstream:** Security Reviewer PASS (r3) · QA Engineer PASS (r3)
**Verdict:** **PASS** · **Go/No-Go:** **GO** (→ Stakeholder gate, Stage 7)

> This review did NOT rubber-stamp the upstream PASS. The load-bearing checks were
> independently re-run on this machine against the live Postgres (`brainv3-postgres-1`)
> and a freshly-started `@brain/core`. Captured output below.

---

## 1. Independent Re-Runs (the load-bearing checks)

| Check | Command | Result (captured this run) |
|---|---|---|
| **Full suite** | `pnpm turbo run typecheck test:unit lint --force` | **75/75 tasks PASS**, 0 cached. core 55 tests, isolation-fuzz unit 18, web/stream-worker passWithNoTests. Matches QA r3. |
| **Isolation gate** | `pnpm --filter @brain/tool-isolation-fuzz run test:isolation` | **43 passed \| 2 skipped**. All **15** connector/pixel tests RAN with real assertions (5 positive `rows>0`, 10 negative `rowCount=0`). `pgAvailable=true` — NOT hollow no-ops. |
| **Negative-control proof** | (printed by pg.test.ts) | `policy_on=0 rows (expected 0), policy_off=1 rows (expected >0). RLS enforcement is REAL on non-superuser connection (isofuzz_app NOSUPERUSER NOBYPASSRLS).` |
| **DB role truth** | `SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='brain_app'` | `brain_app: rolsuper=f, rolbypassrls=f` — production app role cannot bypass RLS (I-S01). |
| **Production policy predicate** | `pg_policies` on connector_instance/pixel_installation | `TO {brain_app} USING (brand_id = (current_setting('app.current_brand_id', true))::uuid)` — identical two-arg predicate the test mirror uses. Mirror-policy ruling is sound. |
| **One-arg current_setting** | grep migrations | 0 real violations (only 2 comment lines warning AGAINST the one-arg form). |
| **Register smoke (live)** | `POST /api/v1/auth/register` on real PG | **HTTP 201**; row written with real `$argon2id$v=19$m=19456,t=2,p=1$…` hash (NN-5 params confirmed in Postgres). |
| **Protected route (live)** | `GET /api/v1/connectors`, `/api/v1/pixel/installation`, `/api/v1/connectors/shopify/install` (no session) | **HTTP 401 UNAUTHORIZED** on all three — routes mounted + guarded; "no mocked backend" is TRUE. |
| **Audit hash-chain (live)** | `SELECT action,entry_hash FROM audit_log` | Real sha256 hash-chain rows (`user.registered`, `user.logged_in`, `user.email_verified`) — L-02 live. |
| **Validity scan** | `validity_check.py --paths apps/core/src packages/db packages/audit tools/isolation-fuzz` | **clean (98 files)**, exit 0. 0 BYPASSRLS / tautological / superuser-DSN. |
| **Seed-fix authenticity** | inspect `pg.connector.test.ts` | Real `ON CONFLICT (brand_id, provider) DO UPDATE … RETURNING id`; captured id used for FK-dependent inserts; role created `NOSUPERUSER NOBYPASSRLS`; `pgAvailable` set from a real connection. ISO-SEED-01 fix is genuine, not a tautology. |

**Conclusion:** every gate the QA Engineer reported PASS was independently replicated. No bypass-green, no inert probe, no tautological parity. The ISO-SEED-01 fix (the run's pivotal correction) is real.

---

## 2. Success Journey + 6 Demos — Acceptance Map

| Step / Demo | Status | Evidence |
|---|---|---|
| 1. Register → Verify Email → Login | **MET** | Live smoke 201 register + real argon2id + audit row; verify-email/login confirmed in QA r2/r3. |
| 2. Workspace + Brand creation (Demo 2) | **MET-AS-SCAFFOLD** | Routes mounted+guarded, RLS-isolated, events via stub eventer; no E2E (Playwright) yet. |
| 3. Invitations org+brand (Demo 3) | **MET-AS-SCAFFOLD** | invite+member routes mounted; NN-7 compound PERMISSIVE RLS confirmed; no E2E yet. |
| 4. Connect Shopify (Demo 4) | **MET** | shopifyConnectorRoutes mounted, HMAC-first (NN-4), `secret_ref`-only; 401 without session confirmed live this run. |
| 5. Install Pixel + Verify (Demo 5) | **MET** | pixelRoutes mounted; real HTTP HEAD/GET verify; `install_token` is a public UUID tag (NOT a secret); 401 without session confirmed live. |
| 6. Dashboard Shell (Demo 6) | **MET** | 4 `/v1/dashboard/*` BFF endpoints HTTP 200 Postgres-only; honest "No Data Yet" cards (brand-summary/connection-status/data-status). No fake metrics, no chart lib. |

**Count: 4 MET, 2 MET-AS-SCAFFOLD, 0 GAP** on the core journey. No core step is a GAP → no NO-GO trigger on the journey axis. The 2 scaffolds are E2E-wiring-pending (code + routes + RLS real); acceptable under the requirement's "scaffold acceptable where allowed" + the LOW-E2E-01 residual.

---

## 3. Invariants / Non-Negotiables

| Item | Status | Note |
|---|---|---|
| NN-1 (3-GUC two-arg fail-closed RLS) | **PASS** | All 14 M1 RLS policies two-arg; 0 one-arg violations (verified in pg_policies this run). |
| NN-2 (`secret_ref`-only, no token bytes) | **PASS** | DDL + contract + entity; 0 forbidden `*_token/*_secret/*_ciphertext/*_key` credential columns. `install_token` = public pixel UUID, documented NOT a secret. |
| NN-3 (session revocation per route) | **PASS** | validateSession preHandler on every protected route; 401 confirmed live. |
| NN-4 (Shopify HMAC-first + single-use nonce) | **PASS** | HmacValidationError before any repo call; nonce single-use; tamper negative controls pass. |
| NN-5 (argon2id OWASP params) | **PASS** | `m=19456,t=2,p=1` asserted at startup + observed in the live hash this run. |
| NN-6 (isolation-fuzz all M1 tables) | **PASS** | All 14 tables; 15 connector/pixel tests REAL on NOSUPERUSER NOBYPASSRLS (independently re-run). |
| NN-7 (compound PERMISSIVE invite RLS) | **PASS** | 2 PERMISSIVE policies (brand-level + org-level) on `invite`. |
| L-02 (sha256 audit hash-chain) | **PASS** | Real `crypto` sha256 chain; live rows observed. |
| I-S01 isolation structural | **PASS** | `brain_app` NOSUPERUSER NOBYPASSRLS (DB truth); RLS kernel-enforced. |
| I-S09 secrets by reference | **PASS** | AwsSecretsProvider wired conditionally on `isProduction`; ARN-in-env in prod; fail-closed. |
| Roles = Canon 4 | **PASS (with Stakeholder note — §6)** | `owner/brand_admin/manager/analyst` exactly; CHECK-constrained; no custom roles/groups/SCIM. |
| Auth app-native (Authentik later) | **PASS** | D0.1 sanctioned at architecture; ADR-006-shaped JWT claims → later token-issuer swap, not a migration. |

**Invariants clean: YES.** No INVARIANT or frozen-ADR violation. NN-5 LOW (no dummy-hash timing channel on forgot-password) is a deferred LOW, not a fail.

---

## 4. Scope Discipline + Over-Engineering Audit

| Axis | Finding |
|---|---|
| **Migrations** | Exactly `0001_init … 0007_pixel` — the 6 M1 domains + foundation init. **NO** OLAP/ledger/metric/identity-graph/StarRocks-mart migrations. Vertical slice honoured. |
| **DB tables** | M1 tables only + Sprint-0 foundation (`audit_log`, `brand_keyring`, `app_user`, `_rls_demo` fuzz proxy). No `*_ledger`, `bronze.*`, `metric_definition`, `brain_id_alias`, `decision_log`. |
| **RBAC** | Exactly 4 canon roles; CHECK-constrained. No enterprise IAM creep. |
| **Connectors** | Shopify-only; Meta/Google = `coming_soon` flags, **zero backend, zero DB rows** (verified in GetConnectorStatusQuery + BFF). |
| **Frontend honesty** | "No Data Yet" empty states; values from BFF props only; no `mock/faker/dummy/simulate`; no charting lib in deps (echarts correctly deferred — no metrics in M1). |
| **Cost paradigm** | **Zero model/LLM calls on any M1 path** (grep clean: no litellm/@effort/claude/openai/gemini invocation). M1 is deterministic tier by construction → cost-routing audit is N/A and correctly so. `@brain/ai-gateway-client` is a wired-but-unused seam (Phase-1 pattern). No large-model creep. |
| **Observability** | `@brain/observability` carries `brand_id`+`correlation_id` (PII-redacted) on the span/log interface; request_id/correlation propagation is LIVE in the app (seen in smoke). The OTLP→Grafana-Cloud export is still a Sprint-0 **stub** (wires to real OTel when EKS/collector deploy) — a residual, not a gap, for a local-foundation slice (§5). |
| **Deps** | apps/core: fastify, @fastify/cookie, aws-sdk secrets-manager, argon2, pg + workspace pkgs. No heavy/unexpected runtime deps. No abstractions beyond plan. |
| **Single-Primitive** | Clean — extended existing packages (db 3-GUC, audit sha256, isolation-fuzz harness); no new deployable/service/DB. |

**Over-engineering: none found.** Files, deps, abstractions all trace to the plan. Plan length proportionate to high-stakes tier.

---

## 5. Honesty-of-"Done"

The run used REAL verification, independently confirmed:
- Suite genuinely runs (re-run this session, 75/75).
- Migrations applied live; RLS proven on a real NOSUPERUSER NOBYPASSRLS role with a policy-removal negative control (`policy_off=1 row` proves the canary fires).
- Register smoke is a real argon2id + sha256-audit write to Postgres (row observed this session).
- Protected routes return real 401s (no mocked backend).
- Validity scan independently clean.

**No claim was found unbacked by evidence.** The one nuance the Stakeholder should hold: "MET" for Demos 2/3 is MET-AS-SCAFFOLD (routes+RLS real, runtime E2E pending) — honestly labelled by QA, not overstated.

---

## 6. Stakeholder Decisions To Confirm (sanctioned deviations, not blockers)

1. **Role mapping (requirement vs Canon).** The raw requirement said roles = "Owner/Admin/Analyst/**Viewer** ONLY." The build follows the **Canon 4** (`owner/brand_admin/manager/analyst`) per STACK.md ADR-006 + the Stakeholder-resolved task header. Net effect: **there is no distinct "Viewer" role**; the requirement's "Viewer" was mapped to **`manager`**, and a **"Manager"** role exists (UI labels: Owner/Admin/Manager/Analyst). This is the correct Canon-over-raw-text call and was sanctioned at architecture (D0.2), but it IS a visible departure from the literal wording — confirm the Viewer→Manager mapping matches intent.
2. **Auth = app-native (not Authentik-backed) for M1.** D0.1: email/password/JWT in `workspace-access`, ADR-006-shaped so Authentik fronts later as a token-issuer swap. Intake-flagged conflict, resolved + alternative rejected with rationale. Confirm acceptance of app-native M1 auth.

---

## 7. Residual Risk Register (for Stakeholder visibility)

| ID | Sev | Item | Owner | Must close by |
|---|---|---|---|---|
| LOW-RATELIMIT-01 | LOW | No rate-limiting on auth (login/register/forgot) | backend | **Before public launch** (add @fastify/rate-limit) |
| LOW-E2E-01 | LOW | No Playwright E2E; Demos 2/3 are scaffold | QA | Before first production user (M1 post-gate) |
| LOW-MUTATION-01 | LOW | No Stryker mutation tooling | QA | M2 (set ≥75% on auth/connector) |
| LOW-COVERAGE-01 | LOW | No vitest coverage config | QA | M2 |
| ISO mirror-policy | LOW | Tests use mirror policy `TO isofuzz_*`; testing AS `brain_app` is strictly stronger (predicate identical) | tools | M2 hardening (not a blocker — NN-1 migration assertion covers prod policy) |
| LOW-STARROCKS-M01 | LOW | StarRocks engine row policy deferred (OSS allin1); 2 isolation tests skipped | data | Before first OLAP data flow (M1-data-spine, managed cluster) |
| OBS-STUB-01 | LOW | `@brain/observability` OTLP export is a Sprint-0 stub; correlation propagation live, Grafana export not | platform | When EKS/collector deploy (M1-pre-prod) |
| AUDIT-WORM-01 | LOW | Hourly S3 Object-Lock audit checkpoint job not yet deployed (hash-chain in-DB is live) | platform/security | Before first prod audit |
| SECRETS-PROD-01 | LOW | AwsSecretsProvider conditional wiring proven in code; prod runtime fetch (IRSA) not yet runtime-validated | backend/platform | First staging deploy |
| LOW-DEV-TOKEN-01 | LOW | DevEmailAdapter logs raw token in body_preview (dev-only) | backend | M2 |
| LOW-TIMING-01 | LOW | forgot-password no dummy-hash timing channel | backend/security | M2 |
| COLLECTOR-STUB | INFO | apps/collector > fastify@4 (GHSA) — TODO stub, no deployed server, zero exploitability | data | When collector is built (out of M1 scope) |

All residuals are LOW/INFO. None is a journey GAP, an invariant break, or a CRITICAL/HIGH.

---

## 8. Verdict + Rationale

**PASS → GO.** Recommendation: advance to the Stakeholder gate (Stage 7).

Rationale: the upstream Security (r3) and QA (r3) PASS verdicts were independently replicated on live infrastructure — suite 75/75, isolation 15/15 real on a non-superuser role with a firing negative control, register smoke writing a real argon2id hash + sha256 audit chain, protected routes returning real 401s, validity scan clean. All NN-1..NN-7 + L-02 hold. Scope is the M1 vertical slice with zero future-phase or enterprise creep and zero over-engineering; the cost paradigm is deterministic-by-construction (no model calls). 0 open CRITICAL/HIGH/MEDIUM. The two sanctioned deviations (Canon roles, app-native auth) are architecture-ratified and surfaced for Stakeholder confirmation. Residuals are all LOW with named owners and close-by dates. No hard-rule deviation requiring Stakeholder-only approval beyond the two confirmations above.

**No BOUNCE.** No bounce_target.

---

## 9. Mechanical Commit Command (on PASS — run by Stakeholder after gate)

Explicit product-code paths (no `git add -A`; run-artifacts/state are orchestrator-managed):

```bash
cd "/Users/rishabhporwal/Desktop/Brain V3" && \
git add \
  apps/core apps/web \
  db/migrations \
  packages/audit packages/contracts packages/db packages/pixel-sdk \
  tools/isolation-fuzz \
  package.json pnpm-lock.yaml && \
git commit -m "feat(m1): app foundation — Register→Login→Workspace→Brand→Invite→Dashboard→Connect Shopify→Install Pixel

Real RLS-enforced vertical slice on the frozen architecture. NN-1..NN-7 + L-02 verified.
3-GUC two-arg RLS on all 14 M1 tables (isolation-fuzz real on NOSUPERUSER NOBYPASSRLS).
App-native auth (argon2id, sha256 audit hash-chain), secret_ref-only connectors, HMAC-first Shopify,
honest 'No Data Yet' dashboard. Shopify-only; Meta/Google coming_soon. Canon 4 roles.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Journal

```
2026-06-15T18:12:00Z — Engineering Advisor (final-reviewer) — feat-m1-app-foundation
Stage: 6 · Verdict: PASS · Paradigm audit: clean (no model calls; deterministic-by-construction; no over-engineering)
Gates re-run: turbo 75/75 (captured), isolation 43/2-skip all-15-real (captured, neg-control proof printed), register smoke 201+argon2id (live PG), protected 401 ×3 (live), validity clean 98 files
Hard-rule check: no dependency/Single-Primitive/compliance violation; 2 sanctioned deviations (Canon roles, app-native auth) surfaced for Stakeholder confirm
Next: stakeholder gate (Stage 7)
```
