/**
 * DecisionEngine — turns the existing IdentityResolver's outcome into reversible IdentityDecision
 * Commands (Wave-1 contract) + builds the per-decision evidence.
 *
 * WRAPS, DOES NOT REBUILD, the IdentityResolver. The pure resolver (apps/stream-worker) still owns
 * the deterministic union-find / phone-guard / cycle-guard algorithm and emits a ResolveOutcome.
 * This engine is the thin DECISION layer on top: it consumes that outcome + the matcher's
 * ConfidenceVerdict + the graph read-state and ISSUES the contract-level reversible Command, each
 * carrying its explicit `compensation` (inverse) so the decision can be wound back deterministically.
 *
 * Mapping (ResolveOutcome.action → IdentityDecision.command):
 *   minted              → Mint           (inverse: tombstone_brain_id)
 *   linked              → Link           (inverse: unlink_identifiers)
 *   merged              → Merge           (inverse: unmerge)
 *   skipped+routeToReview → RouteToReview (inverse: withdraw_review)
 *   phoneGuardUpdates[].suppress → Suppress (inverse: lift_suppression)   [deriveSuppressions]
 *   (admin reverse of a committed Merge)  → Unmerge (inverse: remerge)    [unmerge()]
 *
 * Pure: no IO, no Postgres, no Kafka, no Neo4j. Deterministic (D-4/D-5): the same outcome+verdict
 * yields the same decision_id and the same compensation. HASH-ONLY (I-S02). NO MONEY — the verdict
 * `score` is an INTEGER 0-100, never blended with a MinorUnits value. @effort("deterministic").
 */
import { createHash } from 'node:crypto';
import type {
  Identifier,
  IdentifierType,
  IdentifierTier,
  ConfidenceVerdict,
  IdentityDecision,
  IdentityCommand,
  MintDecision,
  LinkDecision,
  MergeDecision,
  UnmergeDecision,
  SuppressDecision,
  RouteToReviewDecision,
  Compensation,
  CompensationKind,
} from '@brain/contracts';
import type { ResolveOutcome, ExtractedIdentifier } from '../IdentityResolver.js';
import type { DecisionEvidence } from './EvidenceStore.js';

/** All-zeros UUID sentinel for an identifier-scoped Suppress (no single brain_id subject). */
export const NIL_BRAIN_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The inverse compensation kind each Command MUST carry (the reversibility invariant). A decision
 * whose `compensation.kind` does not match this map is NOT reversible and is rejected.
 */
export const INVERSE_KIND: Record<IdentityCommand, CompensationKind> = {
  mint: 'tombstone_brain_id',
  link: 'unlink_identifiers',
  merge: 'unmerge',
  unmerge: 'remerge',
  suppress: 'lift_suppression',
  route_to_review: 'withdraw_review',
};

/** The decision context: the resolver outcome + verdict + the minimal envelope to stamp a Command. */
export interface DecisionContext {
  /** Tenant key (brand_id-first). */
  brand_id: string;
  /** Resolution rule version (mirrors IDENTITY_RULE_VERSION / IdentityResolver.RULE_VERSION). */
  rule_version: string;
  /** ISO-8601 instant the decision was made. */
  decided_at: string;
  /** The EXISTING IdentityResolver's outcome (wrapped, not rebuilt). */
  outcome: ResolveOutcome;
  /** The matcher's graded verdict (confidence integer + identifier_combo evidence). */
  verdict: ConfidenceVerdict;
  /**
   * The distinct strong-matched brain_ids the resolver considered (the merge candidates). Used to
   * name the RouteToReview pair (brain_id_a/brain_id_b). When omitted, falls back to the outcome's
   * single brain_id for both (mirrors the existing Neo4j MergeReview behaviour).
   */
  matchedBrainIds?: string[];
}

/** Admin-Unmerge input (the reverse of a previously-committed Merge). */
export interface UnmergeContext {
  brand_id: string;
  rule_version: string;
  decided_at: string;
  merge_id: string;
  canonical_brain_id: string;
  merged_brain_id: string;
  reason: string;
}

