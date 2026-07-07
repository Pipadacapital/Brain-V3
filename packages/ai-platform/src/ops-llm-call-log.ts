// SPEC: F.2
/**
 * ops-llm-call-log.ts — the ops_llm_calls WRITER port + failing-by-design adapter.
 *
 * §F: LiteLLM success/failure callback logs each model call to `ops_llm_calls
 *     {brand_id, request_id, model, prompt_hash, tokens_in/out, cost_minor, currency, latency_ms, ts}`.
 *
 * SCAFFOLD-ONLY (PLAN-OF-RECORD §PART 6): a hexagonal PORT (the record shape + the writer
 * interface the LiteLLM callback would depend on) plus a NotImplemented adapter behind the
 * `ai.gateway.call_logging` flag (default OFF). NO Iceberg write executor here — the table DDL is
 * db/iceberg/ops_llm_calls.sql (inert). This package has NO infra imports (I: hexagonal boundary).
 *
 * MONEY (§1.2): cost is bigint MINOR units + a sibling ISO-4217 `currency`. NEVER a float.
 * PRIVACY (§1.3/§F): only `promptHash` is inline; a human-readable prompt is referenced via
 *   `redactedPromptRef` and ONLY exists after passing the PiiMaskingHook (pii-masking.ts).
 */

import type { CurrencyCode } from '@brain/money';

/**
 * OpsLlmCallRecord — one append-only ops_llm_calls row. Mirrors db/iceberg/ops_llm_calls.sql.
 * brand_id FIRST (I-S01). No raw prompt, no raw PII — hash + opaque ref only.
 */
export interface OpsLlmCallRecord {
  /** Tenant key — FIRST field (I-S01). */
  readonly brandId: string;
  /** Gateway request id — idempotency component (brandId, requestId). */
  readonly requestId: string;
  /** Call time (UTC ISO-8601). */
  readonly ts: string;
  /** The resolved model alias/id the gateway routed to. */
  readonly model: string;
  /** The task-class alias requested (litellm task_class_routing), if any. */
  readonly taskClass?: string;
  /** SHA-256 hex of the normalized prompt — the ONLY prompt provenance stored inline. */
  readonly promptHash: string;
  /** Opaque pointer into the redacted-PII store (post masking hook). NEVER an inline raw prompt. */
  readonly redactedPromptRef?: string;
  /** Prompt tokens. */
  readonly tokensIn: number;
  /** Completion tokens. */
  readonly tokensOut: number;
  /** Call cost in ISO-4217 MINOR units (bigint). NEVER a float. */
  readonly costMinor: bigint;
  /** ISO-4217 code that siblings costMinor. */
  readonly currency: CurrencyCode;
  /** End-to-end gateway latency, whole milliseconds. */
  readonly latencyMs: number;
  /** success | failure | budget_blocked. */
  readonly outcome?: 'success' | 'failure' | 'budget_blocked';
  /** OTEL trace id from the gateway span. */
  readonly traceId?: string;
  /** Per-subject envelope key id when subject-linked (crypto-shred anchor). Null = not linked. */
  readonly subjectKeyId?: string;
}

/**
 * OpsLlmCallLogPort — the writer the LiteLLM success/failure callback depends on. A real adapter
 * (Wave F logic) MERGE-appends to brain_ops.ops_llm_calls via a Spark/Iceberg seam.
 */
export interface OpsLlmCallLogPort {
  /**
   * record — append one ops_llm_calls row.
   * @throws OpsLlmCallLogNotImplementedError in the scaffold (no Iceberg writer is wired).
   */
  record(row: OpsLlmCallRecord): Promise<void>;
}

/** Thrown by the scaffold logger — no ops_llm_calls writes happen until Wave F ships. */
export class OpsLlmCallLogNotImplementedError extends Error {
  readonly code = 'OPS_LLM_CALL_LOG_NOT_IMPLEMENTED';
  constructor() {
    super(
      'ops_llm_calls logger is a scaffold stub (SPEC:F.2): no Iceberg write executor is wired. ' +
        'Enable behind the ai.gateway.call_logging flag once Wave F logic ships.',
    );
    this.name = 'OpsLlmCallLogNotImplementedError';
  }
}

/**
 * NotImplementedOpsLlmCallLog — the failing-by-design adapter. The LiteLLM callback binds to this
 * until Wave F; the flag stays OFF, so no attempt to write is ever made in the scaffold.
 */
export class NotImplementedOpsLlmCallLog implements OpsLlmCallLogPort {
  async record(_row: OpsLlmCallRecord): Promise<void> {
    throw new OpsLlmCallLogNotImplementedError();
  }
}
