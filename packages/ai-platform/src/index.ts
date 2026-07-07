// SPEC: F
/**
 * @brain/ai-platform — Wave F (AI Platform Infrastructure) SCAFFOLD-ONLY domain package.
 *
 * Hexagonal PORTS + failing-by-design adapters + shared types for the AI platform. NO agent
 * runtime, NO executor, NO Iceberg/Trino/Kafka infra imports (I: hexagonal boundary). Everything
 * here is inert until the owning wave's logic ships behind a platform flag (all default OFF):
 *   - execution_mode enum (F.4) — on every agent-action schema; `auto` unreachable.
 *   - PII masking hook (F.2) — redacted-PII prompt store gate; NotImplemented stub.
 *   - ops_llm_calls writer port (F.2) — LiteLLM call-log; NotImplemented stub.
 *
 * @see knowledge-base/contracts/CONTRACT-F.md
 */

export {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
  assertExecutionModeReachable,
  AutoExecutionNotGovernedError,
  type ExecutionMode,
  type AgentActionEnvelopeBase,
} from './execution-mode.js';

export {
  NotImplementedPiiMaskingHook,
  MaskingNotImplementedError,
  type PiiMaskingHook,
  type MaskedPrompt,
} from './pii-masking.js';

export {
  NotImplementedOpsLlmCallLog,
  OpsLlmCallLogNotImplementedError,
  type OpsLlmCallLogPort,
  type OpsLlmCallRecord,
} from './ops-llm-call-log.js';
