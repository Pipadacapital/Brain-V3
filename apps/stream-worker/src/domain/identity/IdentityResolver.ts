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

// SPEC: A.1.5 — per-brand ORDERED identity priority (WA-12, mParticle-style IDSync).
//
// A "priority class" is a named precedence bucket in the per-brand ordered config; each class maps
// to one or more concrete identity_link identifier_types (AMD-02 names: platform_customer_id =
// storefront_customer_id; email covers its pre_hashed twin; phone covers its pre_hashed twin;
// anonymous_id = anon_id). Resolution walks the order highest→lowest: the highest-priority matching
// identifier wins; a LOWER-priority identifier matching a DIFFERENT brain_id is a conflict → routed
// to review (A.2.3), NEVER a silent overwrite/merge. Behind flag `identity.priority_config` — when
// no config is threaded in (flag OFF) resolve() runs the legacy fixed-tier union-find byte-identically.
export type IdentityPriorityClass =
  | 'platform_customer_id'
  | 'email'
  | 'phone'
  | 'anonymous_id';

/** The spec default order (A.1.5): platform id, then email, then phone, then anonymous id. */
export const DEFAULT_IDENTITY_PRIORITY: readonly IdentityPriorityClass[] = [
  'platform_customer_id',
  'email',
  'phone',
  'anonymous_id',
] as const;

/**
 * Priority-class → identity_link identifier_type(s). A class matches an existing link when ANY of
 * its types + the event hash + is_active line up. email/phone each subsume their connector
 * pre-hashed twin so the same person resolves identically whether the hash arrived salted
 * (first-party pixel) or pre-hashed (connector) — see AMD-01/AMD-02.
 */
const PRIORITY_CLASS_TO_TYPES: Record<IdentityPriorityClass, readonly string[]> = {
  platform_customer_id: ['storefront_customer_id'],
  email: ['email', 'pre_hashed_email'],
  phone: ['phone', 'pre_hashed_phone'],
  anonymous_id: ['anon_id'],
};

/** Per-brand versioned priority config (read from ops.brand_identity_priority; version 0 = default). */
export interface IdentityPriorityConfig {
  /** Monotonic per-brand config version. 0 = the implicit default (no stored row). */
  version: number;
  /** Ordered priority classes, highest precedence first. Empty ⇒ DEFAULT_IDENTITY_PRIORITY. */
  order: readonly IdentityPriorityClass[];
}

