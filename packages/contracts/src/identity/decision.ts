/**
 * identity/decision.ts — IdentityDecision: the reversible-Command union the resolver emits
 * and the IdentityGraphRepository applies to the identity graph (Neo4j SoR).
 *
 * Every command is REVERSIBLE: it carries an explicit `compensation` descriptor naming its
 * inverse and the minimal payload to undo it. This is the saga/compensation discipline —
 * "prefer small, reversible, auditable changes" — so any mis-stitch can be wound back
 * (Unmerge undoes Merge, Unlink undoes Link, a tombstone undoes a Mint, …) deterministically.
 *
 * The command set maps 1:1 onto the resolver's `ResolveAction` (IdentityResolver.ts) plus the
 * admin Unmerge:
 *   minted   → Mint            ('mint')
 *   linked   → Link            ('link')
 *   merged   → Merge           ('merge')
 *   suppressed → Suppress      ('suppress')   (phone-guard, D-1)
 *   skipped+routeToReview → RouteToReview ('route_to_review')  (cycle-guard / conflict)
 *   (admin)  → Unmerge         ('unmerge')    (the reverse of a committed Merge; UnmergeResult)
 *
 * HASH-ONLY (I-S02), TENANT-SCOPED (brand_id-first), NO MONEY. brain_id/merge_id are UUIDs.
 */
import { z } from 'zod';
import { IdentifierSchema, IdentifierHashSchema, IdentifierTypeSchema } from './identifier.js';
import { ConfidenceVerdictSchema } from './confidence-verdict.js';

// ── Compensation (inverse) descriptors ───────────────────────────────────────

/**
 * The kind of compensating action that reverses a command. Each IdentityDecision carries
 * exactly one, sufficient to undo the forward effect on the graph.
 */
export const CompensationKindSchema = z.enum([
  'tombstone_brain_id', // inverse of Mint    — tombstone the freshly-minted brain_id
  'unlink_identifiers', // inverse of Link    — detach the just-attached identifiers
  'unmerge',            // inverse of Merge   — split merged_brain_id back out of canonical
  'remerge',            // inverse of Unmerge — re-fold a split brain_id back in
  'lift_suppression',   // inverse of Suppress— lift a phone-guard suppression
  'withdraw_review',    // inverse of RouteToReview — withdraw the queued review item
]);
export type CompensationKind = z.infer<typeof CompensationKindSchema>;

const TombstoneCompensationSchema = z.object({
  kind: z.literal('tombstone_brain_id'),
  brain_id: z.string().uuid(),
});
const UnlinkCompensationSchema = z.object({
  kind: z.literal('unlink_identifiers'),
  brain_id: z.string().uuid(),
  identifier_hashes: z.array(IdentifierHashSchema),
});
const UnmergeCompensationSchema = z.object({
  kind: z.literal('unmerge'),
  merge_id: z.string().uuid(),
  canonical_brain_id: z.string().uuid(),
  merged_brain_id: z.string().uuid(),
});
const RemergeCompensationSchema = z.object({
  kind: z.literal('remerge'),
  merge_id: z.string().uuid(),
  canonical_brain_id: z.string().uuid(),
  merged_brain_id: z.string().uuid(),
});
const LiftSuppressionCompensationSchema = z.object({
  kind: z.literal('lift_suppression'),
  identifier_type: IdentifierTypeSchema,
  identifier_hash: IdentifierHashSchema,
});
const WithdrawReviewCompensationSchema = z.object({
  kind: z.literal('withdraw_review'),
  review_id: z.string(),
});

/** The full compensation union (discriminated on `kind`). */
export const CompensationSchema = z.discriminatedUnion('kind', [
  TombstoneCompensationSchema,
  UnlinkCompensationSchema,
  UnmergeCompensationSchema,
  RemergeCompensationSchema,
  LiftSuppressionCompensationSchema,
  WithdrawReviewCompensationSchema,
]);
export type Compensation = z.infer<typeof CompensationSchema>;

// ── The IdentityDecision command union (discriminated on `command`) ───────────

