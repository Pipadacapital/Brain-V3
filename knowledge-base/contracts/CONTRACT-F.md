<!-- SPEC: F -->
# CONTRACT-F — AI Platform Infrastructure (Wave F, SCAFFOLD-ONLY)

**Status:** SCAFFOLDED · flags default OFF · no business logic
**Binding spec:** PLAN-OF-RECORD.md §PART 6 (F) · delta-plan §"Waves E–I scaffold baselines" (row F) · **AMD-20** (MCP no-Trino contract, R1 adopted)
**Scope rule (§PART 6 / §0.1):** interfaces, Iceberg DDL, config scaffolds, package skeletons, flags OFF, failing-by-design `NotImplemented` adapters. **NO** agent runtime, model training, agent loops, scoring, or external executors.

---

## What was scaffolded

### F.1 — LiteLLM gateway config (routing table + per-brand budget/rate-limit key shape)
LiteLLM is the gateway (NOT a custom gateway — per stack lock §1.1). Config pre-existed and was **additively** extended:
- **`infra/litellm.config.yaml`**
  - NEW `task_class_routing:` block — model aliases **per task class** (`nlq_resolve|classify|summarize → small_model`; `conversational|synthesis → large_model`). Callsites request a task class; a tier swap is one edit. **Config/stub only — no router runs against it** (litellm compose service stays commented out until Wave F; `ai.gateway.call_logging` flag OFF).
  - NEW per-brand **budget + rate-limit key shape** on the prod virtual-key template: `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `metadata.brand_id` (tenant key first-class on the gateway key too, I-S01).
  - Existing model tiers, fallback chains, virtual keys, OTEL callbacks — untouched.

### F.2 — `ops_llm_calls` Iceberg table DDL + prompt-hash/redacted-store + masking hook stub
- **`db/iceberg/ops_llm_calls.sql`** — append-only Iceberg LEDGER `brain_ops.ops_llm_calls`:
  `{brand_id (FIRST), request_id, ts, model, task_class?, prompt_hash, redacted_prompt_ref?, tokens_in, tokens_out, cost_minor, currency, latency_ms, outcome?, trace_id?, subject_key_id?}`.
  - `brand_id` first + `bucket(16, brand_id)` + `days(ts)` partitioning (I-S01). 24-month retention, format-v2, zstd — Bronze-parity.
  - Money = **bigint `cost_minor` + sibling `currency`** (§1.2), never float.
  - Privacy (§1.3/§F): **only `prompt_hash` (SHA-256) inline**; the human-readable prompt lives in a SEPARATE redacted store, referenced by `redacted_prompt_ref`, and only exists **after** the masking hook. `subject_key_id` is the crypto-shred envelope anchor when subject-linked.
  - **Inert:** not in the refresh loop; no writer wired.
- **`packages/ai-platform/src/pii-masking.ts`** — `PiiMaskingHook` port + `MaskedPrompt` shape + **`NotImplementedPiiMaskingHook`** (fails CLOSED — a raw prompt can never be stored in the scaffold).
- **`packages/ai-platform/src/ops-llm-call-log.ts`** — `OpsLlmCallRecord` + `OpsLlmCallLogPort` + **`NotImplementedOpsLlmCallLog`** (no Iceberg write executor).

### F.3 — MCP tool registry contract + no-Trino-dependency test (AMD-20)
- The read-only MCP registry pre-exists in **`packages/ai-gateway-client`** (`mcp-tools.ts` / `mcp-dispatch.ts`): 11 tools, `access:'read'` only, `writeToolCount===0` (CI-blocking in isolation-fuzz), brand from principal, no SQL emission. Tools reach data only through certified metric-engine read seams.
- **NEW contract test `packages/ai-gateway-client/src/mcp-no-trino-dep.contract.test.ts`** — restates the §F "no Trino client dependency" invariant per **AMD-20 R1** (the literal package-ban is false-by-construction; the seam is metric-engine which holds trino-adapter). It asserts, as a **dependency-graph** check on the MCP package's own `package.json`:
  1. NO direct Trino/Presto/SQL client dependency (trino/presto/pg/mysql/knex/typeorm/… banlist).
  2. Runtime dependency set is **EXACTLY** `{@brain/metric-engine}` — the only path to Trino is transitively through the certified read seam.
  - **Result: 3/3 PASS.** (`@brain/ai-gateway-client` runtime deps == `["@brain/metric-engine"]`.)

### F.4 — `execution_mode` enum (auto unreachable)
- **`packages/ai-platform/src/execution-mode.ts`** — `ExecutionMode = suggest|approve|auto`, `DEFAULT_EXECUTION_MODE='suggest'`, `AgentActionEnvelopeBase {brand_id FIRST, execution_mode}` shared type for Wave G/H/I agent-action schemas.
  - **`auto` code path ABSENT/UNREACHABLE:** `assertExecutionModeReachable('auto')` **always throws** `AutoExecutionNotGovernedError` (Wave I governance precondition — human-approved policy + holdout + rollback — is not met in a scaffold). `suggest`/`approve` are inert (no executor wired either).
  - Test `execution-mode.test.ts` (5/5 PASS) locks the enum shape + auto-throws.

### F.5 — Git-backed `prompts/` + loader skeleton (no runtime)
- **`prompts/`** — git IS the version store (one file per revision, `*.vN`): `README.md`, `manifest.json` (authored index), `copilot/system.v1.md` (versioned template; `taskClass: conversational`).
- **`packages/prompt-loader`** — `PromptManifest`/`PromptTemplateRef` shapes + `PromptLoaderPort` + **`NotImplementedPromptLoader`** (`list()` reads the manifest; `load()` — fs text resolution — throws `PromptLoaderNotImplementedError`). **No agent runtime, no render/interpolation engine.**

### Flags (all default OFF — `packages/platform-flags/src/registry.ts`)
- `ai.gateway.call_logging` (F.2) — LiteLLM callback → ops_llm_calls + masking hook. OFF = no logger, no writes.
- `ai.copilot.tools` (F.3) — MCP copilot surface to an agent runtime. OFF = registry inert; `auto` unreachable.

---

## Invariants honored
- **Additive/non-breaking:** only new files + additive edits (flags registry, litellm config). No table/column dropped or renamed.
- **brand_id FIRST** on ops_llm_calls (row + partition key), on `AgentActionEnvelopeBase`, on the per-brand gateway key.
- **Money** = bigint minor + currency (`cost_minor`/`currency`).
- **Hexagonal:** `@brain/ai-platform` + `@brain/prompt-loader` are ports + types only — **no Kafka/Iceberg/Trino/Redis infra imports** (only a type-only `@brain/money` import). MCP package reaches Trino only via the certified metric-engine seam (dependency-graph test).
- **PII (§1.3):** no raw prompt/PII stored — hash inline + masking-gated redacted store; masking hook fails closed.
- **`// SPEC: F.*`** headers on every new module.