/** An identifier extracted from the Bronze event payload. */
export interface ExtractedIdentifier {
  // C2: device_id + anon_id (brain_anon_id) are RESOLUTION INPUTS in addition to the strong PII
  // identifiers. They are tier='medium' — see the resolve-only / never-merge gating in resolve().
  //
  // connector-pre-hashed-identity: 'pre_hashed_email' | 'pre_hashed_phone' are STRONG identifiers
  // contributed by connector mappers when the upstream provider already performed the hash. They
  // share the same tier as their PII counterparts but live in a distinct identifier_type namespace
  // so they never collide with salted first-party hashes in identity_link. The `preHashed` flag
  // tells the resolver and repository to SKIP re-hashing — the hash is already the final value.
  //
  // PROB weak signals: 'cookie_id' | 'ip' | 'device_fingerprint' | 'session_id' are tier='weak'
  // RESOLVE-ONLY signals consumed ONLY by the rule-based ProbabilisticMatcher. The resolver below
  // reads ONLY strong (merge) + medium (resolve-only adoption) tiers — weak identifiers are NEVER
  // consulted for either merge or adoption, so the deterministic union-find is unaffected by them.
  type: 'email' | 'phone' | 'storefront_customer_id' | 'device_id' | 'anon_id'
      | 'pre_hashed_email' | 'pre_hashed_phone'
      | 'cookie_id' | 'ip' | 'device_fingerprint' | 'session_id';
  hash: string;         // 64-hex SHA-256(salt ‖ normalized) for standard ids, or the ALREADY-HASHED value for pre_hashed_* ids
  tier: 'strong' | 'strong_on_link' | 'medium' | 'weak';
  confidence: 'high' | 'low';
  rawValue?: string;    // ONLY for contact_pii write — never stored in identity_link
  /**
   * True when the hash was supplied pre-computed by the upstream provider / connector mapper and
   * MUST NOT be re-hashed by the identity pipeline.
   *
   * When `preHashed === true`:
   *   - The resolver accepts the value as-is (validates it is 64-hex, then uses it directly).
   *   - No per-brand salt is applied (the upstream provider did not have the salt).
   *   - `rawValue` is always undefined (there is no plaintext PII to write to contact_pii).
   *   - The identifier_type in identity_link is 'pre_hashed_email' or 'pre_hashed_phone' so it
   *     occupies a distinct namespace from salted first-party hashes (no cross-path collision).
   */
  preHashed?: boolean;
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
  // SPEC: A.1.5 — the per-brand priority config version this outcome was resolved under. Present ONLY
  // when the ordered-priority path ran (flag `identity.priority_config` ON); undefined on the legacy
  // fixed-tier path so flag-OFF outcomes stay byte-identical. Stamped onto the identity_audit detail.
  priorityConfigVersion?: number;
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
   * @param priorityConfig     SPEC A.1.5 — OPTIONAL per-brand ordered priority config. When present
   *                           (flag `identity.priority_config` ON) resolution walks the brand's order
   *                           (highest-priority match wins; lower-priority conflict → review, never
   *                           silent overwrite). When ABSENT (flag OFF / not wired) the legacy
   *                           fixed-tier union-find below runs byte-identically (§0.5 default OFF).
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
    priorityConfig?: IdentityPriorityConfig,
    strongOwnedBrainIds?: Set<string>,   // SPEC A.2.3.4 — brains already owning a strong id (guard input)
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

    // SPEC: A.2.3.4 shared-device guard (active only when strongOwnedBrainIds is supplied — flag
    // identity.shared_device_guard ON). A medium (anon/device) signal may ADOPT a brain to continue an
    // anonymous session, but it must NEVER pull a NEW strong identifier on THIS event into a brain ALREADY
    // OWNED by a DIFFERENT strong identity — that is the shared_device_family merge (two family emails, one
    // device → wrongly one person). We suppress the medium adoption exactly when (a) this event carries a
    // strong id that matched no existing brain (a genuinely new person signal) and (b) the medium's brain is
    // already strong-owned. The new strong id then MINTs its own brain, and the shared medium stays with its
    // first owner. Guard inert when strongOwnedBrainIds is absent (flag OFF) → byte-identical legacy path.
    const matchedStrongHashes = new Set(
      eligibleStrongIds
        .filter((id) =>
          existingLinks.some(
            (l) => l.is_active && l.identifier_type === id.type && l.identifier_value === id.hash,
          ),
        )
        .map((id) => `${id.type}:${id.hash}`),
    );
    const hasUnmatchedNewStrong = eligibleStrongIds.some(
      (id) => !matchedStrongHashes.has(`${id.type}:${id.hash}`),
    );