/** Mint a new brain_id (0 strong matches). Inverse: tombstone the minted brain_id. */
export const MintDecisionSchema = z.object({
  command: z.literal('mint'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(), // ISO-8601
  brain_id: z.string().uuid(),
  identifiers: z.array(IdentifierSchema),
  verdict: ConfidenceVerdictSchema,
  compensation: TombstoneCompensationSchema,
});
export type MintDecision = z.infer<typeof MintDecisionSchema>;

/** Link identifiers to an existing brain_id (1 strong match). Inverse: unlink them. */
export const LinkDecisionSchema = z.object({
  command: z.literal('link'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(),
  brain_id: z.string().uuid(),
  identifiers: z.array(IdentifierSchema),
  verdict: ConfidenceVerdictSchema,
  compensation: UnlinkCompensationSchema,
});
export type LinkDecision = z.infer<typeof LinkDecisionSchema>;

/** Merge merged_brain_id into canonical_brain_id (≥2 strong matches). Inverse: unmerge. */
export const MergeDecisionSchema = z.object({
  command: z.literal('merge'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(),
  /** Deterministic merge_id = sha256(brand_id ‖ canonical ‖ merged ‖ rule_version) (D-4). */
  merge_id: z.string().uuid(),
  /** Canonical survivor = lowest UUID (deterministic). */
  canonical_brain_id: z.string().uuid(),
  merged_brain_id: z.string().uuid(),
  verdict: ConfidenceVerdictSchema,
  compensation: UnmergeCompensationSchema,
});
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;

/** Unmerge a previously-committed merge (admin reverse). Inverse: remerge. */
export const UnmergeDecisionSchema = z.object({
  command: z.literal('unmerge'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(),
  merge_id: z.string().uuid(),
  canonical_brain_id: z.string().uuid(),
  merged_brain_id: z.string().uuid(),
  /** Why the unmerge was requested (audit). */
  reason: z.string(),
  compensation: RemergeCompensationSchema,
});
export type UnmergeDecision = z.infer<typeof UnmergeDecisionSchema>;

/** Suppress a shared/abusive identifier (phone-guard, D-1). Inverse: lift suppression. */
export const SuppressDecisionSchema = z.object({
  command: z.literal('suppress'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(),
  identifier_type: IdentifierTypeSchema,
  identifier_hash: IdentifierHashSchema,
  /** ISO-8601 instant the suppression lifts (now + suppression_window_days). */
  suppressed_until: z.string(),
  /** Why suppressed (e.g. 'phone_guard:threshold_exceeded'). */
  reason: z.string(),
  compensation: LiftSuppressionCompensationSchema,
});
export type SuppressDecision = z.infer<typeof SuppressDecisionSchema>;

/** Route an ambiguous pair to the human review queue (cycle-guard / conflict). Inverse: withdraw. */
export const RouteToReviewDecisionSchema = z.object({
  command: z.literal('route_to_review'),
  brand_id: z.string().uuid(),
  rule_version: z.string().min(1),
  decided_at: z.string(),
  review_id: z.string(),
  brain_id_a: z.string().uuid(),
  brain_id_b: z.string().uuid(),
  /** Why routed (e.g. 'cycle-guard: alias chain collision'). */
  reason: z.string(),
  /** The (sub-threshold / conflicting) verdict that triggered the route. */
  verdict: ConfidenceVerdictSchema,
  compensation: WithdrawReviewCompensationSchema,
});
export type RouteToReviewDecision = z.infer<typeof RouteToReviewDecisionSchema>;

/**
 * IdentityDecision — the reversible-Command union. Discriminated on `command`; every
 * variant carries a matching `compensation` so the decision can be wound back.
 */
export const IdentityDecisionSchema = z.discriminatedUnion('command', [
  MintDecisionSchema,
  LinkDecisionSchema,
  MergeDecisionSchema,
  UnmergeDecisionSchema,
  SuppressDecisionSchema,
  RouteToReviewDecisionSchema,
]);
export type IdentityDecision = z.infer<typeof IdentityDecisionSchema>;

/** The discriminant literal set, for exhaustive switches. */
export const IdentityCommandSchema = z.enum([
  'mint',
  'link',
  'merge',
  'unmerge',
  'suppress',
  'route_to_review',
]);
export type IdentityCommand = z.infer<typeof IdentityCommandSchema>;
