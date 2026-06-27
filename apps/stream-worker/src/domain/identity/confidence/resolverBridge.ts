/**
 * resolverBridge.ts — the pure bridge that grades the EXISTING IdentityResolver's own decision.
 *
 * The Confidence Engine WRAPS/EXTENDS the resolver — it does not replace it. This module converts
 * the resolver's domain types (`ExtractedIdentifier`, `ExistingLink`, `ResolveOutcome`) into the
 * engine's `ConfidenceEvidence` and produces a `ConfidenceVerdict`, so a caller that already ran
 * `IdentityResolver.resolve(...)` can attach a versioned confidence verdict to that outcome with no
 * extra graph IO.
 *
 * Pure: the same active-link predicate the resolver uses (identifier_type + identifier_value(hash) +
 * is_active), tier-split into strong vs medium matches. Hash-only (I-S02), brand_id-first.
 */
import type { ConfidenceVerdict, Identifier } from '@brain/contracts';
import type {
  ExtractedIdentifier,
  ExistingLink,
  ResolveOutcome,
} from '../IdentityResolver.js';
import { ConfidenceEngine, type ConfidenceEvidence, type IdentifierMatch } from './ConfidenceEngine.js';

function isStrongTier(tier: ExtractedIdentifier['tier']): boolean {
  return tier === 'strong' || tier === 'strong_on_link';
}

/** Convert a resolver `ExtractedIdentifier` (+ the event's brand) into a contract `Identifier`. */
function toIdentifier(brandId: string, e: ExtractedIdentifier): Identifier {
  return {
    brand_id: brandId,
    identifier_type: e.type,
    identifier_hash: e.hash,
    tier: e.tier,
  };
}

/**
 * Build `ConfidenceEvidence` from the resolver's inputs/outcome. The strong/medium matches are
 * derived with the SAME predicate `IdentityResolver.resolve` uses, so the verdict grades exactly the
 * evidence the resolver decided on. `routeToReview` is carried through so a cycle-guard outcome caps
 * the verdict below 'exact'.
 */
export function evidenceFromResolver(args: {
  brand_id: string;
  identifiers: readonly ExtractedIdentifier[];
  existingLinks: readonly ExistingLink[];
  outcome?: ResolveOutcome;
}): ConfidenceEvidence {
  const identifiers: Identifier[] = args.identifiers.map((e) => toIdentifier(args.brand_id, e));
  const strongMatches: IdentifierMatch[] = [];
  const mediumMatches: IdentifierMatch[] = [];

  for (const e of args.identifiers) {
    const idf = toIdentifier(args.brand_id, e);
    for (const l of args.existingLinks) {
      if (l.is_active && l.identifier_type === e.type && l.identifier_value === e.hash) {
        const match: IdentifierMatch = { identifier: idf, brain_id: l.brain_id };
        if (isStrongTier(e.tier)) strongMatches.push(match);
        else if (e.tier === 'medium') mediumMatches.push(match);
      }
    }
  }

  return {
    brand_id: args.brand_id,
    identifiers,
    strongMatches,
    mediumMatches,
    routeToReview: args.outcome?.routeToReview,
    routeReason: args.outcome?.reviewReason,
  };
}

/**
 * Grade a resolver decision: derive the evidence and return the engine's ConfidenceVerdict.
 * Convenience over `engine.assess(evidenceFromResolver(...))`.
 */
export function gradeResolverOutcome(
  engine: ConfidenceEngine,
  args: {
    brand_id: string;
    identifiers: readonly ExtractedIdentifier[];
    existingLinks: readonly ExistingLink[];
    outcome?: ResolveOutcome;
  },
): ConfidenceVerdict {
  return engine.assess(evidenceFromResolver(args));
}
