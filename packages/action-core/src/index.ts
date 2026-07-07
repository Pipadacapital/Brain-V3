// SPEC: I
/**
 * @brain/action-core — Wave I Action Platform (SCAFFOLD ONLY).
 *
 * Public surface: the ExecutorPort contract + envelope/result types, the four fail-closed
 * NotImplemented adapters, the governance gate predicate, and a name→adapter registry. NO external
 * write executors, NO agent loops, NO scoring (delta-plan "I action platform scaffold").
 *
 * Every adapter is gated by its own platform flag (packages/platform-flags, all default OFF) at the
 * WIRING layer — this package stays infra-free (hexagonal, matches connector-core/identity-core).
 */
export {
  type ActionEnvelope,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutorName,
  type ExecutorPort,
  type RollbackResult,
  NotImplementedError,
} from './domain/ExecutorPort.js';

export { type AutoGateResult, evaluateAutoGate } from './domain/governance.js';

import type { ExecutorName, ExecutorPort } from './domain/ExecutorPort.js';
import { ShopifyDiscountExecutor } from './adapters/ShopifyDiscountExecutor.js';
import { MetaAudienceExecutor } from './adapters/MetaAudienceExecutor.js';
import { MessagingExecutor } from './adapters/MessagingExecutor.js';
import { WebhookExecutor } from './adapters/WebhookExecutor.js';

export { ShopifyDiscountExecutor } from './adapters/ShopifyDiscountExecutor.js';
export { MetaAudienceExecutor } from './adapters/MetaAudienceExecutor.js';
export { MessagingExecutor } from './adapters/MessagingExecutor.js';
export { WebhookExecutor } from './adapters/WebhookExecutor.js';

/**
 * The four named executor adapters, keyed by name. The wiring layer resolves each adapter's `.flag`
 * against the per-brand flag store and only dispatches when ON (default OFF → nothing executes).
 * SCAFFOLD: every adapter throws NotImplementedError, so this registry is dispatch-shaped but inert.
 */
export const EXECUTOR_REGISTRY: Readonly<Record<ExecutorName, ExecutorPort>> = Object.freeze({
  'shopify-discount': new ShopifyDiscountExecutor(),
  'meta-audience': new MetaAudienceExecutor(),
  'messaging': new MessagingExecutor(),
  'webhook': new WebhookExecutor(),
});

/** All four executor names (drives contract tests + operator surfaces). */
export const EXECUTOR_NAMES = Object.keys(EXECUTOR_REGISTRY) as ExecutorName[];