/** Options for evidence capture (matcher version + gating thresholds + record time). */
export interface EvidenceOptions {
  matcher_version?: string;
  thresholds?: Record<string, number>;
  recorded_at?: string;
}

export class DecisionEngine {
  /**
   * Issue the PRIMARY reversible Command for a ResolveOutcome (mint / link / merge / route_to_review).
   * Phone-guard suppressions are derived separately (deriveSuppressions) since one event can mint/link
   * AND suppress a shared phone in the same outcome.
   */
  decide(ctx: DecisionContext): IdentityDecision {
    const { outcome } = ctx;
    switch (outcome.action) {
      case 'minted':
        return this.mint(ctx);
      case 'linked':
        return this.link(ctx);
      case 'merged':
        return this.merge(ctx);
      case 'skipped':
        if (outcome.routeToReview) return this.routeToReview(ctx);
        throw new Error(
          `[DecisionEngine] 'skipped' outcome without routeToReview has no reversible Command`,
        );
      case 'suppressed':
        throw new Error(
          `[DecisionEngine] 'suppressed' is identifier-scoped — use deriveSuppressions(ctx)`,
        );
      default:
        throw new Error(`[DecisionEngine] unknown ResolveOutcome.action: ${String(outcome.action)}`);
    }
  }

  /**
   * Issue ALL reversible Commands implied by a ResolveOutcome: the primary command plus one Suppress
   * per phone-guard suppression. The single entry point the orchestration uses.
   */
  decideAll(ctx: DecisionContext): IdentityDecision[] {
    return [this.decide(ctx), ...this.deriveSuppressions(ctx)];
  }

  /** Mint (0 strong matches). Inverse: tombstone the freshly-minted brain_id. */
  private mint(ctx: DecisionContext): MintDecision {
    const brain_id = ctx.outcome.brainId;
    return {
      command: 'mint',
      brand_id: ctx.brand_id,
      rule_version: ctx.rule_version,
      decided_at: ctx.decided_at,
      brain_id,
      identifiers: ctx.outcome.newLinks.map((e) => toIdentifier(ctx.brand_id, e)),
      verdict: ctx.verdict,
      compensation: { kind: 'tombstone_brain_id', brain_id },
    };
  }

  /** Link (1 strong match). Inverse: unlink the just-attached identifiers. */
  private link(ctx: DecisionContext): LinkDecision {
    const brain_id = ctx.outcome.brainId;
    const identifiers = ctx.outcome.newLinks.map((e) => toIdentifier(ctx.brand_id, e));
    return {
      command: 'link',
      brand_id: ctx.brand_id,
      rule_version: ctx.rule_version,
      decided_at: ctx.decided_at,
      brain_id,
      identifiers,
      verdict: ctx.verdict,
      compensation: {
        kind: 'unlink_identifiers',
        brain_id,
        identifier_hashes: identifiers.map((i) => i.identifier_hash),
      },
    };
  }

  /** Merge (≥2 strong matches). Inverse: unmerge the merged brain_id back out. */
  private merge(ctx: DecisionContext): MergeDecision {
    if (!ctx.outcome.merge) {
      throw new Error(`[DecisionEngine] 'merged' outcome is missing its MergeSpec`);
    }
    const { canonicalBrainId, mergedBrainId, mergeId } = ctx.outcome.merge;
    return {
      command: 'merge',
      brand_id: ctx.brand_id,
      rule_version: ctx.rule_version,
      decided_at: ctx.decided_at,
      merge_id: mergeId,
      canonical_brain_id: canonicalBrainId,
      merged_brain_id: mergedBrainId,
      verdict: ctx.verdict,
      compensation: {
        kind: 'unmerge',
        merge_id: mergeId,
        canonical_brain_id: canonicalBrainId,
        merged_brain_id: mergedBrainId,
      },
    };
  }

