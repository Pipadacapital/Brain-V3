// SPEC: I
/**
 * WebhookExecutor — Wave I SCAFFOLD adapter (fail-closed, NotImplemented).
 *
 * Would POST the action payload to a brand-configured outbound webhook target. NO logic here:
 * execute() and rollback() throw NotImplementedError. Gated by the platform flag
 * `actions.executor.webhook` (default OFF) at the wiring layer. supportsRollback=false →
 * governance gate refuses 'auto' (a fired webhook's downstream effect is not generically reversible;
 * a per-target compensating call must be modeled before autonomy).
 */
import {
  type ActionEnvelope,
  type ExecutionResult,
  type ExecutorName,
  type ExecutorPort,
  type RollbackResult,
  NotImplementedError,
} from '../domain/ExecutorPort.js';

export class WebhookExecutor implements ExecutorPort {
  readonly name: ExecutorName = 'webhook';
  readonly flag = 'actions.executor.webhook';
  readonly supportsRollback = false;

  async execute(_action: ActionEnvelope): Promise<ExecutionResult> {
    throw new NotImplementedError(this.name, 'execute');
  }

  async rollback(_action: ActionEnvelope, _executionRef: string): Promise<RollbackResult> {
    throw new NotImplementedError(this.name, 'rollback');
  }
}
