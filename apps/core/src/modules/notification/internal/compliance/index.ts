/**
 * Compliance bounded context — public surface for wiring + brand-scoped callers.
 *
 * The engine is brand-agnostic (brandId is supplied per evaluate() call), so ONE
 * engine instance serves every brand. Brand-scoped callers (the BFF marketing-send
 * path, the pending-window flush) pass brandId per call; RLS + the GUC scope the
 * underlying consent reads.
 */

export { CanContactEngine } from './can-contact.engine.js';
export { PgSuppressionQuery } from './suppression.query.js';
export { StubDltRegistry, StubNcprRegistry } from './stubs.js';
export { FunctionSaltPort } from './salt.adapter.js';
export type {
  SaltPort,
  DltRegistryPort,
  NcprRegistryPort,
  DndStatus,
} from './ports.js';
export {
  type ContactChannel,
  type ContactPurpose,
  type CanContactResult,
} from './contact-types.js';
