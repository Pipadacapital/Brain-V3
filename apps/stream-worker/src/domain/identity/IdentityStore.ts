/**
 * IdentityStore — the store contract the identity resolver use-case depends on.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the Neo4jIdentityRepository (the SoR) satisfies this
 * contract, so ResolveIdentityUseCase is store-agnostic — the pure IdentityResolver runs unchanged.
 * (The legacy PG IdentityRepository was removed when the PG identity tables were dropped.)
 */
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
} from './IdentityResolver.js';

export interface IdentityReadState {
  existingLinks: ExistingLink[];
  sharedUtilityMap: Map<string, SharedUtilityState>;
  phoneCount: Map<string, number>; // phone hash → windowed distinct brain_id count
  aliasChain: Set<string>;
  brandConfig: BrandPhoneGuardConfig;
}

export interface IdentityStore {
  readState(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now?: Date,
  ): Promise<IdentityReadState>;
  writeOutcome(
    brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
  ): Promise<{ written: boolean }>;
}
