<!-- SPEC: I -->
# CONTRACT-I — Action Platform (Wave I, SCAFFOLD ONLY)

**Status:** SCAFFOLD FILED · flags default OFF · adapters fail-closed (NotImplemented)
**Binding sources:** PLAN-OF-RECORD.md §PART 6 → I; 01-delta-plan.md "Waves E–I scaffold baselines" (row I) + AMD-03.
**Scope rule (§PART 6):** interfaces, schemas, package skeletons, flags OFF, governance record ONLY. NO business logic, NO agent loops, NO scoring, NO external write executors.

---

## What was scaffolded

### 1. Action envelope schemas (Apicurio-registered, FULL_TRANSITIVE)
Five envelopes, one per lifecycle transition, under `packages/contracts/generated/json-schema/`:

| Artifact id (Apicurio, group `brain`) | File |
|---|---|
| `action.requested.v1`   | `brain.action.requested.v1.json` |
| `action.approved.v1`    | `brain.action.approved.v1.json` |
| `action.executed.v1`    | `brain.action.executed.v1.json` |
| `action.failed.v1`      | `brain.action.failed.v1.json` |
| `action.rolled_back.v1` | `brain.action.rolled_back.v1.json` |

Common envelope (per §PART 6.I): `{brand_id, action_id, decision_id?, executor, payload, execution_mode, approved_by?, holdout_group?}` — **`holdout_group` is in the envelope from day one** so incrementality/lift is measurable the moment execution goes live. Per-transition additive fields: `approved.policy_version` (required), `executed.execution_ref`, `failed.error_code`, `rolled_back.rollback_ref`.

Invariants honored: **`brand_id` is the FIRST property and first `required` on every schema** (tenant-first, I-S01) and is the Kafka partition key for the lane; **money in `payload` = bigint minor units + a sibling `currency_code`** (documented, never a float/blended); **no raw PII** (I-S02 — `approved_by`/`rolled_back_by` are auth-principal ids, `reason`/`error_message` are PII-free text); `execution_mode` enum `suggest|approve|auto` default `suggest`.

**Format decision (Avro vs JSON Schema — reconciled):** the task brief said "Avro schemas", but **AMD-03 R1 (BINDING, 2026-07-06) explicitly enumerates `action.*.v1`** among the NEW program topics that get **registry-registered JSON Schema artifacts under the FULL_TRANSITIVE rule** — not Avro. The shipped `registerSchema(config, json, 'JSON')` path (packages/events) and the already-registered `identity.unmerged.v1` / `pixel.identify.v1` JSON-Schema siblings are the live precedent. We therefore registered these as **JSON Schema, FULL_TRANSITIVE** (stronger than the spec's BACKWARD, so §1.7 intent is preserved and exceeded). Naming follows the discovered convention `brain.<domain>.<name>.v{N}` (group `brain`, artifactId `action.<name>.v1`).

**Registration (same way existing artifacts are):** wired into the collector's proven idempotent Apicurio boot step (`apps/collector/src/main.ts`) alongside `pixel.identify.v1` / `identity.unmerged.v1` — each `registerSchema(..,'JSON')` + `ensureCompatibilityRule(..,'FULL_TRANSITIVE')`, missing-file → log+skip, never blocks boot. Registration is unconditional (schema governance ≠ execution); execution is what the flags gate.

### 2. Executor port + four fail-closed adapters
New hexagonal domain package **`@brain/action-core`** (`packages/action-core/`, zero infra deps — mirrors `connector-core`/`identity-core`):
- `src/domain/ExecutorPort.ts` — `ExecutorPort` interface (`execute`, `rollback`, `name`, `flag`, `supportsRollback`) + `ActionEnvelope` / `ExecutionResult` / `RollbackResult` / `ExecutionMode` / `ExecutorName` types + `NotImplementedError` (code `NOT_IMPLEMENTED`).
- `src/adapters/{ShopifyDiscountExecutor, MetaAudienceExecutor, MessagingExecutor, WebhookExecutor}.ts` — the four named adapters. `execute()` and `rollback()` **throw `NotImplementedError`**; `supportsRollback = false` on every one.
- `src/domain/governance.ts` — `evaluateAutoGate()` pure fail-closed predicate (below).
- `src/index.ts` — `EXECUTOR_REGISTRY` (name→adapter) + `EXECUTOR_NAMES`.
- `src/action-core.test.ts` — contract tests: every adapter throws NotImplemented, the gate refuses `auto`, schema `brand_id`-first + `holdout_group` present + `executor` enum matches the four adapters.

Each adapter carries its own platform flag string (`actions.executor.*`); the domain package never imports the flags client — flag resolution happens at the (future) wiring layer.

### 3. Governance invariant (Wave-I gate precondition)
Recorded here AND encoded as the pure predicate `evaluateAutoGate(action, executor)`:

> **No `auto` execution of an executor without ALL of:**
> (a) a **human-approved policy version** — `action.approved.v1.policy_version` + `approved_by`;
> (b) **holdout support** — `holdout_group` present (carried in every envelope from day one);
> (c) a **working rollback for that executor** — `ExecutorPort.supportsRollback === true`.

Because every scaffold adapter has `supportsRollback = false`, the gate can NEVER return `allowed:true` for `auto` today — autonomous execution is **structurally unreachable**, the intended fail-closed posture. Non-`auto` modes bypass the gate (they do not execute in scaffold).

### 4. Feature flags (packages/platform-flags, default OFF)
`actions.executor.shopify_discount`, `actions.executor.meta_audience`, `actions.executor.messaging`, `actions.executor.webhook` — wave `I`, one per executor (governance is per-executor: rollback per executor). Unset ⇒ reads disabled (fail-closed).

---

## Deliberately DEFERRED (NOT in this scaffold)
- Any real executor implementation (Shopify price-rule/discount calls, Meta Custom Audience push, message send, webhook POST) and their rollbacks.
- The action-platform runtime: envelope producer/consumer, approval workflow, dispatch loop, retry/idempotency executor, DLQ.
- `execution_mode: auto` code path (gated unreachable by governance).
- Persisted action ledger / Gold action tables, holdout assignment logic, incrementality/lift computation.
- Wiring `@brain/action-core` into any app (BFF/stream-worker), flag→registry dispatch, and per-brand policy binding (Wave H `gold_decisions` / `packages/decision-policies` linkage via `decision_id`).
- `PushNotification`/attribution passback and platform-verified impressions (PLAN-OF-RECORD §PART 7 DEFERRED — Wave I / partnerships).

## Cross-wave dependencies
- `decision_id` back-references Wave H `gold_decisions`; `policy_version` references Wave H `packages/decision-policies`. Both optional at scaffold time.
- Schema governance rides the AMD-03 FULL_TRANSITIVE boot step (WA-05) — the same infrastructure `pixel.identify.v1` / `identity.unmerged.v1` use.
