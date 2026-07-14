// SPEC: I
/**
 * ShopifyDiscountExecutor — Wave I SCAFFOLD adapter (fail-closed, NotImplemented).
 *
 * Would create/expire Shopify price rules / discount codes. NO logic here: execute() and
 * rollback() throw NotImplementedError. Gated by the platform flag `actions.executor.shopify_discount`
 * (default OFF) at the wiring layer — this domain adapter never imports the flags client (hexagonal).
 * supportsRollback=false → the governance gate refuses 'auto' for this executor.
 */
import {
  type ActionEnvelope,
  type ExecutionResult,
  type ExecutorName,
  type ExecutorPort,
  type RollbackResult,
  NotImplementedError,
} from '../domain/ExecutorPort.js';

export class ShopifyDiscountExecutor implements ExecutorPort {
  readonly name: ExecutorName = 'shopify-discount';
  readonly flag = 'actions.executor.shopify_discount';
  readonly supportsRollback = false;

  async execute(_action: ActionEnvelope): Promise<ExecutionResult> {
    throw new NotImplementedError(this.name, 'execute');
  }

  async rollback(_action: ActionEnvelope, _executionRef: string): Promise<RollbackResult> {
    throw new NotImplementedError(this.name, 'rollback');
  }
}
