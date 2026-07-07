// SPEC: I
/**
 * @brain/action-core — ExecutorPort (Wave I, SCAFFOLD ONLY).
 *
 * Hexagonal port for the Action Platform: the domain-side contract every executor
 * adapter (shopify-discount, meta-audience, messaging, webhook) implements. This file
 * is PURE DOMAIN — no infra imports (no Kafka/HTTP/Redis/flags client), matching the
 * connector-core / identity-core convention. Infra wiring, flag resolution and event
 * publication live OUTSIDE this package.
 *
 * SCAFFOLD DISCIPLINE (PLAN-OF-RECORD §PART 6 / delta-plan "I action platform scaffold"):
 *   - Interfaces + types + fail-closed NotImplemented adapters ONLY.
 *   - NO external write executors, NO agent loops, NO scoring, NO business logic.
 *   - Every adapter throws {@link NotImplementedError} from execute() and rollback().
 *
 * GOVERNANCE (Wave-I gate precondition, PLAN-OF-RECORD §I): an executor may run in
 * execution_mode 'auto' ONLY when all three hold for THAT executor:
 *   (a) a human-approved policy version authorizes it (action.approved.v1.policy_version),
 *   (b) holdout support exists (holdout_group carried in every action.*.v1 envelope), and
 *   (c) a working rollback is implemented ({@link ExecutorPort.rollback}, supportsRollback=true).
 * Until then supportsRollback=false on every adapter, so the gate CANNOT pass — auto is
 * structurally unreachable, which is the intended fail-closed posture.
 */

/** SPEC F/I execution-mode enum. Default 'suggest'; 'auto' unreachable until the governance gate passes. */
export type ExecutionMode = 'suggest' | 'approve' | 'auto';

/** The four named executor adapters. Values MATCH the `executor` enum in the action.*.v1 JSON Schemas. */
export type ExecutorName =
  | 'shopify-discount'
  | 'meta-audience'
  | 'messaging'
  | 'webhook';

/**
 * The action envelope as seen by the domain port (mirrors the action.requested/approved/executed
 * .v1 JSON Schema artifacts). brand_id is FIRST (tenant-first, I-S01). Money inside `payload` is
 * bigint minor units + a sibling currency_code — never a float, never blended. No raw PII (I-S02).
 */
export interface ActionEnvelope {
  /** Tenant key — brand_id-first on every action (I-S01). */
  readonly brand_id: string;
  /** Stable id across the action lifecycle. Idempotency key = (brand_id, action_id). */
  readonly action_id: string;
  /** OPTIONAL back-reference to the gold_decisions row (Wave H) that selected this action. */
  readonly decision_id?: string;
  /** Which executor adapter is targeted. */
  readonly executor: ExecutorName;
  /** suggest | approve | auto. Default 'suggest'. */
  readonly execution_mode: ExecutionMode;
  /** Executor-specific instruction body (money = bigint minor + currency_code; no raw PII). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** OPTIONAL auth-principal id of the human approver (audit; never raw PII). */
  readonly approved_by?: string;
  /** OPTIONAL versioned policy that authorized this action (governance precondition for 'auto'). */
  readonly policy_version?: string;
  /** OPTIONAL incrementality cohort label — carried from day one so lift is measurable when live. */
  readonly holdout_group?: string;
  /** OPTIONAL distributed-trace correlation id (ADR-009). */
  readonly correlation_id?: string;
}

/** Result of a (future) execution — carries the reversible handle a rollback consumes. */
export interface ExecutionResult {
  readonly action_id: string;
  readonly executor: ExecutorName;
  /** Executor-returned handle identifying the produced side effect (→ action.executed.v1.execution_ref). */
  readonly execution_ref: string;
}

/** Result of a (future) rollback — echoes the execution_ref that was reversed. */
export interface RollbackResult {
  readonly action_id: string;
  readonly executor: ExecutorName;
  /** The execution_ref that was reversed (→ action.rolled_back.v1.rollback_ref). */
  readonly rollback_ref: string;
}

/**
 * The port. Ports are the ONLY way the Action Platform reaches the outside world; adapters
 * are swapped without the domain knowing. SCAFFOLD: both methods are NotImplemented in every
 * adapter (fail-closed). `supportsRollback` is declared per adapter and is currently false
 * everywhere — the governance gate reads it and refuses 'auto' when false.
 */
export interface ExecutorPort {
  /** The adapter's stable name (matches ActionEnvelope.executor and the schema `executor` enum). */
  readonly name: ExecutorName;
  /** The platform flag (packages/platform-flags registry) that must be ON to expose this adapter. Default OFF. */
  readonly flag: string;
  /**
   * Whether a working rollback is implemented. Governance precondition (c) for 'auto'.
   * SCAFFOLD: false on every adapter → 'auto' is unreachable.
   */
  readonly supportsRollback: boolean;
  /** Execute the action against the external system. SCAFFOLD: throws {@link NotImplementedError}. */
  execute(action: ActionEnvelope): Promise<ExecutionResult>;
  /** Reverse a prior execution. SCAFFOLD: throws {@link NotImplementedError}. */
  rollback(action: ActionEnvelope, executionRef: string): Promise<RollbackResult>;
}

/**
 * Thrown by every scaffold adapter. Deliberately failing-by-design: the Action Platform
 * is contract-only in Wave I; there are NO external write executors yet. Fail-closed.
 */
export class NotImplementedError extends Error {
  /** Stable code mirrored into action.failed.v1.error_code. */
  readonly code = 'NOT_IMPLEMENTED' as const;
  constructor(executor: ExecutorName, method: 'execute' | 'rollback') {
    super(
      `[action-core] Executor '${executor}'.${method}() is not implemented (Wave I scaffold — ` +
        `fail-closed). No external write executor ships until the Wave-I governance gate is met.`,
    );
    this.name = 'NotImplementedError';
  }
}
