/**
 * identity.api.v1 — Zod response contracts for the identity control-plane BFF read DTOs.
 *
 * THE SINGLE SOURCE OF TRUTH for these read shapes. Core's use-case return type and web's
 * consumer type BOTH derive from these schemas; the BFF annotates its handler result with
 * the z.infer type (compile-time guard) and web parses the envelope body with the schema at
 * the seam (runtime guard) — so a field rename/removal on either side fails loudly, not as a
 * deep undefined deref.
 *
 * PII discipline (I-S02): identifiers carry only the salted-hash PREFIX, never raw PII.
 */
import { z } from 'zod';

export const Customer360ProfileSchema = z.object({
  brain_id: z.string(),
  anonymous_id: z.string().nullable(),
  merged_into: z.string().nullable(),
  lifecycle_state: z.string(),
  ai_processing_consent: z.boolean(),
  resolution_consent: z.boolean(),
  created_at: z.string(), // ISO-8601
});
export type Customer360Profile = z.infer<typeof Customer360ProfileSchema>;

export const Customer360IdentifierSchema = z.object({
  identifier_type: z.string(),
  tier: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
  identifier_hash_prefix: z.string(), // first 12 hex chars — never raw PII
});
export type Customer360Identifier = z.infer<typeof Customer360IdentifierSchema>;

export const Customer360MergeSchema = z.object({
  role: z.enum(['canonical', 'merged']),
  canonical_brain_id: z.string(),
  merged_brain_id: z.string(),
  confidence: z.string(),
  rule_version: z.string(),
  identifier_combo: z.array(z.string()),
  committed_at: z.string(),
});
export type Customer360Merge = z.infer<typeof Customer360MergeSchema>;

// ── Merge/unmerge admin + review queue (P0-C) ────────────────────────────────

export const MergeReviewSchema = z.object({
  review_id: z.string(),
  brain_id_a: z.string(),
  brain_id_b: z.string(),
  trigger_reason: z.string(),
  created_at: z.string(),
});
export type MergeReview = z.infer<typeof MergeReviewSchema>;

export const MergeReviewListSchema = z.object({
  reviews: z.array(MergeReviewSchema),
});
export type MergeReviewList = z.infer<typeof MergeReviewListSchema>;

export const MergeResolveResultSchema = z.object({
  resolved: z.boolean(),
  decision: z.enum(['merged', 'rejected']).optional(),
  reason: z.string().optional(),
  canonical_brain_id: z.string().optional(),
  merged_brain_id: z.string().optional(),
});
export type MergeResolveResult = z.infer<typeof MergeResolveResultSchema>;

export const UnmergeResultSchema = z.object({
  unmerged: z.boolean(),
  reason: z.string().optional(),
  brain_id: z.string().optional(),
});
export type UnmergeResult = z.infer<typeof UnmergeResultSchema>;

/** Result of a DPDP customer erasure — counts only, never raw PII (P0-C). */
export const ErasureResultSchema = z.object({
  erased: z.boolean(),
  contact_pii_deleted: z.number().int().nonnegative(),
  links_tombstoned: z.number().int().nonnegative(),
});
export type ErasureResult = z.infer<typeof ErasureResultSchema>;

/** PII vault coverage — counts only, never raw PII (P0-C slice 2). */
export const VaultCoverageSchema = z.object({
  resolved_customers: z.number().int().nonnegative(),
  vaulted_customers: z.number().int().nonnegative(),
  coverage_pct: z.number().int().min(0).max(100),
  email_count: z.number().int().nonnegative(),
  phone_count: z.number().int().nonnegative(),
});
export type VaultCoverage = z.infer<typeof VaultCoverageSchema>;

export const Customer360Schema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('not_found'),
    brain_id: z.string(),
  }),
  z.object({
    state: z.literal('found'),
    customer: Customer360ProfileSchema,
    identifiers: z.array(Customer360IdentifierSchema),
    merges: z.array(Customer360MergeSchema),
  }),
]);
export type Customer360 = z.infer<typeof Customer360Schema>;
