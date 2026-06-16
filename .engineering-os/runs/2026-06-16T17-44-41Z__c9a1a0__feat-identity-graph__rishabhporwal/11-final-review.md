# Final Review — feat-identity-graph

**Stage:** 6 (final review) · **Reviewer:** Engineering Advisor (final-review, Opus tier)
**Timestamp:** 2026-06-16T22:40:00Z · **req_id:** `feat-identity-graph` · **Branch:** `feat/identity-graph`
**Verdict:** **PASS** · **Recommendation:** **APPROVE → Stakeholder gate**

---

## Decision card

| Field | Value |
|---|---|
| **Recommendation** | **APPROVE** |
| **Residual risk (one line)** | The phone-guard re-eval job processes **0 brands** (RLS blocks `brain_app` from enumerating `brand`) — suppressions never expire, so over-suppression accumulates monotonically. **Fail-closed** (never under-suppresses → no false-merge, no leak), fully **recoverable** via fix + replay. Acceptable for M1 (synthetic/internal, low volume); **must-fix before prod scale.** |
| **AC unmet** | none |
| **Blocking findings** | 0 |
| **Both gates** | Security PASS (0 blocking), QA PASS (0 blocking) — both verdict JSONs confirmed `PASS` / `blocking:0`; negative controls real |

---

## 1. Requirement delivered — AC → evidence

The requirement's six success assertions are all binary and all proven. I re-ran the spine myself rather than trusting the artifacts.

| AC (requirement §) | Evidence (independently verified) | Status |
|---|---|---|
| Bronze event → stable `brain_id` (deterministic) | `IdentityResolver.resolve()` pure domain (0-match mint / 1-match link / ≥2 merge); `@effort("deterministic")` on `ResolveIdentityUseCase` (line 3); zero model calls (grep clean) | MET |
| Same identifier → same `brain_id` | e2e "Deterministic merge: same email 2 events → 1 brain_id" PASS; resolution is real-SHA-256 hash-equality on `(brand_id, type, value)` | MET |
| India COD phone-guard prevents false-merge | `SharedUtilityPolicy` windowed threshold (`brand.phone_guard_threshold` DEFAULT 10, `suppression_window_days` DEFAULT 30, **configurable, not hardcoded**); N=10 boundary test: 11th event suppresses, 10 stay distinct, 0 merge_events | MET |
| No raw PII in graph/analytical store | `identity_link.identifier_value` always 64-hex (`/^[0-9a-f]{64}$/`); `IdentityRepository` writes `id.hash` only; raw `pii.raw_value` flows to `contact_pii` exclusively; audit `detail` carries hashes+types only | MET |
| Brand-isolated (the ONE invariant) | **Re-verified live under `SET ROLE brain_app`:** no-GUC `identity_link` → **0 rows**; all 8 tables `relrowsecurity=t` AND `relforcerowsecurity=t`; two-arg fail-closed; NN-1 assertion block present | MET |
| Idempotent (replay 3× → 1) | Deterministic `merge_id = sha256(brand‖canonical‖merged‖rule_version)`; `ON CONFLICT DO NOTHING` on PK + both UNIQUE PARTIALs; replay-3×→1 test PASS | MET |
| Rebuildable from Bronze | Bridge is a derived async writer off the same event source; real SHA-256 (replay-stable) + idempotent writer = identical reconstruction | MET |

---

## 2. Spine spot-verification (code-read, not artifact-trust)

- **Per-brand salt hard-fail (D-2, the isolation heart):** `SaltProvider.forBrand` (`SaltProvider.ts:88-123`) throws on getSecret failure, empty value, hex-decode failure, AND `salt.length !== 32` — **never** falls back to empty/default/global salt. Note: `Buffer.from(hex,'hex')` silently truncates on a bad char, but the 32-byte length guard catches that truncation → still hard-fails. Sound. Cross-brand-differs proven (saltA≠saltB → hashA≠hashB).
- **No raw PII in `identity_link`:** confirmed by code path (`IdentityRepository.ts` writes only `id.hash` to `identifier_value`) + 64-hex regex test + grep proof.
- **`contact_pii` dual-gate (D-3):** policy at `0017:239-244` requires `brand_id = current_setting('app.current_brand_id', TRUE)::uuid AND current_setting('app.role', TRUE) = 'send_service'` — both two-arg fail-closed. Repository sets `app.role='send_service'` transaction-locally only for the contact_pii writes; transaction-scoped GUC does not leak past COMMIT. Negative control (brand set, no role → 0 rows) verified.
- **RLS FORCE fail-closed:** brand table itself is `t|t` — which is precisely why the re-eval job is blind (see §4).
- **Phone-guard suppression:** threshold-configurable, windowed, `suppressed_until` computed from brand config in the domain layer (load-bearing path correct).
- **Idempotent merge:** deterministic `merge_id` + `ON CONFLICT DO NOTHING` everywhere.

