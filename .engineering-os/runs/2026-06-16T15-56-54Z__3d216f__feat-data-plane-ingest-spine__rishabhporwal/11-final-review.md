# Final Review — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 6 — Final Review (Engineering Advisor, Opus) |
| **Verdict** | **PASS** |
| **Recommendation** | **APPROVE** → Stakeholder gate |
| **Residual risk (decision card)** | M1-INTERNAL ONLY: SR-03 (spool holds unvalidated body) + no rate-limit are acceptable *solely* because there is no external ingest traffic (synthetic event only). Both become must-fix the moment the collector accepts external traffic. |
| **Branch** | `feat/data-plane-ingest-spine` (HEAD `ef78505`, 12 commits, +3776/−26 across 44 files) |
| **Reviewed** | 2026-06-16T21:20:00Z |

---

## Recommendation

**APPROVE.** The M1 exit criterion (doc 05 §14: a hello-world event flows collector → Redpanda → Bronze, behind RLS, contracts generated) is delivered and independently re-verified. The spine is real in code, not just asserted in tests. Both gate bounces were genuine defects with test-only fixes and no production regression. No hard-rule deviation, no scope creep, no new ADR/stack/deployable/secret. The D-4 Postgres fallback is the pre-authorised amendment, not a new stack layer.

The only thing the Stakeholder must consciously accept is the **M1-internal-scope assumption** that makes SR-03 and the missing rate-limit shippable (see Residual Risk).

---

## AC → Evidence (the 5 named exit tests, doc 05 §14 / arch §6 Slice 4)

| Acceptance criterion | Evidence | Verdict |
|---|---|---|
| **E2E happy path** — event flows POST → spool → drainer → Redpanda → stream-worker → bronze_events under brain_app | `pipeline-wire.e2e.test.ts` (commit `dcf2d55`): real collector subprocess on random OS port, real TCP POST, real drainer→Redpanda, in-process consumer→bronze; `current_user='brain_app'` asserted. Live 1/1 PASS 38.55s. | MET |
| **Durability (I-ST02)** — ACK survives Redpanda-down; spool holds | `durability.test.ts`: dead broker `localhost:19999` (real TCP refuse, not a mock) → HTTP 200 + row stays `pending`; live broker → drained. 5/5 PASS. | MET |
| **Dedup / replay (I-ST04)** — same event twice → exactly one row | `bronze.e2e.test.ts`: both Redis NX first-line and PK `ON CONFLICT` backstop exercised → 1 row. 4/4 PASS. | MET |
| **Isolation negative control (I-S01)** — cross-brand read = 0 under brain_app; superuser is a false-pass trap | Re-run live by me (below): no-GUC=0, wrong-brand=0, correct-brand=1, superuser=1. brain_app asserted; `current_user != 'brain'` guarded. | MET |
| **Contracts generated** — Avro regen committed with the Zod change (I-E01) | `ingest_at`→`ingested_at` in Zod + `.avsc` + envelope, committed together (`0b1a342`). Contract tests 8/8. | MET |

---

## Spot re-run gates (≥3 required; I ran 5, all replicated)

1. **`pnpm --filter @brain/stream-worker lint` → EXIT 0** — SR-01 (NN-7 raw-Redis-key) closed; replicated independently.
2. **`pnpm --filter @brain/stream-worker typecheck` → EXIT 0**.
3. **Live RLS shape** — `bronze_events` rls=t force=t; policy two-arg `current_setting('app.current_brand_id', true)`; grants INSERT+SELECT only (append-only); `collector_spool` no RLS, SELECT/INSERT/UPDATE. Matches plan §4/§5 exactly.
4. **Live RLS fail-closed under `SET ROLE brain_app`** (the ONE invariant) — seeded a brand_A row, then: no-GUC→0, wrong-brand→0, correct-brand→1, superuser→1. The fail-closed property and the false-pass trap are both proven by me directly, not inherited from the QA artifact.
5. **Canon** — `git diff master..HEAD -- db/iceberg/` empty (Iceberg target untouched); `0015`/`0016` are status `A` (pure additions, no edit to existing migrations).

Every PASS I attempted to replicate, replicated. No un-replicable verification.

---

## The spine is real (code spot-verified, not trusted)

- **Accept-before-validate (D-1):** `collect.route.ts` + `accept-event.usecase.ts` import only `stampEnvelope` + `SpoolRepository` — **zero** kafka/Apicurio/Zod-parse in the HTTP path. The Kafka producer is reachable only from the drainer. ACK = the spool INSERT commit, before HTTP 200. Structural, not test-only.
- **Offset-commit-after-write (D-7):** `CollectorEventConsumer` runs `autoCommit:false` and commits the offset only after `written | dedup_hit | pk_conflict | DLQ-produced`. On write error: no commit, retry; after MAX_RETRY=5 → DLQ → commit. Verified in code.
- **RLS write path (D-8):** `BronzeRepository.write()` does `BEGIN` → `set_config('app.current_brand_id', $1, true)` (txn-scoped) → INSERT `ON CONFLICT (brand_id,event_id) DO NOTHING` → COMMIT, connecting as `brain_app`. Correct.
- **Dedup (D-3/F-5):** Redis `SET NX EX 604800` tenant-prefixed key + PK backstop. Two layers, as bound.

## D-4 amendment — SOUND

Postgres `bronze_events` is the **explicitly pre-authorised D-4 fallback** (CTO review 02 §119: "if the Iceberg REST write path is not functional in TypeScript … the fallback binding is a Postgres `bronze_events` staging table for M1 only"). The spike outcome (no production-grade TS Iceberg writer; Nessie is catalog-only) is correct and grep-verified in the plan. This is an **amendment note on ADR-003**, not a new ADR or stack layer — Postgres is already the PersistenceAdapter. The migration header marks it `DEV/M1 STAGING MIRROR … Phase-3 → Iceberg`. Iceberg target files confirmed untouched. **Not a hard-rule deviation; within the pre-sanctioned envelope. APPROVE.**