  /** RouteToReview (cycle-guard / conflict). Inverse: withdraw the queued review item. */
  private routeToReview(ctx: DecisionContext): RouteToReviewDecision {
    const sorted = [...(ctx.matchedBrainIds ?? [ctx.outcome.brainId])].sort();
    const brain_id_a = sorted[0] ?? ctx.outcome.brainId;
    const brain_id_b = sorted[sorted.length - 1] ?? ctx.outcome.brainId;
    const review_id = deriveUuid(
      `${ctx.brand_id}|review|${brain_id_a}|${brain_id_b}|${ctx.rule_version}`,
    );
    return {
      command: 'route_to_review',
      brand_id: ctx.brand_id,
      rule_version: ctx.rule_version,
      decided_at: ctx.decided_at,
      review_id,
      brain_id_a,
      brain_id_b,
      reason: ctx.outcome.reviewReason ?? 'cycle-guard: alias chain collision',
      verdict: ctx.verdict,
      compensation: { kind: 'withdraw_review', review_id },
    };
  }

  /**
   * Derive one Suppress Command per phone-guard suppression in the outcome. Inverse: lift_suppression.
   * Only suppressions with a concrete `suppressed_until` are emitted (the others are observational).
   */
  deriveSuppressions(ctx: DecisionContext): SuppressDecision[] {
    const out: SuppressDecision[] = [];
    for (const u of ctx.outcome.phoneGuardUpdates) {
      if (!u.suppress || !u.suppressed_until) continue;
      const identifier_type = u.identifier_type as IdentifierType;
      const identifier_hash = u.identifier_value;
      out.push({
        command: 'suppress',
        brand_id: ctx.brand_id,
        rule_version: ctx.rule_version,
        decided_at: ctx.decided_at,
        identifier_type,
        identifier_hash,
        suppressed_until: u.suppressed_until.toISOString(),
        reason: 'phone_guard:threshold_exceeded',
        compensation: { kind: 'lift_suppression', identifier_type, identifier_hash },
      });
    }
    return out;
  }

  /** Admin Unmerge — the reverse of a committed Merge. Inverse: remerge. */
  unmerge(ctx: UnmergeContext): UnmergeDecision {
    return {
      command: 'unmerge',
      brand_id: ctx.brand_id,
      rule_version: ctx.rule_version,
      decided_at: ctx.decided_at,
      merge_id: ctx.merge_id,
      canonical_brain_id: ctx.canonical_brain_id,
      merged_brain_id: ctx.merged_brain_id,
      reason: ctx.reason,
      compensation: {
        kind: 'remerge',
        merge_id: ctx.merge_id,
        canonical_brain_id: ctx.canonical_brain_id,
        merged_brain_id: ctx.merged_brain_id,
      },
    };
  }

  /**
   * Build the per-decision evidence (keyed by the deterministic decision_id). Round-trips the
   * verdict's structured `identifier_combo` (which was previously lost as []) plus the gating
   * thresholds + matcher version, so the decision is fully auditable + reversible-with-context.
   */
  buildEvidence(
    decision: IdentityDecision,
    verdict: ConfidenceVerdict,
    opts: EvidenceOptions = {},
  ): DecisionEvidence {
    return {
      decision_id: DecisionEngine.decisionId(decision),
      brand_id: decision.brand_id,
      command: decision.command,
      rule_version: decision.rule_version,
      matcher_id: verdict.matcher_id,
      matcher_version: opts.matcher_version ?? verdict.rule_version,
      score: verdict.score,
      band: verdict.band,
      signals: [...verdict.reasons],
      // The exact identifier combination — copied so external mutation cannot corrupt the record.
      identifier_combo: verdict.identifier_combo.map((m) => ({ ...m })),
      thresholds: { ...(opts.thresholds ?? {}) },
      recorded_at: opts.recorded_at ?? decision.decided_at,
    };
  }

  /** Return a decision's embedded compensation (its inverse) after verifying reversibility. */
  compensationFor(decision: IdentityDecision): Compensation {
    this.assertReversible(decision);
    return decision.compensation;
  }

