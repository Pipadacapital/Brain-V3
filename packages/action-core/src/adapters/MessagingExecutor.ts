// SPEC: I
/**
 * MessagingExecutor — Wave I SCAFFOLD adapter (fail-closed, NotImplemented).
 *
 * Would send a templated message (email/SMS/WhatsApp) via a messaging provider. NO logic here:
 * execute() and rollback() throw NotImplementedError. Gated by the platform flag
 * `actions.executor.messaging` (default OFF) at the wiring layer. supportsRollback=false →
 * governance gate refuses 'auto' (a sent message is often irreversible — rollback support must be
 * modeled explicitly before autonomy). PII (I-S02): no raw recipient PII in any scaffold path.
 */
import {
  type ActionEnvelope,
  type ExecutionResult,
  type ExecutorName,
  type ExecutorPort,
  type RollbackResult,
  NotImplementedError,
} from '../domain/ExecutorPort.js';

export class MessagingExecutor implements ExecutorPort {
  readonly name: ExecutorName = 'messaging';
  readonly flag = 'actions.executor.messaging';
  readonly supportsRollback = false;

  async execute(_action: ActionEnvelope): Promise<ExecutionResult> {
    throw new NotImplementedError(this.name, 'execute');
  }

  async rollback(_action: ActionEnvelope, _executionRef: string): Promise<RollbackResult> {
    throw new NotImplementedError(this.name, 'rollback');
  }
}
