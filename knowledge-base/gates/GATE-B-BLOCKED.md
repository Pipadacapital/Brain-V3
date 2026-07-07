<!-- SPEC: 0.2 / B.5 / 1.9 -->
# GATE-B — **BLOCKED**

**Date:** 2026-07-07 · **Branch:** `feat/commerce-os-program` · **Verifier:** WB-GATE (Wave B acceptance)
**Golden brands:** `a0a0a0a0-0001-4000-8000-000000000a01`, `b0b0b0b0-0002-4000-8000-000000000b02`,
`c0c0c0c0-0003-4000-8000-000000000c03`. Live local stack (Trino :8090, PG :5432, Kafka :9092, Redis, MinIO,
iceberg-rest — all healthy).

---

## Exact §0.2 failure

Per **§0.2 criterion 1** ("A gate is passed only when: 1. All acceptance criteria in the wave's Acceptance
Criteria section pass with evidence written to `GATE-<wave>.md`"), GATE-B **cannot pass**:

> **B.5.4 (acceptance criterion 4) has no implementation in the working tree.** Its entire deliverable — the
> flag-gated switch of the attribution job's touchpoint input from `silver_touchpoint` to the Journey-domain
> output (`journey_events` current view), in BOTH attribution drivers, plus the golden parity proof — is
> absent. It therefore cannot be executed, and no evidence can be produced. Because a named acceptance
> criterion is not merely failing but **unbuilt**, the gate is blocked, not deferred.

Contributing shortfalls (each independently blocks its criterion): **B.5.1** cannot be evidenced because the
`journey_version_log` table has never been materialized live and the `journey.engine` flag has never been
enabled for the golden brands; **B.5.2 / B.5.3 / B.5.5** have their code + unit/contract tests green but were
never executed end-to-end on the golden dataset with the engine ON, because that ON-run was gated behind the
same unbuilt/unactivated pieces.

Per the WB-GATE protocol ("If ANY criterion fails → write `GATE-B-BLOCKED.md` with the exact §0.2 failure and
STOP"), verification halted here.

---

## What IS built and verified (so the remaining work is scoped, not re-discovered)

| Item | State | Evidence |
|---|---|---|
| **B.1 canonical journey generation** | BUILT, live schema present | `db/iceberg/spark/gold/gold_journey_events.py` — flag-gated identity-input switch (AMD-13 R1), `matched_via`/`identity_basis` additive columns, derived journey version (AMD-11 R1). Live `iceberg.brain_gold.journey_events` = **26 cols incl. `matched_via array(varchar)` + `identity_basis varchar`** (additive ALTER applied); **56,854 rows**, all 3 golden brands present (a0a0=21,542 · b0b0=14,294 · c0c0=11,762). `identity_basis='deterministic'` on 100% of rows (§1.4). `matched_via` populated on 198 rows (flag-OFF derived-from-`silver_identity_map` path). Unit test `b1_canonical_journey_test.py` (12 passed). |
| **B.2 re-version consumer + version log** | BUILT (code), NOT materialized live | `gold_journey_events_reversion.py` writes `journey_version_log {brand_id, brain_id, from_version, to_version, cause, at}` (LOG_PK `(brand_id, brain_id, to_version)`); merge/unmerge causes; `_journey_version_log_pure.py` (+twin `apps/stream-worker/src/domain/journey/JourneyReversionDirty.ts`). Kafka consumer `JourneyReversionDirtyConsumer` + `ops.journey_reversion_pending` (migration `0125`). Tests: `journey-reversion-dirty.B2.unit.test.ts` **17/17**, `_journey_version_log_pure_test.py` **4/4**. **BUT** `SHOW TABLES FROM iceberg.brain_gold LIKE 'journey%'` returns **only `journey_events`** — `journey_version_log` is absent (the version-log write is fail-closed on `journey.engine`, which is OFF for every golden brand). |
| **B.3 journey APIs** | BUILT (code + contract), NOT run live | `journey-api.routes.ts` (`/v1/customers/:brainId/journey` + `X-Journey-Version`, `/v1/journeys/trace`, `/v1/journeys/compare`), query handlers `get-customer-journey.ts`/`get-journey-trace.ts`/`get-journey-compare.ts`, ServingCache 'journey' tier (AMD-14 R1, AMD-18). Serving view `iceberg.brain_serving.mv_journey_events_current` present. Tests: `journey-api.v1.B3.contract.test.ts` + `journey-api.B3.routes.test.ts` + metric-engine `journey-identity-evidence.B3` / `journey-touchpoint-cache.B3` — **all green** (contracts 16/16, metric-engine 16/16). No live p95 latency capture. |
| **B.4 replay & explainability** | BUILT (code + contract), NOT run live | `get-journey-replay.ts` + `computeJourneyEventsAsOf`/`resolveIdentityAsOf` (AMD-10 R1 reconstruction from retained version history, NOT Iceberg time-travel), wired at `analytics-journey.routes.ts` `?as_of=` (flag-gated, `Cache-Control: no-store`, `replayed:true`). Tests: `journey-replay.B4.test.ts` **7/7**, `journey-replay.B4.contract.test.ts` **9/9**. No live as_of execution on golden. |
| **B.5.4 attribution-consumes-journey seam** | **ABSENT** | `db/iceberg/spark/gold/gold_attribution_credit.py:120` reads `silver_touchpoint` directly; `apps/core/src/modules/attribution/internal/reconcile-attribution.ts:169` reads `brain_serving.mv_silver_touchpoint` directly. **Neither driver has any `journey_events` read path, any `journey.engine`/attribution flag, or any parity test** (`grep -rn journey_events` over both files = 0 non-comment hits; no `B5*.parity.test.ts` exists). This matches the delta-plan verdict for B.5.4: **MISSING**. |

---

## Per-criterion verdict (B.5.1 – B.5.5)

| # | Criterion | Verdict | Why |
|---|---|---|---|
| **B.5.1** | multi_device customer → ONE canonical journey across devices post-merge, version bump logged in `journey_version_log` | **FAIL (not demonstrable)** | `journey_version_log` does not exist live; `journey.engine` OFF for all golden brands (`redis KEYS '*journey.engine*'` = ∅ — only `stitch.v2` / `identity.shared_device_guard` are set). The version-bump write is fail-closed OFF. A merge → N+1 re-version with a logged bump has never run on golden. |
| **B.5.2** | 5-touch golden order via `/journeys/trace` returns exactly those 5 in order with correct `matched_via` | **UNVERIFIED** | Route + query + contract test exist and pass, but were never executed against a live 5-touch golden order (blocked behind the ON-run that B.5.1/B.5.4 gate). |
| **B.5.3** | pre-identification `as_of` replay returns the shorter anonymous-era journey | **UNVERIFIED** | Replay path + unit/contract tests green; no live golden `as_of` execution. |
| **B.5.4** | attribution consuming Journey output (flagged) == legacy path on golden, identity held constant; then document Stitch-v2-on delta | **FAIL (unbuilt)** | The flagged read-path switch does not exist in either attribution driver; no parity harness; no evidence possible. **Primary blocker.** |
| **B.5.5** | latency budgets + flags-OFF byte-identical golden regression for journey tables | **UNVERIFIED / at-risk** | No live p95 capture on journey APIs. Flags-OFF byte-identical is additionally at risk: the golden snapshot baseline was churned during GATE-A blocker remediation (`GATE-A.md` A.5.8 = DEFERRED) and `journey_events` currently also holds 2 non-golden brands (`e3aac77b…`, `9b88fa45…`, 9,256 rows) — a clean re-seed is required before a byte-identical compare is meaningful. The two new columns are additive/nullable and absent from the pre-wave baseline (invariant-8 argument is sound in principle), but unproven here. |

---

## §1.9 invariant checklist (as far as verifiable at BLOCKED state)

| # | Invariant | Result | Evidence |
|---|---|---|---|
| 1 | No new datastore/framework | **PASS** | Wave B adds only Iceberg Gold tables + Kafka consumer + BFF routes on existing engines. |
| 2 | New monetary columns = integer minor + currency | **PASS** | `journey_events.revenue_minor bigint` + sibling `currency_code`; no float/decimal money. |
| 3 | New subject-linked tables in shred manifest | **FAIL** | `journey_version_log` is subject-linked (`brain_id`) but is **not** registered in `knowledge-base/privacy/shred-manifest.md` (manifest covers the Wave-A stitch tables only). Must be added before the gate. |
| 4 | No unhashed PII in new topics/logs/tables | **PASS (design)** | `journey_version_log` / reversion-pending carry only `brand_id`+`brain_id`+versions+cause; AMD-08 lane keyed `brand_id+identifier_hash`. No live topic PII sample taken (deferred with the ON-run). |
| 5 | Zero probabilistic rows in attribution/revenue | **PASS** | `identity_basis='deterministic'` on 100% of `journey_events`; canonical ledger is deterministic-only. (The B.5.4 seam that would carry this into attribution is unbuilt, so no regression is possible either.) |
| 6 | All new tables/keys carry `brand_id`; isolation test | **PASS (structural)** | `journey_events` PK `(brand_id, touchpoint_id, data_version)`, `journey_version_log` PK `(brand_id, brain_id, to_version)`, routes take tenant from auth session never query param (B.3 routes). No live cross-tenant isolation test run. |
| 7 | New topics schema-registered, BACKWARD compatible | **UNVERIFIED** | AMD-08 reuses the live `{env}.identity.*.v1` lane; no new-topic registration diff captured in this pass. |
| 8 | Flags OFF reproduce pre-wave behavior byte-for-byte on golden | **UNVERIFIED (at-risk)** | See B.5.5 — golden baseline churned (GATE-A A.5.8 DEFERRED) + non-golden brands present; needs clean re-seed. |
| 9 | ESLint hexagonal boundary rule | **NOT RUN** | Gate halted before AMD-22 command; boundary lint not executed this pass. |
| 10 | Bi-temporal access only via sanctioned views | **PASS** | B.1/B.4 read the map exclusively via `_identity_views.identity_current` / `identity_asof` (A.2.2 allowlist); replay uses modeled version history, not `FOR TIMESTAMP AS OF` (AMD-10 R1). |

**Invariant summary: 5 PASS, 1 FAIL (inv-3 shred manifest), 3 UNVERIFIED, 1 NOT RUN.**

---

## AMD-22 gate command

`pnpm turbo build lint test:unit test:contract` (+ the B-named spec tests) — **not run to completion this
pass** (gate halted at the first failing acceptance criterion, B.5.4, per protocol). The B-named spec tests
that WERE executed are green: metric-engine `journey-replay.B4` / `journey-identity-evidence.B3` /
`journey-touchpoint-cache.B3` (**16/16**), contracts `journey-api.v1.B3` / `journey-replay.B4` (**16/16**),
stream-worker `journey-reversion-dirty.B2` (**17/17**), Python `_journey_version_log_pure_test` + `b1_canonical_journey_test` (**16/16**). The full monorepo command remains for the unblock pass.

---

## Rollback (flags OFF) — the current state IS the rolled-back state

Per PART-9 the Wave-B disable is `flag: journey.engine` (versions retained, append-only). Today that flag is
OFF for every brand, so the live system is already in the rolled-back posture: `journey_events` was built on
the legacy `silver_touchpoint` identity input, no `journey_version_log` exists, and attribution is untouched.
This is consistent with a clean rollback but is *also* why none of B.5.1–B.5.5 can be evidenced — the ON-path
has never been exercised on golden.

---

## To unblock GATE-B (ordered)

1. **Build B.5.4 (critical path):** add the flag-gated read-path switch `silver_touchpoint → journey_events`
   current view in BOTH attribution drivers (`gold_attribution_credit.py` + `reconcile-attribution.ts`),
   default OFF; write a `B5.4.parity.test.ts` (+ Spark parity oracle) proving IDENTICAL credit on golden with
   identity held constant (flag OFF path == flag ON path when the journey input is the same identity
   resolution); then document the improved delta with `stitch.v2` ON.
2. **Register `journey_version_log` in `knowledge-base/privacy/shred-manifest.md`** (invariant 3 FAIL).
3. **Enable `journey.engine` ON for the 3 golden brands** (Redis per-brand flags) and run the journey
   construction + reversion jobs `FULL_REFRESH=1` via `tools/dev/v4-refresh-loop.sh ONESHOT=1` so
   `journey_version_log` materializes and a golden multi_device merge produces a logged N→N+1 bump (B.5.1).
4. **Execute B.5.2 / B.5.3 live** against a chosen 5-touch golden order and a pre-identification `as_of`.
5. **Clean golden re-seed** + capture the journey-table baseline, then run the flags-OFF byte-identical
   compare (B.5.5 / invariant 8; shared with the deferred GATE-A A.5.8) and the journey-API p95 latency smoke.
6. Run the AMD-22 command (`build lint test:unit test:contract`) to completion + ESLint boundary (inv-9).
7. Replace this file with `GATE-B.md` once all of B.5.1–B.5.5 pass with evidence.

---

**Verdict:** **BLOCKED.** Wave B's supporting machinery (B.1 schema live; B.2/B.3/B.4 code + 65 green
unit/contract/pure tests) is substantially built, but **acceptance criterion B.5.4 is entirely unimplemented**
in both attribution drivers, and **B.5.1 cannot be evidenced** (`journey_version_log` not materialized,
`journey.engine` never enabled on golden). Per §0.2 criterion 1, the gate does not pass.
