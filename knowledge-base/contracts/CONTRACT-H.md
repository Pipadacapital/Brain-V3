# CONTRACT-H — Decision Engine (SPEC:H)

**Status:** SCAFFOLD ONLY. Binding spec: `knowledge-base/PLAN-OF-RECORD.md §PART 6.H`. Baseline:
`knowledge-base/01-delta-plan.md` ("Waves E–I scaffold baselines", H row). All artifacts are
additive and **inert** — nothing computes a decision until Wave H logic ships behind the DEFAULT-OFF
per-brand flag `decision.engine`.

## Spec (verbatim, §PART 6.H)
- `gold_decisions {brand_id, decision_id, subject, candidates (with per-candidate
  expected_value_minor + constraint evaluations), selected, policy_version, rationale, decided_at}` —
  the road not taken persisted.
- Policies = versioned YAML (`packages/decision-policies`, compiler pattern); constraints reference
  certified metrics ONLY.
- **Deferred:** evaluation engine, EV models, arbitration.

## What was scaffolded

### 1. Decision-record DDL — `db/iceberg/gold_decisions_table.sql`
Iceberg Gold table `brain_gold.gold_decisions`, **NOT** wired into `tools/dev/v4-refresh-loop.sh` and
with **no** Spark builder (`db/iceberg/spark/gold/gold_decisions.py` deliberately absent) — inert.
- `brand_id` is the **first** column and the partition-bucket anchor (`bucket(16, brand_id)`), plus
  `days(decided_at)` (§1 tenant isolation; §I-E02 partition spec fixed at creation).
- **Candidates WITH scores persisted** (the road not taken): `candidates` is a JSON array; each
  element carries `candidate_id, action_type, expected_value_minor (bigint minor units),
  currency_code, constraint_evaluations[] (certified metric name + op + threshold + observed +
  passed), eligible, rank`. Losers are retained, not just the winner.
- **Money = bigint minor + sibling currency** (§1.4/I-S07): `expected_value_minor` + `currency_code`
  live **inside each candidate** — per-candidate, never blended, never a float.
- `policy_version` = `<name>@<version>` from the certified YAML policy that arbitrated.
- `selected` is nullable — a null decision (no eligible candidate) is itself an audited outcome.
- Append-only / additive-optional evolution (`brain.immutable=true`, `brain.wave=H`,
  `brain.scaffold=true`).

### 2. `packages/decision-policies` — versioned YAML + compiler skeleton
Same compiler **pattern** as Wave D, **skeleton only** (no evaluation engine).
- `policies/reactivation-nudge.v1.yaml` — sample versioned policy (customer subject; whatsapp /
  discount / no-action candidates; `cm2_pct >= 0.20` + `rto_rate <= 0.15` guardrails;
  `max_expected_value` arbitration declaration).
- `src/domain/policy-types.ts` — the policy AST (pure domain types, no infra imports — hexagonal §1).
- `src/domain/certified-metrics.ts` — `CERTIFIED_METRICS` = Wave D launch-set metric **names**;
  `isCertifiedMetric`. Constraints + EV yardsticks reference certified metrics **only by name** →
  why Wave D precedes Wave H runtime.
- `src/compiler/validate.ts` — pure structural validator (`unknown` → all shape + certified-metric
  errors at once). No evaluation, no I/O.
- `src/compiler/compile.ts` — `compilePolicy` (validate + emit `policy_version`); `PolicyValidationError`.
- `src/domain/evaluator-port.ts` — `PolicyEvaluatorPort` + `DecisionRecord` / `CandidateEvaluation`
  (mirrors the DDL; the DEFERRED evaluation seam, typed).
- `src/adapters/not-implemented-evaluator.ts` — `NotImplementedPolicyEvaluator` (throws;
  fail-closed; only ever replaced behind the `decision.engine` flag).
- `src/io/load.ts` — `loadPolicyDocument` YAML file→object parse seam (throws; DEFERRED — keeps the
  scaffold free of an unpinned YAML runtime dep; compiler validates already-parsed docs).
- `src/compiler/compile.test.ts` — compiles the sample; rejects a non-certified metric ref, a
  non-monotonic version, and a bad op.

### 3. Feature flag — `packages/platform-flags`
`decision.engine` (wave H, DEFAULT OFF, fail-closed). Registered in `src/registry.ts`.

## What was DELIBERATELY deferred
- **Evaluation engine** — no code resolves certified metric VALUES or evaluates a constraint
  comparison. `PolicyEvaluatorPort` implementation throws.
- **EV models** — no code predicts `expected_value_minor`. The YAML only names the certified metric
  the EV is expressed in.
- **Arbitration** — `arbitration.strategy` / `tie_breaker` are enums a future engine reads; no
  strategy runs.
- **No `gold_decisions` writer** — no Spark job, not in the refresh loop; the DDL is inert.
- **YAML text parse** — deferred seam (`loadPolicyDocument` throws) so no runtime YAML dependency is
  introduced now.

## Invariant compliance
- Additive only; no reader repointed; no existing surface regressed.
- `brand_id` first on the table + partition anchor; money = bigint minor + sibling currency per
  candidate.
- Hexagonal: ports live in `src/domain`, no infra imports.
- v4-naming-guard: no retired-DB refs, no dbt, no feature-precompute table introduced.
- `// SPEC: H` headers on every new source/DDL/YAML file.

## Cross-wave linkage
- **Wave D → H:** certified metric names are the ONLY vocabulary policy constraints may use; when
  `packages/semantic-metrics` (Wave D) ships, its compiled catalog becomes the source of truth and
  `certified-metrics.ts` is replaced by an import from it.
- **Wave H → I:** each candidate's `action_type` maps to a Wave I executor family
  (messaging / shopify-discount / meta-audience / webhook); `gold_decisions.decision_id` is the
  `decision_id?` referenced by the Wave I `action.*` envelopes.