---

## Bounce history — both legitimate, test-only fixes, no prod regression

- **Security: FULL BOUNCE → DELTA PASS.** SR-01 (HIGH) was a *real* ESLint NN-7 CI failure (3 raw template-literal Redis keys in `bronze.e2e.test.ts`) — a genuine blocking gate, not a phantom. Fix `3567196` is test-only (4 ins/3 del in one test file). I re-ran lint → 0 errors. `git diff 6fb8768..HEAD -- db/migrations/` empty: RLS/migrations untouched by the bounce. Real fix, no regression.
- **QA: FULL FAIL → DELTA PASS.** F-QA-01 was a *real* gap — components were tested separately but no single test crossed the spool→drainer→Kafka→consumer wire seam (a required Slice-4 AC). Fix `dcf2d55` adds a genuine non-inert full-wire test (real subprocess, real TCP, real Redpanda). Additive; no prod code touched.

Both bounces represent the gates doing their job. Neither fix weakened an isolation/auth/money path.

---

## Negative-control validity — CONFIRMED

The QA verdict carries 5 captured negative controls with commands + outputs (wrong-brand→0, no-GUC→0, superuser-sees-1 proof, correct-brand→1, full-wire wrong-brand→0). `validity_check --require-negative-control` ran EXIT 0 on 3 test files (no BYPASSRLS, no superuser DSN, no tautological asserts). I independently reproduced the fail-closed control live. No bypass-green, no inert probe, no empty negative control on the tenancy path.

---

## Deferred dispositions

| ID | Sev | Disposition | Justification |
|---|---|---|---|
| **SR-02** | MEDIUM | ship-as-techdebt (M2) | Null-GUC test case passes via wrong-brand≠right-brand (session-scoped GUC pool reuse), not via null→fail-closed. **The production fail-closed property itself is sound — I re-proved it live (no-GUC under brain_app → 0 rows).** This is a *test-precision* gap, not a security regression. Fix: txn-scoped `set_config(...,true)` + BEGIN/COMMIT or fresh connection per call. |
| **SR-03** | MEDIUM | ship-as-techdebt — **M1-internal caveat** | `collector_spool.raw_body` stores unvalidated caller body (PII-capable) by design (D-1 accept-before-validate). Acceptable **only** because M1 is internal/synthetic with no external traffic and the Zod contract enforces hashed identifiers for compliant callers. **Must-fix before external exposure:** spool housekeeping TTL + API-gateway/write-key auth in front of the collector. |
| **SR-04** | LOW | ship-as-techdebt — **M1-internal caveat** | `fastify-rate-limit` configured but unwired. Acceptable for M1 internal; an unbounded spool write target is a DoS vector once externally exposed — wire before external traffic. |
| **F-QA-04** | LOW | ship-as-techdebt (M2) | vitest `TimeoutNegativeWarning` — cosmetic; tests pass. |
| **F-QA-05** | LOW | ship-as-techdebt — **M1-internal caveat** | Duplicate of SR-04 (rate-limit). Same M1-internal scoping. |

---

## The M1-internal-scope caveat (Stakeholder must consciously accept)

SR-03 (spool holds unvalidated body) and SR-04/F-QA-05 (no rate-limit) are shippable **only under the assumption that this collector receives no external ingest traffic in M1** — it processes synthetic/internal events behind the platform boundary. If that assumption changes (a real connector or public pixel endpoint points at `/collect`), these become **release blockers**, not tech-debt. The Stakeholder is the right authority to confirm the M1-internal boundary holds at deploy time.

---

## Canon / over-engineering / hard-rule

- **Cost paradigm:** deterministic-only, 0 model spend — correct; a model call here would be an anti-pattern. PASS.
- **Over-engineering:** none. Scope is thin (one synthetic event); spool→drain split is the minimum-correct complexity for the durability invariant; the only simplification (M1 Zod-local validate vs Apicurio consume-validate) is sanctioned (02 §133). No files/deps/abstractions beyond plan. No WHAT-comments. PASS.
- **Single-Primitive:** one spool, one dedup mechanism, one Bronze table, `brand_id` tenant key at every layer. PASS.
- **Hard-rule deviation check:** no dependency violation, no Single-Primitive violation, no compliance gap, no un-sanctioned paradigm escalation, no un-codified gate-skip. **None — auto-approve permitted.**
- **Canon:** no new ADR/STACK.md/docs touched; only the 2 existing deployables modified; no hardcoded secrets in diff; migrations additive (I-E02); Iceberg target untouched. PASS.

---

## Decision

**PASS → Stakeholder gate.** Recommend **APPROVE** the deploy, conditioned on the Stakeholder confirming the M1-internal-traffic boundary (the only thing gating SR-03/rate-limit acceptability).

### Mechanical commit / merge (explicit paths, no `git add -A`)

The work is already committed across slices on `feat/data-plane-ingest-spine` (12 commits, HEAD `ef78505`). No staging needed — the Stakeholder merges the branch:

```
git checkout master
git merge --no-ff feat/data-plane-ingest-spine \
  -m "feat(data-plane): ingest spine collector→Redpanda→Bronze behind RLS [M1]"
```

(All product-code paths are already tracked in the 12 slice commits; product files: `apps/collector/src/**`, `apps/stream-worker/src/**`, `db/migrations/0015_collector_spool.sql`, `db/migrations/0016_bronze_events.sql`, `packages/contracts/**`, `packages/events/src/index.ts`. No `git add -A`.)
