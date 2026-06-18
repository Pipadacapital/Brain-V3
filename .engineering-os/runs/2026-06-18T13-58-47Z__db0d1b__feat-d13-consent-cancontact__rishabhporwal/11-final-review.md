# 11 — Final Review: feat-d13-consent-cancontact

**Stage:** 6 (Engineering Advisor, final review — go/no-go) · **Lane:** HIGH-STAKES (compliance / PII / consent / the single outbound chokepoint I-ST05)
**Regime:** DPDP 2023 + TCCCPR/DLT + NCPR/DND (COMPLIANCE.md, ratified 2026-06-15)
**Reviewer:** Engineering Advisor (Opus tier) · **Date:** 2026-06-18
**Upstream:** QA = BUILD-OK (FULL) · Security = PASS (FULL; CRITICAL 0 / HIGH 0 / MED 0 / LOW 2)

---

## Recommendation

**APPROVE → Stakeholder gate (Stage 7).** This is a compliance-regime surface; it was reviewed as such. Every THE-invariant was verified at file:line, three QA gates were independently re-run live with captured PASS output, the Security isolation control was confirmed genuinely NON-INERT, and the over-engineering / hard-rule / negative-control checks are clean. Nothing drifted from the requirement.

**Residual risk (one line):** the DLT + NCPR/DND registries are shipped as dev-honest default-closed *stubs* (block, never fake) — so today every phone-channel (whatsapp/sms) marketing send BLOCKS by construction; real TRAI-DLT + NCPR integration is a tracked platform follow-up and MUST land before any phone-channel marketing send can succeed. This is the intended, documented, fail-closed posture — not a gap — but it is the live constraint a stakeholder must know.

---

## Drift check (requirement → built)

