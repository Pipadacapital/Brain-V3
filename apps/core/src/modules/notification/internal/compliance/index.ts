/**
 * Compliance bounded context — public surface for wiring + brand-scoped callers.
 *
 * The engine is brand-agnostic (brandId is supplied per evaluate() call), so ONE
 * engine instance serves every brand. Brand-scoped callers (the BFF marketing-send
 * path, the pending-window flush) pass brandId per call; RLS + the GUC scope the
 * underlying consent reads.
 */

import type { DbClient } from '@brain/db';
import { CanContactEngine } from './can-contact.engine.js';
import { PgSuppressionQuery } from './suppression.query.js';
import { StubDltRegistry, StubNcprRegistry } from './stubs.js';
import { EnvSaltPort, FunctionSaltPort } from './salt.adapter.js';
import type { SaltPort } from './ports.js';

export { CanContactEngine } from './can-contact.engine.js';
export { PgSuppressionQuery } from './suppression.query.js';
export { StubDltRegistry, StubNcprRegistry } from './stubs.js';
export { EnvSaltPort, FunctionSaltPort } from './salt.adapter.js';
export { ConsentWriter } from './consent-write.js';
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
  isPhoneChannel,
  identifierTypeForChannel,
} from './contact-types.js';
export { evaluateSendWindow } from './policies/send-window.policy.js';

export interface BuildEngineOptions {
  db: DbClient;
  /**
   * Optional explicit salt source. Defaults to EnvSaltPort (env-var per-brand salt).
   * Pass a FunctionSaltPort wrapping an existing salt fn to reuse one salt source.
   */
  salt?: SaltPort;
  saltFn?: (brandId: string) => Promise<string>;
  now?: () => Date;
}

/**
 * Build the default-closed can_contact() engine with the shipped (fail-closed) DLT +
 * NCPR stubs and the Pg suppression query. The DLT/NCPR stubs BLOCK until the real
 * registries land (documented platform follow-up).
 */
export function buildCanContactEngine(opts: BuildEngineOptions): CanContactEngine {
  const salt: SaltPort =
    opts.salt ??
    (opts.saltFn ? new FunctionSaltPort(opts.saltFn) : new EnvSaltPort());
  return new CanContactEngine({
    salt,
    suppression: new PgSuppressionQuery(opts.db),
    dlt: new StubDltRegistry(),
    ncpr: new StubNcprRegistry(),
    now: opts.now,
  });
}