    if (matchedBrainIds.size <= 1 && mediumIds.length > 0) {
      const mediumMatched = new Set<string>();
      for (const id of mediumIds) {
        for (const link of existingLinks) {
          if (link.identifier_type === id.type && link.identifier_value === id.hash && link.is_active) {
            // Shared-device guard: don't let this medium adopt a strong-owned brain when the event carries
            // its own NEW (unmatched) strong id — the new strong id defines a (possibly different) person.
            if (strongOwnedBrainIds?.has(link.brain_id) && hasUnmatchedNewStrong) continue;
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

    // ── 4b. SPEC A.1.5 — per-brand ORDERED priority path (flag ON) ────────────
    // When a versioned priority config is threaded in, resolution is decided by the brand's ordered
    // precedence instead of the tier-symmetric union-find above: the highest-priority matching class
    // wins, and any lower-priority class matching a DIFFERENT brain_id routes to review rather than
    // silently overwriting/merging. The shared prep (phone-guard filter, contact_pii, mediumIds) is
    // reused; the legacy decision below is skipped. Flag OFF ⇒ this branch never runs ⇒ byte-identical.
    if (priorityConfig) {
      return this.resolveByPriority(
        eligibleStrongIds,
        identifiers,
        existingLinks,
        priorityConfig,
        phoneGuardUpdates,
        contactPiiWrites,
      );
    }

    if (matchedBrainIds.size === 0) {
      // MINT new brain_id
      const brainId = randomUUID();
      // SPEC A.2.3.4: under the shared-device guard, a medium (anon/device) identifier already ACTIVELY
      // owned by another brain must NOT be re-linked onto this freshly minted brain — the shared device
      // stays with its first owner; only the strong id(s) (+ unowned mediums) found the new person. Without
      // the guard (strongOwnedBrainIds absent) every identifier links to the mint (byte-identical legacy).
      const ownedElsewhere = strongOwnedBrainIds
        ? new Set(
            existingLinks
              .filter((l) => l.is_active)
              .map((l) => `${l.identifier_type}:${l.identifier_value}`),
          )
        : new Set<string>();
      const newLinks = identifiers.filter(
        (id) => !(id.tier === 'medium' && ownedElsewhere.has(`${id.type}:${id.hash}`)),
      );
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: brainId }));
      return {
        action: 'minted',
        brainId,
        newLinks,  // all identifiers (minus shared-device mediums owned elsewhere) go to the new customer
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
   * SPEC: A.1.5 — resolve by the brand's ORDERED identity priority (flag `identity.priority_config`).
   *
   * Semantics (mParticle IDSync-style):
   *   • Walk the brand's priority order highest→lowest. Each priority CLASS maps to identifier
   *     types (PRIORITY_CLASS_TO_TYPES). The FIRST class (in order) with any active-link match is the
   *     WINNER; its brain_id is the resolution.
   *   • A lower-priority class matching a DIFFERENT brain_id is a CONFLICT → routeToReview=true with
   *     action='skipped' and NO new links written — the higher-priority winner is NEVER silently
   *     overwritten/merged (A.2.3 disambiguation). The outcome brain_id is the winner (a stable anchor).
   *   • Top-tier ambiguity (the winning class itself matches ≥2 distinct people) also routes to review;
   *     the anchor is the deterministic lowest-UUID so the outcome stays replay-stable.
   *   • No match anywhere → MINT (this event founds a new brain_id).
   *   • All classes agree on a single brain_id → LINK the event's new identifiers to it.
   *
   * candidates = phone-guard-filtered strong ids (eligibleStrongIds) ∪ medium ids (anon_id). Weak
   * ids are never consulted (consistent with the legacy path). The config version is stamped on the
   * outcome (`priorityConfigVersion`) for audit.
   */
  private resolveByPriority(
    eligibleStrongIds: ExtractedIdentifier[],
    identifiers: ExtractedIdentifier[],
    existingLinks: ExistingLink[],
    priorityConfig: IdentityPriorityConfig,
    phoneGuardUpdates: ResolveOutcome['phoneGuardUpdates'],
    contactPiiWrites: ResolveOutcome['contactPiiWrites'],
  ): ResolveOutcome {
    const version = priorityConfig.version;
    const order =
      priorityConfig.order.length > 0 ? priorityConfig.order : DEFAULT_IDENTITY_PRIORITY;

    // Candidate identifiers: strong (phone-guard-filtered) + medium (anon_id). Medium ids gain a
    // priority class here (anonymous_id, lowest by default) so a shared-device conflict against a
    // higher-priority strong identifier surfaces as review instead of being silently dropped.
    const mediumIds = identifiers.filter((i) => i.tier === 'medium');
    const candidateIds = [...eligibleStrongIds, ...mediumIds];

    // For each priority class, the distinct brain_ids its identifier types actively match.
    const classMatches = new Map<IdentityPriorityClass, Set<string>>();
    for (const cls of order) {
      const types = PRIORITY_CLASS_TO_TYPES[cls] ?? [];
      const bids = new Set<string>();
      for (const id of candidateIds) {
        if (!types.includes(id.type)) continue;
        for (const link of existingLinks) {
          if (
            link.identifier_type === id.type &&
            link.identifier_value === id.hash &&
            link.is_active
          ) {
            bids.add(link.brain_id);
          }
        }
      }
      if (bids.size > 0) classMatches.set(cls, bids);
    }

    // No class matched any existing customer → MINT a new brain_id (this event founds it).
    if (classMatches.size === 0) {
      const brainId = randomUUID();
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: brainId }));
      return {
        action: 'minted',
        brainId,
        newLinks: identifiers,
        phoneGuardUpdates,
        routeToReview: false,
        contactPiiWrites: filled,
        priorityConfigVersion: version,
      };
    }

    // The highest-priority class (first in order) that matched anything is the winner.
    let winnerClass: IdentityPriorityClass | undefined;
    for (const cls of order) {
      if (classMatches.has(cls)) {
        winnerClass = cls;
        break;
      }
    }
    const winnerBids = classMatches.get(winnerClass!)!;

    // Top-tier ambiguity: the winning class itself resolves to ≥2 distinct people (e.g. the same
    // storefront id shared by two brain_ids). Never silent-overwrite → review; anchor lowest-UUID.
    if (winnerBids.size > 1) {
      const anchor = [...winnerBids].sort()[0]!;
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: anchor }));
      return {
        action: 'skipped',
        brainId: anchor,
        newLinks: [],
        phoneGuardUpdates,
        routeToReview: true,
        reviewReason: `priority-conflict: highest-priority class '${winnerClass}' matched ${winnerBids.size} distinct brain_ids (config v${version})`,
        contactPiiWrites: filled,
        priorityConfigVersion: version,
      };
    }

    const winner = [...winnerBids][0]!;

    // Any LOWER-priority class matching a DIFFERENT brain_id → conflict (never silent overwrite).
    // (Every class in classMatches other than the winner is lower-priority: the winner is the first
    // matching class in the order.)
    const conflictingClasses: string[] = [];
    for (const [cls, bids] of classMatches) {
      if (cls === winnerClass) continue;
      if ([...bids].some((b) => b !== winner)) conflictingClasses.push(cls);
    }

    if (conflictingClasses.length > 0) {
      const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: winner }));
      return {
        action: 'skipped',
        brainId: winner,
        newLinks: [],
        phoneGuardUpdates,
        routeToReview: true,
        reviewReason: `priority-conflict: lower-priority class(es) [${conflictingClasses.join(', ')}] matched a different brain_id than the '${winnerClass}' winner (config v${version}) — routed to review, NOT overwritten`,
        contactPiiWrites: filled,
        priorityConfigVersion: version,
      };
    }

    // Consensus on a single brain_id → LINK the event's not-yet-linked identifiers to the winner.
    const existingHashes = new Set(
      existingLinks
        .filter((l) => l.brain_id === winner && l.is_active)
        .map((l) => `${l.identifier_type}:${l.identifier_value}`),
    );
    const newLinks = identifiers.filter((id) => !existingHashes.has(`${id.type}:${id.hash}`));
    const filled = contactPiiWrites.map((p) => ({ ...p, brain_id: winner }));
    return {
      action: 'linked',
      brainId: winner,
      newLinks,
      phoneGuardUpdates,
      routeToReview: false,
      contactPiiWrites: filled,
      priorityConfigVersion: version,
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
