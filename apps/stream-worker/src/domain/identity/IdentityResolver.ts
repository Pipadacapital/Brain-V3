/**
 * IdentityResolver — deterministic brain_id resolution (v1-deterministic, D-5).
 *
 * Pure domain logic: no Postgres, no Kafka imports. Accepts the pre-fetched
 * state from the IdentityRepository and produces a ResolveOutcome.
 *
 * Resolution algorithm (§2 of architecture-plan):
 *   1. For each identifier hash: look up existing active identity_links.
 *   2. Phone-guard: if a phone hash is suppressed or would exceed the threshold
 *      after resolving this event, exclude it from merge (D-1).
 *   3. Decisions:
 *      - 0 matches → mint new brain_id.
 *      - 1 match → link additional identifiers to existing brain_id.
 *      - ≥2 distinct brain_ids → merge: canonical = lowest UUID (deterministic).
 *        Cycle-guard: walk alias chain; loop → skip merge, route to review queue.
 *   4. Deterministic merge_id = sha256(brand_id ‖ canonical ‖ merged ‖ 'v1-deterministic') (D-4).
 *
 * No probabilistic or ML merge (D-5). @effort("deterministic").
 */

import { createHash, randomUUID } from 'node:crypto';

export const RULE_VERSION = 'v1-deterministic';

/** An identifier extracted from the Bronze event payload. */
export interface ExtractedIdentifier {
  // C2: device_id + anon_id (brain_anon_id) are RESOLUTION INPUTS in addition to the strong PII
  // identifiers. They are tier='medium' — see the resolve-only / never-merge gating in resolve().
  type: 'email' | 'phone' | 'storefront_customer_id' | 'device_id' | 'anon_id';
  hash: string;         // 64-hex SHA-256(salt ‖ normalized)
  tier: 'strong' | 'strong_on_link' | 'medium' | 'weak';
  confidence: 'high' | 'low';
  rawValue?: string;    // ONLY for contact_pii write — never stored in identity_link
}

/** Existing identity_link row returned from DB (only hashed values). */
export interface ExistingLink {
  brain_id: string;
  identifier_type: string;
  identifier_value: string;  // 64-hex hash
  is_active: boolean;
}

/** Shared utility identifier state for phone-guard evaluation. */
export interface SharedUtilityState {
  identifier_type: string;
  identifier_value: string;  // 64-hex hash
  profile_count: number;
  suppressed_until: Date | null;
}

/** Brand phone-guard config from DB. */
export interface BrandPhoneGuardConfig {
  phone_guard_threshold: number;    // DEFAULT 10
  suppression_window_days: number;  // DEFAULT 30
}

/** Outcome of the resolution. */
export type ResolveAction = 'minted' | 'linked' | 'merged' | 'suppressed' | 'skipped';

export interface MergeSpec {
  canonicalBrainId: string;
  mergedBrainId: string;
  mergeId: string;  // deterministic SHA-256 (D-4)
}

export interface ResolveOutcome {
  action: ResolveAction;
  brainId: string;                      // the resolved/minted canonical brain_id
  newLinks: ExtractedIdentifier[];      // identifiers to insert as new identity_links
  merge?: MergeSpec;                    // present only on 'merged'
  phoneGuardUpdates: Array<{            // shared_utility_identifier rows to upsert
    identifier_type: string;
    identifier_value: string;
    profile_count: number;
    suppress: boolean;
    suppressed_until: Date | null;
  }>;
  routeToReview: boolean;               // cycle-guard or suppressed phone conflict
  reviewReason?: string;
  contactPiiWrites: Array<{             // contact_pii rows (raw PII only goes here)
    brain_id: string;
    pii_type: 'email' | 'phone';
    raw_value: string;
    identifier_hash: string;
  }>;
}

