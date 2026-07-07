// SPEC: I
/**
 * MetaAudienceExecutor — Wave I SCAFFOLD adapter (fail-closed, NotImplemented).
 *
 * Would push/remove members on a Meta Custom Audience. NO logic here: execute() and rollback()
 * throw NotImplementedError. Gated by the platform flag `actions.executor.meta_audience` (default
 * OFF) at the wiring layer. supportsRollback=false → governance gate refuses 'auto'. PII (I-S02):
 * a real impl would push only hashed identifiers — never raw PII — but no such path exists here.
 */
import {
  type ActionEnvelope,
  type ExecutionResult,
  type ExecutorName,
  type ExecutorPort,
  type RollbackResult,
  NotImplementedError,
} from '../domain/ExecutorPort.js';

export class MetaAudienceExecutor implements ExecutorPort {
  readonly name: ExecutorName = 'meta-audience';
  readonly flag = 'actions.executor.meta_audience';
  readonly supportsRollback = false;

  async execute(_action: ActionEnvelope): Promise<ExecutionResult> {
    throw new NotImplementedError(this.name, 'execute');
  }

  async rollback(_action: ActionEnvelope, _executionRef: string): Promise<RollbackResult> {
    throw new NotImplementedError(this.name, 'rollback');
  }
}
