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
export type {
  ResolveOutcome,
  ValidatedBinding,
  ResolverRefusal,
} from './nlq/resolve-question.js';

// ── Track B — askBrain (resolve → engine number + confidence + reproducible provenance) ──
// Models NEVER produce numbers (I-ST01 / METRICS.md §5); the raw question is NEVER persisted
// (only question_redacted, D4); every answer is reproducible from snapshot_id (D3).
export { askBrain } from './internal/ask-brain.js';
export type {
  AskBrainResult,
  AskBrainBinding,
  AskBrainDeps,
  ComputedNumber,
  MoneyRecord,
} from './internal/ask-brain.js';

// Track B — provenance DTO types (redaction/snapshot/repository impls are deep-imported internally).
export type {
  AiProvenanceInsert,
  AiProvenanceRow,
  ConfidenceGrade,
  TrustTier,
  ResolvedParams as ProvenanceResolvedParams,
} from './provenance/ai-provenance.dto.js';

// Track B — the READ-ONLY MCP tool registry types (registry SoR: @brain/ai-gateway-client).
export type { McpToolSpec, McpToolAccess } from './mcp/tools.js';

// Track B — the READ-ONLY MCP tool DISPATCH MOUNT (D5 / I-S08 / I-S01). brand_id from the principal.
export { createMcpDispatch } from './mcp/tools.js';
export type { McpMountDeps, McpIdentitySeams } from './mcp/tools.js';
