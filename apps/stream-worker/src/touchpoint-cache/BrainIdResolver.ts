// SPEC: A.4
/**
 * DeterministicBrainIdResolver — resolve the EXISTING canonical brain_id for a collector
 * event, deterministically, at touchpoint-cache write time (SPEC: A.4).
 *
 * A.4 caches ONLY touchpoints resolvable to a DETERMINISTIC brain_id — anon-only events are
 * skipped (the cache is a best-effort hot slice; Iceberg is truth and the journey engine
 * back-fills the anonymous→identified history). This is a READ-ONLY lookup against the
 * identity SoR — it never mints/links/merges (that is the identity-bridge consumer's job on
 * its own group). It reuses the SAME extraction + salted hashing as ResolveIdentityUseCase
 * (via extract-identifiers.ts) so a hash computed here equals the identity graph's edge.
 *
 * FAST ANON PATH (latency budget, A.4 ≤ 50ms p99): if the event carries no
 * deterministic-resolvable identifier we return null WITHOUT touching the identity store —
 * the overwhelmingly common anonymous page-view costs only a cheap in-memory extraction.
 */
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityStore } from '../domain/identity/IdentityStore.js';
import { extractRawIdentifierFields, buildIdentifiers } from '../domain/identity/extract-identifiers.js';

/** Resolves a parsed collector event → its deterministic brain_id, or null when unresolvable. */
export interface IDeterministicBrainIdResolver {
  /**
   * @returns the single active brain_id this event's deterministic identifiers map to, or null
   *   when the event is anon-only, unmapped, OR ambiguous (>1 active brain_id — never guess).
   */
  resolve(brandId: string, parsed: Record<string, unknown>): Promise<string | null>;
}

export class IdentityStoreBrainIdResolver implements IDeterministicBrainIdResolver {
  constructor(
    private readonly saltProvider: SaltProvider,
    private readonly identityRepo: IdentityStore,
  ) {}

  async resolve(brandId: string, parsed: Record<string, unknown>): Promise<string | null> {
    const { fields, regionCode, hasAny } = extractRawIdentifierFields(parsed);
    // Fast anon path: nothing to resolve → skip WITHOUT an identity-store round trip.
    if (!hasAny) return null;

    const saltHex = await this.saltProvider.saltHexForBrand(brandId);
    const identifiers = buildIdentifiers(fields, saltHex, regionCode);

    // DETERMINISTIC only: strong / strong_on_link / medium (device_id, anon_id — resolve-only
    // adoption of an already-known brain_id). tier='weak' (cookie/ip/fingerprint/session) is
    // NEVER a deterministic resolution signal → excluded (that is the probabilistic lane, A.3).
    const deterministic = identifiers.filter((i) => i.tier !== 'weak');
    if (deterministic.length === 0) return null;

    const state = await this.identityRepo.readState(
      brandId,
      deterministic.map((i) => ({ type: i.type, hash: i.hash })),
    );

    // Distinct active brain_ids the event's identifiers currently map to.
    const brainIds = new Set<string>();
    for (const link of state.existingLinks) {
      if (link.is_active && link.brain_id) brainIds.add(link.brain_id);
    }
    // Exactly one → deterministic. Zero → unmapped (skip). More than one → ambiguous
    // (pre-merge conflict): never cache to a guessed id — skip and let the merge lane settle it.
    if (brainIds.size !== 1) return null;
    return [...brainIds][0]!;
  }
}