### Gates re-run independently (≥3 required)
1. **Identity e2e suite:** `26/26 PASS` (79ms, vitest, live PG as `brain_app`).
2. **Typechecks:** `@brain/identity-core` EXIT 0; `@brain/stream-worker` EXIT 0.
3. **RLS no-GUC negative control:** `brain_app` + no GUC → `identity_link` = **0 rows** (fail-closed fires).
4. **Re-eval reality:** superuser sees **171** active brands; `brain_app` sees **0** — SR-01 root cause confirmed at the DB layer.

All replicated. No PASS I could not reproduce.

---

## 3. Both gates PASS legitimately + negative-control validity

- **Security:** `PASS`, `blocking:0` (SR-01 MED open, SR-02/03 LOW). All spine checks "confirmed".
- **QA:** `PASS`, `blocking:0`; 26 non-inert tests; `negative_control[]` carries two real captures (cross-brand RLS; contact_pii dual-GUC), both showing superuser-sees / brain_app-doesn't — **non-tautological, non-inert.** I independently reproduced the same asymmetry (superuser=1/171, brain_app=0), so the negative controls are valid. The QA note that `validity_check.py` exited 3 is an automated-scanner flag resolved by the in-session manual captures; the captures are genuine. No bypass-green, no inert probe.

---

## 4. Deferred-item dispositions

| ID | Sev | Disposition | Rationale |
|---|---|---|---|
| **SR-01 / QA-04** (re-eval gap) | MED | **ship-as-techdebt (M1); P1 must-fix before prod scale** | See the call below. |
| SR-02 (window_days literal 30) | LOW | ship-as-techdebt | Cosmetic; reference-only column. `suppressed_until` (load-bearing) is computed from `brandConfig`. |
| QA-01 (no trace IDs in bridge) | LOW | ship-as-techdebt | Observability gap; post-M1 observability pass. |
| QA-02 (salt-fail not tested at offset-commit) | LOW | ship-as-techdebt | Code path correct (throw propagates → offset not committed); add consumer-layer integration test post-M1. |
| QA-03 (stale dist with stubSha256) | LOW | ship-as-techdebt | Verified: `package.main = src/index.ts`; dist unused at runtime and by tests. Add CI build/clean step. |
| SR-03 (pre-existing dep vulns) | LOW | ship-as-techdebt | Not introduced by this branch (only new dep is `@types/node` devDep); track on platform debt backlog. |

### The re-eval-gap call (SR-01/QA-04) — the one to weigh

`phone-guard-reeval.ts` connects as `brain_app` (DB_URL default at lines 31-32) and runs `SELECT id FROM brand WHERE status='active'` with **no brand GUC**. Because `brand` has FORCE RLS, that returns **0 rows** (verified: superuser=171, brain_app=0). The job loops over an empty set and silently no-ops every run. The inline comment (lines 41-42) claims "we use the superuser connection for brand enumeration" — this is **aspirational and wrong**; no superuser pool is wired. So:

- **Effect:** once a phone is suppressed, it is **never un-suppressed** → over-suppression accumulates. A legitimate repeat customer whose phone got caught in a burst stays split (shattered LTV) until the job is fixed.
- **Direction:** **fail-closed.** It never *under*-suppresses, so it never causes the worse failure (false-merge / ghost high-LTV customer). No data leak, no isolation breach.
- **Recoverability:** full — fix the enumeration (SECURITY DEFINER function or a scoped/superuser enumeration pool), run the job, suppressions re-evaluate. The graph is rebuildable from Bronze.

**Verdict: acceptable for M1, NOT a ship-blocker.** M1 is synthetic/internal, low volume — over-suppression accumulation is slow and the recovery is mechanical. The failure mode points the safe way (the spec weights false-merge as the worse outcome; this errs toward suppression). It becomes **must-fix before prod scale** (real India COD volume) and is a **P1 post-M1**. The Stakeholder should accept it as tracked techdebt with that condition, and should also note the misleading comment so the fix isn't deceived by it.

