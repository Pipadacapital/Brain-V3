// SPEC: F.4
/**
 * execution-mode.ts — the shared `execution_mode` enum carried on EVERY agent-action schema.
 *
 * §F: "`execution_mode` enum (`suggest|approve|auto`) on every agent-action schema, default
 *      `suggest`; `auto` unreachable until Wave I governance."
 *
 * SCAFFOLD-ONLY (PLAN-OF-RECORD §PART 6): the ENUM is present so Wave I action envelopes
 * (action.requested/approved/executed/… — packages owned by the Action-Platform wave) and any
 * agent-action schema can carry it from day one. There is NO agent runtime and NO executor here.
 *
 * The `auto` CODE PATH IS ABSENT/UNREACHABLE BY CONSTRUCTION:
 *   - `DEFAULT_EXECUTION_MODE` is `suggest`.
 *   - `assertExecutionModeReachable` is the single gate any future dispatcher MUST pass through.
 *     It throws `AutoExecutionNotGovernedError` for `auto` — the Wave I governance precondition
 *     (§I: "no `auto` without human-approved policy version + holdout support + rollback per
 *     executor") is not met in a scaffold, so `auto` can never be reached. Removing this guard
 *     to reach `auto` is a gate-failing defect.
 */

/**
 * ExecutionMode — how an agent-authored action is allowed to proceed.
 *  - `suggest` : surface to a human; nothing is executed (the DEFAULT, always safe).
 *  - `approve` : queue for explicit human approval before execution (Wave I approval envelope).
 *  - `auto`    : autonomous execution — DEFERRED to Wave I governance; unreachable in scaffold.
 */
export const EXECUTION_MODES = ['suggest', 'approve', 'auto'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** The default execution mode for any agent-action schema — always the safe `suggest`. */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'suggest';

/** Type guard for an untrusted string → ExecutionMode. Unknown values are NOT a valid mode. */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

/**
 * AutoExecutionNotGovernedError — thrown whenever code attempts to REACH the `auto` path before
 * Wave I governance exists. In the scaffold this is unconditional: `auto` has no governed path.
 */
export class AutoExecutionNotGovernedError extends Error {
  readonly code = 'AUTO_EXECUTION_NOT_GOVERNED';
  constructor(mode: ExecutionMode) {
    super(
      `execution_mode='${mode}' is not reachable: autonomous execution requires Wave I governance ` +
        `(human-approved policy version + holdout support + per-executor rollback). Scaffold has none.`,
    );
    this.name = 'AutoExecutionNotGovernedError';
  }
}

/**
 * assertExecutionModeReachable — the SINGLE gate any future action dispatcher must pass through
 * before acting on a mode. `suggest`/`approve` are inert (no execution here either); `auto` ALWAYS
 * throws in the scaffold. This function is the structural proof that no `auto` code path exists.
 */
export function assertExecutionModeReachable(mode: ExecutionMode): void {
  if (mode === 'auto') {
    throw new AutoExecutionNotGovernedError(mode);
  }
  // `suggest` / `approve`: reachable as data, but NO executor is wired in the scaffold.
}

/**
 * AgentActionEnvelopeBase — the minimal shared shape every agent-action schema (Wave G/H/I)
 * composes. brand_id FIRST (§0.5 / I-S01); execution_mode present with a safe default. This is a
 * TYPE contract only — no behavior, no runtime.
 */
export interface AgentActionEnvelopeBase {
  /** Tenant key — FIRST field on every agent-action schema (I-S01). */
  readonly brand_id: string;
  /** How this action may proceed. Defaults to `suggest`; `auto` is unreachable (Wave I gate). */
  readonly execution_mode: ExecutionMode;
}