No drift. Every deliverable in `01-requirement.md` is present and matches `05-architecture.md` §6 track targets 1:1:
- Consent SoR (additive migration) — `db/migrations/0033_consent_record_tombstone.sql` (renumbered from the plan's 0032; 0031 already existed — cosmetic, see Hard-rule note).
- consent-suppressor consumer (stream-worker, existing pattern, no new deployable) — `apps/stream-worker/.../ConsentSuppressorConsumer.ts`, wired in `main.ts` on the EXISTING `dev.collector.event.v1` topic, distinct group `stream-worker-consent-suppressor`.
- Real `can_contact()` engine replacing the `return true` stub — `apps/core/.../compliance/can-contact.engine.ts` + the per-check policies.
- UI (mandatory, stakeholder-visible) — `apps/web/app/(dashboard)/settings/consent/` + 5 `components/consent/*` cards, data via BFF only.

File set is proportionate to the plan; no files/abstractions/deps beyond the three sanctioned tracks. **Over-engineering audit: CLEAN.**

---

## THE-invariant verification (file:line)

| Invariant | Verdict | Evidence |
|---|---|---|
| `can_contact()` is the SOLE send gate (I-ST05); no direct provider path | PASS | `emailAdapter.send()` appears ONLY in `notification.service.impl.ts:56,106,155` (the chokepoint module). Grep of `apps/core` + `apps/stream-worker` found no SES/WhatsApp send outside the notification module. |
| DEFAULT-CLOSED at every step; no unknown→allow | PASS | `can-contact.engine.ts:75-148` — ordered checks; every non-affirmative branch returns `block`/`queue`. `ncpr.policy.ts:16-23` (`unknown`→block), `dlt.policy.ts:13-17` (not-approved→block), `consent.policy.ts:20-26`, `send-window.policy.ts:83-92` (unparseable→`{inWindow:false, releaseAfter:null}`→block). |
| Transactional carve-out is the ONLY allow-without-consent path (documented) | PASS | `can-contact.engine.ts:81-87` (purpose==='transactional'→allow, no hashing/lookup). Mirrored fail-closed in the unwired path `notification.service.impl.ts:204-212`. |
| Salt-miss HARD-CRASHES (no silent allow) | PASS | `salt.adapter.ts:17-24` throws on missing/wrong-length salt; `can-contact.engine.ts:92` propagates (not caught into allow). Unit-proved: `can-contact.engine.test.ts:287-298` asserts `.rejects.toThrow`. |
| 9–9 IST SERVER-enforced; out-of-window→queue (never drop, never late); fail-closed clock | PASS | `send-window.policy.ts` — fixed UTC+05:30, `[09:00,21:00)`. Boundary mutants killed: `can-contact.engine.test.ts:302-326` (09:00 IN, 21:00 OUT, 20:59 IN, pre-09:00 same-day release). |
| pending-window flush RE-RUNS the full gate | PASS | `pending-window.handler.ts:108-134` re-calls `engine.evaluate(...)` per due row; allow→released, block→blocked (mid-queue withdrawal suppresses), still-OOW→re-queued with bumped release_after; `resolveRecipient===null`→left queued (never flush blind, line 102-106). |
| consent_record/tombstone keyed on hashed subject_hash; NEVER raw PII | PASS | Migration `0033_consent_record_tombstone.sql:42,86` (subject_hash TEXT, 64-hex). Live e2e asserts `^[0-9a-f]{64}$`, no `@`, `!= email` (`consent-suppressor.e2e.test.ts:316-336`). `send_log` persists `subject_hash` only, refuses raw recipient (`send-log.ts:78-100`). |
| RLS ENABLE+FORCE, two-arg fail-closed, NON-INERT under brain_app | PASS | `0033_consent_record_tombstone.sql:67-72,110-115` ENABLE+FORCE+NN-1 two-arg; Assertion-1 (NN-1), Assertion-2 (append-only), Assertion-3 (FORCE) at lines 125-198. Live e2e ran under `brain_app` (beforeAll hard-fails on `current_user='brain'`, asserts `brain_app` before every count, cross-brand → 0 rows). |
| Append-only-by-GRANT on consent tables | PASS | `0033_consent_record_tombstone.sql:74-75,117-118` (SELECT,INSERT only); migration Assertion-2 + live e2e test 7 both assert no UPDATE/DELETE grant. |
| consent-suppressor reuses the consumer pattern — no new deployable (I-E05) | PASS | `ConsentSuppressorConsumer.ts` mirrors CollectorEventConsumer/IdentityBridge; `main.ts:47,133-134` same topic, distinct group, same pod. |
| DLT/NCPR dev-honest (no faked approval; default-closed) | PASS | `stubs.ts:18-31` (DLT→false, NCPR→'unknown'); boundary documented inline + journal. |

---

## QA gate spot-re-run (≥3, captured)

| Gate | Re-run command | Result | Negative control / mutant |
|---|---|---|---|
| can_contact engine (default-closed + IST boundaries) | `vitest run .../can-contact.engine.test.ts` | **18/18 PASS** | salt-crash asserts `.rejects.toThrow` (not allow); 09:00/20:59/21:00 IST boundary mutants killed; every unknown→block/queue; subjectHash matched `^[0-9a-f]{64}$` |
| consent-suppressor live e2e (real Postgres) | `vitest run .../consent-suppressor.e2e.test.ts` | **10/10 PASS** | NON-INERT: ran under `brain_app`; cross-brand BRAND_B→0 rows of BRAND_A; no-GUC→0 rows; replay 3×→same rows; subject_hash 64-hex, no `@` |
| full notification module | `vitest run src/modules/notification` | **20/20 PASS** | confirms sole-gate wiring + dev-link capture, no regression |

All three replicate the QA PASS with captured output. **No bypass-green, no inert probe, no tautological parity.** Verification-validity: CONFIRMED.

---

## Reconciled findings table

| # | Source | Severity | Finding | Disposition |
|---|---|---|---|---|
| S-1 | Security | LOW | (non-blocking; per Security PASS) | Carried as residual; non-blocking. |
| S-2 | Security | LOW | (non-blocking; per Security PASS) | Carried as residual; non-blocking. |
| A-1 | Advisor | LOW (info) | Migration renumbered 0032→0033; two files share the `0033_` prefix (`consent_record_tombstone`, `send_log`). | NOT a defect. `node-pg-migrate` keys each migration on its full filename and orders alphabetically; the two are independent (no inter-dependency), so the ordering is safe and both run as distinct migrations. Cosmetic deviation from the plan number only (0031 pre-existed). |
| A-2 | Advisor | LOW (info) | `send-log.ts:66-76` emits a `recipient_masked` (first-char + `***@`) stdout line. | Pre-existing transactional-log discipline, not introduced by this run; the COMPLIANCE.md log-grep gate targets full `email=`/`phone=` literals which the mask does not trip. Persisted columns carry `subject_hash` only. Acceptable. |

**Blocking findings: NONE.** CRITICAL 0 / HIGH 0 / MED 0.

---

## Over-engineering audit

CLEAN. File set maps 1:1 to plan §6 tracks A/B/C. No new deployable, no new topic, no new hasher (reuses `@brain/identity-core`), no new RLS variant (verbatim NN-1), no second consent model, no second gate. Cost paradigm honored: pure deterministic logic, 0 tokens/day, $0/mo — correct for a fail-closed compliance gate (a model call here would be a compliance liability). No WHAT-comments of note; the policy split (consent/dlt/ncpr/send-window) is justified DDD, not speculative abstraction.

---

## Hard-rule deviation check

No hard-rule deviation requiring Stakeholder escalation:
- Dependency / Single-Primitive: CLEAN (extends `canContact`, reuses identity-core, the consumer pattern, the consent_flags envelope, audit_log, the NN-1 template).
- Compliance gap: NONE — the four-category consent SoR, the <15min withdrawal suppression (direct-SoR read), the 9–9 window + pending_window, and PII-hashing all satisfy COMPLIANCE.md's enforced controls.
- Paradigm escalation beyond plan: NONE (deterministic, as planned).
- Gate-skip: NONE — all QA gates ran; 3 independently re-run here.
- Migration numbering deviation (0032→0033): cosmetic, codified by the run prompt as expected; not a gate-skip.

---

## Risks remaining (for the Stakeholder)

1. **Phone-channel marketing is BLOCKED by construction today** (DLT/NCPR stubs are default-closed). Real TRAI-DLT template registration + NCPR/DND registry are platform follow-ups that MUST land before whatsapp/sms marketing can send. Email marketing (consent + window) is fully live. (Intended fail-closed posture.)
2. **`pending_window` flush requires a recipient resolver** (`resolveRecipient`) backed by the send_service-role PII vault; in dev this is a fixture map. The prod KMS/vault-backed resolver is the wiring that activates the flush at scale — until wired, a queued row stays queued (fail-closed, never sent late). Confirm the prod resolver + the 09:00-IST scheduler trigger are in the deploy runbook.
3. **DPDP Consent Manager (Rules 2025, ~Nov 2026)** — the `source='consent_manager'` enum is forward-compatible; no action now, tracked in COMPLIANCE.md open decisions.

---

## Mechanical commit (on PASS — explicit product-code paths, no `git add -A`)

```
git -C "/Users/rishabhporwal/Desktop/Brain V3/worktrees/d13-privacy" add \
  db/migrations/0033_consent_record_tombstone.sql \
  db/migrations/0033_send_log.sql \
  apps/core/src/main.ts \
  apps/core/src/modules/analytics/index.ts \
  apps/core/src/modules/frontend-api/internal/bff.routes.ts \
  apps/core/src/modules/frontend-api/application/queries/get-consent-compliance.ts \
  apps/core/src/modules/notification/ \
  apps/stream-worker/src/main.ts \
  apps/stream-worker/src/application/ProjectConsentUseCase.ts \
  apps/stream-worker/src/infrastructure/pg/ConsentRepository.ts \
  apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts \
  apps/stream-worker/src/tests/consent-suppressor.e2e.test.ts \
  apps/web/app/\(dashboard\)/ \
  apps/web/components/consent/ \
  apps/web/components/dashboard/brand-switcher.tsx \
  apps/web/e2e/consent-compliance.spec.ts \
  apps/web/lib/api/client.ts apps/web/lib/api/types.ts apps/web/lib/hooks/use-consent.ts \
  packages/contracts/src/consent/suppression.ts packages/contracts/src/index.ts

git -C "/Users/rishabhporwal/Desktop/Brain V3/worktrees/d13-privacy" commit -m "feat(d13): real can_contact() consent/DND/window gate + consent SoR + suppressor + UI"
```
(Stakeholder owns the actual commit/merge; see `pending-stakeholder-commit.md`.)

---

VERDICT: PASS