This is **not** a hard-rule deviation (no dependency violation, no Single-Primitive violation, no compliance gap, no un-codified gate-skip) — it is a known, documented MEDIUM the upstream gates already accepted as non-blocking. No Stakeholder-stop escalation required; it surfaces on the decision card as the residual risk.

---

## 5. Over-engineering + scope/canon audit — CLEAN

- **Files/deps/abstractions:** only new dependency is `@types/node` (devDep). No new runtime deps. `SaltProvider` thinly wraps the existing `SecretsProvider` (Single-Primitive preserved). `merge_rule` / `merge_candidate` / `pii_vault_reference` correctly **deferred** — fewer primitives, not more.
- **No new deployable:** bridge lives inside the existing `stream-worker` process (D-7). No new service/container/ADR/STACK change/argo manifest in the diff.
- **Migration 0017 additive (I-E02):** all `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`; down=DROP.
- **No canary:** correctly honored as Phase-4 deferral (ADR-010).
- **Cost paradigm:** Tier-1 deterministic, `@effort("deterministic")` on the writer, **zero model calls** (grep clean). Matches the plan exactly; no creep.
- **Plan length proportionate** to a high-stakes multi-tenancy + PII feature; no WHAT-comments observed in the spot-checked files.

---

## 6. Hard-rule deviation check — none

No dependency violation, no Single-Primitive violation, no compliance gap, no paradigm escalation beyond plan, no un-codified gate-skip. Nothing requires a Stakeholder-stop. Auto-approvable to the Stakeholder gate.

---

## 7. Retro (auto-candidate check)

Root cause of the one notable defect (SR-01/QA-04): **a system/cron job that must read across all tenants was written against the tenant-scoped `brain_app` role under FORCE RLS, so it silently reads 0 rows** — the exact shape of the standing memory note `dev-db-superuser-masks-rls.md` (RLS visibility surprises), now manifesting in the *opposite* direction (a job that needed cross-tenant breadth got tenant-scoped fail-closed). This is the first time this specific "cross-tenant system job vs FORCE-RLS enumeration" pattern appears in this run series; semantic recall does **not** show it repeating across ≥3 distinct prior runs. **No rule-proposal written** (auto-candidate threshold not met). Logged for watch: if a second cross-tenant batch/cron job hits the same blind-enumeration trap, that would be candidate #2 toward a durable rule ("cross-tenant system jobs need an explicit SECURITY DEFINER / scoped enumeration path, never the tenant role").

Positive note for the retro: the salt hard-fail, two-arg-both-GUC contact_pii gate, and replay-idempotency were all built correctly on pass-1 with real negative controls — the CTO bindings (D-1..D-7) folded into the plan as pass-1-REQUIRED acceptance items produced zero rework bounces.

---

## 8. Mechanical commit command (on APPROVE — Stakeholder executes)

Explicit product-code paths (no `git add -A`):

```bash
cd "/Users/rishabhporwal/Desktop/Brain V3"
git add \
  db/migrations/0017_identity_graph.sql \
  packages/identity-core/src/index.ts \
  packages/identity-core/package.json \
  apps/stream-worker/src/infrastructure/secrets/SaltProvider.ts \
  apps/stream-worker/src/domain/identity/IdentityResolver.ts \
  apps/stream-worker/src/domain/identity/SharedUtilityPolicy.ts \
  apps/stream-worker/src/application/ResolveIdentityUseCase.ts \
  apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts \
  apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts \
  apps/stream-worker/src/jobs/phone-guard-reeval.ts \
  apps/stream-worker/src/main.ts \
  apps/stream-worker/src/tests/identity.e2e.test.ts \
  pnpm-lock.yaml
# (per-slice commits 8ac9771 / a8a52d1 / dd96233 / c9278a3 already on feat/identity-graph)
```

Note: the slices were already committed per-plan; the Stakeholder gate is a merge/deploy decision, not a re-commit. The path list above is the authoritative product-code surface for this run (excludes run-artifact `.md` and `.engineering-os/live.log`).

---

## Decision

**PASS → APPROVE → Stakeholder gate (Stage 7).** Spine real and independently re-verified; both upstream gates legitimately PASS with real negative controls; over-engineering and hard-rule checks clean; the one MEDIUM (re-eval-gap) is fail-closed, recoverable, and acceptable as tracked M1 techdebt with an explicit must-fix-before-prod-scale condition.