  /**
   * Assert a decision is reversible: its compensation.kind is the declared inverse for its command,
   * AND the compensation payload references the decision's own subject ids (so the inverse actually
   * targets the forward effect). Throws on any mismatch.
   */
  assertReversible(decision: IdentityDecision): void {
    const expected = INVERSE_KIND[decision.command];
    const comp = decision.compensation;
    if (comp.kind !== expected) {
      throw new Error(
        `[DecisionEngine] non-reversible decision: command '${decision.command}' must carry ` +
          `compensation '${expected}', got '${comp.kind}'`,
      );
    }
    // Cross-check the compensation targets the forward subject ids.
    if (decision.command === 'mint' && comp.kind === 'tombstone_brain_id') {
      ensure(comp.brain_id === decision.brain_id, 'mint/tombstone brain_id mismatch');
    } else if (decision.command === 'link' && comp.kind === 'unlink_identifiers') {
      ensure(comp.brain_id === decision.brain_id, 'link/unlink brain_id mismatch');
    } else if (decision.command === 'merge' && comp.kind === 'unmerge') {
      ensure(
        comp.merge_id === decision.merge_id &&
          comp.canonical_brain_id === decision.canonical_brain_id &&
          comp.merged_brain_id === decision.merged_brain_id,
        'merge/unmerge id mismatch',
      );
    } else if (decision.command === 'unmerge' && comp.kind === 'remerge') {
      ensure(
        comp.merge_id === decision.merge_id &&
          comp.canonical_brain_id === decision.canonical_brain_id &&
          comp.merged_brain_id === decision.merged_brain_id,
        'unmerge/remerge id mismatch',
      );
    } else if (decision.command === 'suppress' && comp.kind === 'lift_suppression') {
      ensure(
        comp.identifier_type === decision.identifier_type &&
          comp.identifier_hash === decision.identifier_hash,
        'suppress/lift identifier mismatch',
      );
    } else if (decision.command === 'route_to_review' && comp.kind === 'withdraw_review') {
      ensure(comp.review_id === decision.review_id, 'route_to_review/withdraw review_id mismatch');
    }
  }

  /**
   * The stable, deterministic decision id — the join key shared by the DecisionLog (evidence_ref)
   * and the EvidenceStore. Derived from the command's natural key so a replay of the same decision
   * resolves to the same id (idempotent ledger + evidence, D-4).
   */
  static decisionId(d: IdentityDecision): string {
    switch (d.command) {
      case 'mint':
        return deriveUuid(`${d.brand_id}|mint|${d.brain_id}|${d.rule_version}`);
      case 'link':
        return deriveUuid(
          `${d.brand_id}|link|${d.brain_id}|` +
            `${d.identifiers.map((i) => i.identifier_hash).slice().sort().join(',')}|${d.rule_version}`,
        );
      case 'merge':
        return d.merge_id; // already a deterministic UUID (D-4)
      case 'unmerge':
        return deriveUuid(`${d.brand_id}|unmerge|${d.merge_id}|${d.rule_version}`);
      case 'suppress':
        return deriveUuid(
          `${d.brand_id}|suppress|${d.identifier_type}|${d.identifier_hash}|${d.rule_version}`,
        );
      case 'route_to_review':
        return d.review_id; // already a deterministic UUID
    }
  }
}

/** Map an ExtractedIdentifier (resolver shape) → the hash-only contract Identifier value object. */
function toIdentifier(brandId: string, e: ExtractedIdentifier): Identifier {
  return {
    brand_id: brandId,
    identifier_type: e.type as IdentifierType,
    identifier_hash: e.hash,
    tier: e.tier as IdentifierTier,
  };
}

/**
 * Derive a deterministic UUID from an input string (same algorithm as
 * IdentityResolver.computeMergeId, D-4): UUID-format the first 128 bits of sha256(input), with
 * version-5 + RFC-4122 variant bits set. Same input → same UUID forever.
 */
function deriveUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

function ensure(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[DecisionEngine] non-reversible decision: ${msg}`);
}
