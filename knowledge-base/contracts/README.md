<!-- SPEC: E-I -->
# Waves E–I — Contract Index (SCAFFOLD ONLY)

Binding spec: `knowledge-base/PLAN-OF-RECORD.md §PART 6`. Baselines + amendments:
`knowledge-base/01-delta-plan.md` (## Waves E–I scaffold baselines) and `knowledge-base/amendments/AMD-*`.

Every artifact below is **inert-by-construction**: interfaces, DDL, Apicurio JSON-Schema, package
skeletons, feature flags (DEFAULT OFF), and fail-closed `NotImplemented` adapters. **NO** business logic,
model training, agent loops, scoring, or external write executors ship in these waves. Each wave's full
scaffolded-vs-deferred record is in `CONTRACT-{E,F,G,H,I}.md`. When a wave's logic is built, these are the
exact seams to build against.

## Seam map (contract → DDL/schema · port/interface · flag · endpoint)

| Wave | Contract | DDL / Schema (schema-of-record) | Port / interface (build here) | Flag(s) — DEFAULT OFF | Endpoint / registration |
|---|---|---|---|---|---|
| **E** AI Feature Layer | `CONTRACT-E.md` | `gold_ai_features` **logical PIT EAV** (CONTRACT-E §2 — documented, NOT materialized per AMD-19 R2); TS row types `packages/ai-features/src/schema.ts`; Redis online hash `{brand_id}:feat:{entity_type}:{entity_id}` | `packages/ai-features/src/loader.ts` (`YamlParsePort`, `FeatureSourcePort`); deferred stubs `resolveAsOfFeatures` / `materializeOnline` / `materializeOffline` (throw); registry `registry.ts::FeatureDefinition` + `features/*.yaml` | `features.online_serving` (E) | `GET /api/v1/features/:entity_type/:entity_id` → **501** (`apps/core/.../routes/features.routes.ts`) |
| **F** AI Platform Infra | `CONTRACT-F.md` | `db/iceberg/ops_llm_calls.sql` (append-only ledger, inert); LiteLLM routing `infra/litellm.config.yaml` (`task_class_routing` + per-brand budget/rate-limit key) | `packages/ai-platform/src/{pii-masking,ops-llm-call-log,execution-mode}.ts` (`PiiMaskingHook`, `OpsLlmCallLogPort` — both `NotImplemented`; `ExecutionMode` enum, `auto` throws); `packages/prompt-loader` (`PromptLoaderPort`, `NotImplemented`); MCP registry `packages/ai-gateway-client` (read-only, `writeToolCount===0`) | `ai.gateway.call_logging` (F), `ai.copilot.tools` (F) | Apicurio: N/A (F adds no topic); MCP no-Trino-dep contract test `packages/ai-gateway-client/src/mcp-no-trino-dep.contract.test.ts` (AMD-20) |
| **G** Recommendation Engine | `CONTRACT-G.md` | `db/iceberg/gold_recommendations.sql` (explainability schema-ENFORCED: `evidence`/`model_version`/`business_rules_applied`/`score`/`confidence` NOT NULL; inert, no writer) | none yet (writer + reader DEFERRED) | `recommendations.api` (G) | `GET /api/v1/recommendations/generated` → 404 (flag OFF) / **501** (flag ON); AMD-21: shipped `GET /api/v1/recommendations` untouched (`apps/core/.../routes/recommendations-generated.routes.ts`) |
| **H** Decision Engine | `CONTRACT-H.md` | `db/iceberg/gold_decisions_table.sql` (candidates + per-candidate `expected_value_minor`+`currency_code` + `constraint_evaluations`; road-not-taken persisted; inert, no Spark builder) | `packages/decision-policies/src/domain/{policy-types,evaluator-port,certified-metrics}.ts`; compiler `src/compiler/{validate,compile}.ts` (shape-only); `NotImplementedPolicyEvaluator` (throws); `io/load.ts` YAML seam (throws); `policies/*.yaml` | `decision.engine` (H) | none (no endpoint in scaffold) |
| **I** Action Platform | `CONTRACT-I.md` | 5 Apicurio JSON-Schema envelopes `packages/contracts/generated/json-schema/brain.action.{requested,approved,executed,failed,rolled_back}.v1.json` (`holdout_group` from day one; `brand_id` first+required; `execution_mode` enum) — **FULL_TRANSITIVE** | `packages/action-core/src/domain/ExecutorPort.ts` + 4 adapters `src/adapters/{ShopifyDiscount,MetaAudience,Messaging,Webhook}Executor.ts` (all `NotImplemented`, `supportsRollback=false`); `src/domain/governance.ts::evaluateAutoGate` (fail-closed) | `actions.executor.{shopify_discount,meta_audience,messaging,webhook}` (I) | Apicurio registration in `apps/collector/src/main.ts` (idempotent boot step, `registerSchema(..,'JSON')` + `ensureCompatibilityRule('FULL_TRANSITIVE')`) |

All flags are registered in `packages/platform-flags/src/registry.ts` (single source of truth; unknown/absent flag ⇒ fail-closed OFF).

## Cross-wave linkage
- **D → E/H:** feature `source:` refs and policy constraints reference **certified metric names only** (Wave D
  `packages/semantic-metrics`); until D ships, `decision-policies/src/domain/certified-metrics.ts` holds the launch-set names.
- **H → I:** `gold_decisions.decision_id` is the `decision_id?` in every `action.*.v1` envelope; each candidate's
  `action_type` maps to a Wave I executor family; `policy_version` (approved) is the Wave-I `auto` gate precondition.
- **F → G/H/I:** `execution_mode` enum (`suggest|approve|auto`, default `suggest`; `auto` structurally unreachable
  until the Wave-I governance gate) is shared across every agent-action schema.

## Governance / invariant posture (applies to all E–I scaffolds)
- Additive only; `brand_id` FIRST on every DDL column set, partition key, envelope, and Redis key.
- Money = bigint minor units + a sibling `currency`/`currency_code`, never blended, never a float
  (`ops_llm_calls.cost_minor`, `gold_decisions` per-candidate `expected_value_minor`).
- Hexagonal: ports live in domain packages; no Kafka/Iceberg/Trino/Redis/pg infra imports in domain source.
- New program topics = Apicurio JSON-Schema, FULL_TRANSITIVE (AMD-03, ≥ the spec's BACKWARD).
- v4-naming-guard (AMD-19): no feature-precompute table introduced — `gold_ai_features` PIT is a *logical*
  contract, never materialized by the refresh loop.
