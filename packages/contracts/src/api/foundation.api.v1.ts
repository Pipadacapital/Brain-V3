/**
 * foundation.api.v1.ts — the Data Foundation Health readiness contract (P1).
 *
 * One verdict for "is this brand's data foundation ready?" — the spine's gate ("everything depends
 * on the data foundation; never reach empty/misleading experiences"). The web parses BFF responses
 * against this so a drift fails loudly at the seam. snake_case at the wire (API convention).
 */
import { z } from 'zod';

export const FoundationTierSchema = z.enum(['blocked', 'building', 'ready', 'healthy']);
export type FoundationTier = z.infer<typeof FoundationTierSchema>;

export const FoundationStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
});
export type FoundationStep = z.infer<typeof FoundationStepSchema>;

export const FoundationNextActionSchema = z.object({
  label: z.string(),
  href: z.string(),
});
export type FoundationNextAction = z.infer<typeof FoundationNextActionSchema>;

export const FoundationHealthSchema = z.object({
  /** blocked → building → ready → healthy (fail-closed; readiness never overstated). */
  tier: FoundationTierSchema,
  /** True when the foundation supports trusted analytics/decisions (tier ready|healthy). */
  ready: z.boolean(),
  /** The ordered progression checklist with done flags. */
  steps: z.array(FoundationStepSchema),
  /** What's still missing/degraded (human-readable). */
  gaps: z.array(z.string()),
  /** The single most important next step (null when nothing to do). */
  next_action: FoundationNextActionSchema.nullable(),
  /** A one-line honest headline for the surface. */
  headline: z.string(),
});
export type FoundationHealth = z.infer<typeof FoundationHealthSchema>;