export class IdentityResolver {
  /**
   * Resolve identifiers to a brain_id.
   *
   * @param brandId            UUID of the brand (for merge_id computation).
   * @param identifiers        Extracted + hashed identifiers from the event.
   * @param existingLinks      Active identity_links for matching hashes (pre-fetched).
   * @param sharedUtilityMap   phone-guard state keyed by identifier_value (hash).
   * @param phoneCount         Windowed distinct brain_id count per phone hash.
   * @param brandConfig        Brand phone_guard_threshold + suppression_window_days.
   * @param aliasChain         Set of already-merged brain_ids (for cycle detection).
   * @param now                Current timestamp.
   */
  resolve(
    brandId: string,
    identifiers: ExtractedIdentifier[],
    existingLinks: ExistingLink[],
    sharedUtilityMap: Map<string, SharedUtilityState>,
    phoneCount: Map<string, number>,      // phone hash → windowed distinct brain_id count
    brandConfig: BrandPhoneGuardConfig,
    aliasChain: Set<string>,              // all live alias observed_brain_ids
    now: Date = new Date(),
  ): ResolveOutcome {
    // ── 1. Separate strong identifiers from medium/weak ───────────────────────
    const strongIds = identifiers.filter(
      (i) => i.tier === 'strong' || i.tier === 'strong_on_link',
    );

    // ── 2. Phone-guard: filter out suppressed phone hashes ───────────────────
    const eligibleStrongIds: ExtractedIdentifier[] = [];
    const phoneGuardUpdates: ResolveOutcome['phoneGuardUpdates'] = [];

    for (const id of strongIds) {
      if (id.type === 'phone') {
        const state = sharedUtilityMap.get(id.hash) ?? null;
        const suppressedUntil = state?.suppressed_until ?? null;
        const existingCount = phoneCount.get(id.hash) ?? 0;

        // Active suppression check
        if (suppressedUntil && suppressedUntil > now) {
          // Suppressed phone → route to review, do NOT use as merge key
          phoneGuardUpdates.push({
            identifier_type: 'phone',
            identifier_value: id.hash,
            profile_count: existingCount,
            suppress: true,
            suppressed_until: suppressedUntil,
          });
          continue; // exclude from eligibleStrongIds
        }

        // Would the new resolution push count over threshold?
        // We check: if this phone resolves to a DIFFERENT brain_id than existing,
        // the count would increase by 1.
        const wouldExceed = existingCount + 1 > brandConfig.phone_guard_threshold;
        if (wouldExceed) {
          const newCount = existingCount + 1;
          const suppressUntil = this.computeSuppressedUntil(now, brandConfig.suppression_window_days);
          phoneGuardUpdates.push({
            identifier_type: 'phone',
            identifier_value: id.hash,
            profile_count: newCount,
            suppress: true,
            suppressed_until: suppressUntil,
          });
          continue; // exclude from merge key set
        }

        eligibleStrongIds.push(id);
      } else {
        eligibleStrongIds.push(id);
      }
    }

    // ── 3. Match eligible STRONG identifiers against existing links ───────────
    // Strong identifiers (email / phone / storefront_customer_id) are the ONLY merge keys:
    // ≥2 distinct strong-matched brain_ids → a deterministic merge (the union-find step).
    const matchedBrainIds = new Set<string>();
    for (const id of eligibleStrongIds) {
      for (const link of existingLinks) {
        if (
          link.identifier_type === id.type &&
          link.identifier_value === id.hash &&
          link.is_active
        ) {
          matchedBrainIds.add(link.brain_id);
        }
      }
    }

    // ── 3b. C2: device_id / anon_id (tier='medium') — RESOLVE-ONLY, NEVER MERGE ──
    // Medium identifiers let an anonymous event ADOPT an already-known brain_id (so a
    // device/anon session that previously linked to a strong identifier resolves to the
    // same person instead of minting a fresh ghost). They are TIER-GATED so they can NEVER
    // fold two distinct people together:
    //   • They are consulted ONLY when the strong identifiers produced ≤1 brain_id.
    //   • If the medium matches would push the distinct-brain_id set to ≥2, we DISCARD the
    //     medium contribution entirely (strong wins; a shared device never triggers a merge).
    // This preserves the deterministic union-find: merges are decided exclusively by strong keys.
    const mediumIds = identifiers.filter((i) => i.tier === 'medium');
    if (matchedBrainIds.size <= 1 && mediumIds.length > 0) {
      const mediumMatched = new Set<string>();
      for (const id of mediumIds) {
        for (const link of existingLinks) {
          if (link.identifier_type === id.type && link.identifier_value === id.hash && link.is_active) {
            mediumMatched.add(link.brain_id);
          }
        }
      }
      // Union the medium matches with the (≤1) strong match. Adopt ONLY if the result is a
      // single brain_id — otherwise the medium ids are ambiguous (shared device) → drop them.
      const union = new Set<string>([...matchedBrainIds, ...mediumMatched]);
      if (union.size === 1) {
        matchedBrainIds.add([...union][0]!);
      }
      // union.size >= 2 → medium evidence is conflicting; ignore it (no merge, no adoption).
    }

    // ── 4. Resolve decision ───────────────────────────────────────────────────
    const contactPiiWrites: ResolveOutcome['contactPiiWrites'] = [];

    // Collect contact_pii writes (for raw PII identifiers — email + phone)
    for (const id of identifiers) {
      if ((id.type === 'email' || id.type === 'phone') && id.rawValue) {
        // Will be written to contact_pii after brain_id is resolved
        contactPiiWrites.push({
          brain_id: '', // to be filled after resolution
          pii_type: id.type,
          raw_value: id.rawValue,
          identifier_hash: id.hash,
        });
      }
    }

    if (matchedBrainIds.size === 0) {
      // MINT new brain_id
      const brainId = randomUUID();
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: brainId }));
      return {
        action: 'minted',
        brainId,
        newLinks: identifiers,  // all identifiers go to new customer
        phoneGuardUpdates,
        routeToReview: false,
        contactPiiWrites: filled,
      };
    }

    if (matchedBrainIds.size === 1) {
      // LINK — attach new identifiers to the existing brain_id
      const brainId = [...matchedBrainIds][0]!;
      // Only insert identifiers not already linked
      const existingHashes = new Set(
        existingLinks
          .filter((l) => l.brain_id === brainId && l.is_active)
          .map((l) => `${l.identifier_type}:${l.identifier_value}`),
      );
      const newLinks = identifiers.filter(
        (id) => !existingHashes.has(`${id.type}:${id.hash}`),
      );
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: brainId }));
      return {
        action: 'linked',
        brainId,
        newLinks,
        phoneGuardUpdates,
        routeToReview: false,
        contactPiiWrites: filled,
      };
    }

    // ≥2 distinct brain_ids → potential MERGE
    const sortedIds = [...matchedBrainIds].sort(); // lowest UUID = canonical (deterministic)
    const canonicalBrainId = sortedIds[0]!;
    const mergedBrainId = sortedIds[sortedIds.length - 1]!;

    // Cycle-guard: if mergedBrainId is already in the alias chain → loop detected
    if (aliasChain.has(canonicalBrainId) || aliasChain.has(mergedBrainId)) {
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: canonicalBrainId }));
      return {
        action: 'skipped',
        brainId: canonicalBrainId,
        newLinks: [],
        phoneGuardUpdates,
        routeToReview: true,
        reviewReason: `cycle-guard: alias chain collision (canonical=${canonicalBrainId} merged=${mergedBrainId})`,
        contactPiiWrites: filled,
      };
    }

    // Deterministic merge_id = sha256(brand_id ‖ canonical ‖ merged ‖ rule_version) (D-4)
    const mergeId = this.computeMergeId(brandId, canonicalBrainId, mergedBrainId);

    const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: canonicalBrainId }));
    return {
      action: 'merged',
      brainId: canonicalBrainId,
      newLinks: [],  // existing identifiers already linked; no new inserts on merge
      merge: { canonicalBrainId, mergedBrainId, mergeId },
      phoneGuardUpdates,
      routeToReview: false,
      contactPiiWrites: filled,
    };
  }

  /**
   * Compute deterministic merge_id as a UUID derived from SHA-256 (D-4).
   *
   * merge_id = UUID-formatted prefix of sha256(brand_id ‖ canonical ‖ merged ‖ rule_version).
   * The UUID format (8-4-4-4-12 hex groups) is derived from the first 32 hex chars of the hash.
   * Version bits are set to 5 (name-based SHA, closest standard) for standards compliance.
   *
   * Deterministic: same inputs → same UUID → ON CONFLICT (merge_id) DO NOTHING = idempotent (D-4).
   * Replay: reprocessing the same Bronze event produces the same merge_id → exactly 1 row.
   */
  computeMergeId(
    brandId: string,
    canonicalBrainId: string,
    mergedBrainId: string,
  ): string {
    const input = `${brandId}||${canonicalBrainId}||${mergedBrainId}||${RULE_VERSION}`;
    const hex = createHash('sha256').update(input, 'utf8').digest('hex');
    // Format as UUID: take first 32 hex chars (128 bits), format as 8-4-4-4-12
    // Set version to 5 (name-based SHA-1 UUID — closest to deterministic SHA-256 UUID)
    const h = hex.slice(0, 32);
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      '5' + h.slice(13, 16),  // version 5
      ((parseInt(h[16]!, 16) & 0x3 | 0x8).toString(16)) + h.slice(17, 20),  // variant bits
      h.slice(20, 32),
    ].join('-');
  }

  /** Compute suppressed_until = now + windowDays. */
  private computeSuppressedUntil(now: Date, windowDays: number): Date {
    const until = new Date(now);
    until.setDate(until.getDate() + windowDays);
    return until;
  }
}