## What was DELIBERATELY deferred (per §PART 6)
- Agent runtime / orchestration / agent loops; conversational memory.
- Guardrail models; fine-tune management; any real PII-redaction model (masking hook is a stub).
- The ops_llm_calls **writer** (LiteLLM success/failure callback → Iceberg MERGE) — port only, `NotImplemented`.
- The redacted-PII prompt **store** implementation — referenced by `redacted_prompt_ref`, not built.
- Prompt **text resolution** (fs load) + render/interpolation — `load()` is `NotImplemented`.
- Re-homing MCP over compiled semantic views (AMD-20 **R2**) — deferred to post-Wave-D.2.
- Running the litellm compose service; per-brand key provisioning workflow (Secrets Manager).

## Evidence
- Typecheck clean: `platform-flags`, `ai-platform`, `prompt-loader`, `ai-gateway-client`.
- Tests: `ai-platform/execution-mode.test.ts` 5/5 · `ai-gateway-client/mcp-no-trino-dep.contract.test.ts` 3/3 · `platform-flags` 22/22 (regression) · `isolation-fuzz/mcp.test.ts` 19/19 (unchanged, still green).

## Files
- `infra/litellm.config.yaml` (edited: task_class_routing + per-brand rate-limit key shape)
- `db/iceberg/ops_llm_calls.sql` (new)
- `packages/ai-platform/{package.json,tsconfig.json,src/{index,execution-mode,pii-masking,ops-llm-call-log,execution-mode.test}.ts}` (new)
- `packages/prompt-loader/{package.json,tsconfig.json,src/index.ts}` (new)
- `prompts/{README.md,manifest.json,copilot/system.v1.md}` (new)
- `packages/ai-gateway-client/src/mcp-no-trino-dep.contract.test.ts` (new)
- `packages/platform-flags/src/registry.ts` (edited: F flags OFF)
