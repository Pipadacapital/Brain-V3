/**
 * Public interface for the `ai` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ (and the nlq/evaluation/
 * prompt-registry/mcp/provenance subdirs) and is private.
 * Spec: docs/05_Brain_Implementation_Build_Plan.md §3.
 *
 * Phase 8 — Decision-Intelligence Inputs (NLQ → registry binding, NEVER SQL/number).
 */

// Track A — the NLQ resolver: question → validated metric binding | honest refusal.
// Produces NO number and NO SQL; the metric-engine (Tier-0) computes the number.
export { resolveQuestion } from './nlq/resolve-question.js';
export type {
  ResolveOutcome,
  ValidatedBinding,
  ResolverRefusal,
} from './nlq/resolve-question.js';

// Track A — the versioned resolver system prompt (stable, cacheable prefix).
export { buildResolverSystemPrompt, RESOLVER_PROMPT_VERSION } from './prompt-registry/resolver-prompt.js';

// ── Track B — askBrain (resolve → engine number + confidence + reproducible provenance) ──
// Models NEVER produce numbers (I-ST01 / METRICS.md §5); the raw question is NEVER persisted
// (only question_redacted, D4); every answer is reproducible from snapshot_id (D3).
export { askBrain, reproduceAnswer } from './internal/ask-brain.js';
export type {
  AskBrainResult,
  AskBrainBinding,
  AskBrainDeps,
  ComputedNumber,
  MoneyRecord,
} from './internal/ask-brain.js';

// Track B — deterministic redaction + snapshot reproducibility handle + provenance writer.
export { redactQuestion } from './provenance/redact-question.js';
export { encodeSnapshot, decodeSnapshot } from './internal/snapshot.js';
export { PgAiProvenanceRepository } from './provenance/ai-provenance.repository.js';
export type {
  AiProvenanceInsert,
  AiProvenanceRow,
  ConfidenceGrade,
  TrustTier,
  ResolvedParams as ProvenanceResolvedParams,
} from './provenance/ai-provenance.dto.js';

// Track B — the READ-ONLY MCP tool registry (I-S08: writeToolCount === 0, CI-blocking).
export { MCP_TOOLS, writeToolCount, listMetricIds, FORBIDDEN_TOOL_NAME_SUBSTRINGS } from './mcp/tools.js';
export type { McpToolSpec, McpToolAccess } from './mcp/tools.js';
