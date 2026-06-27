/**
 * identity/confidence-verdict.ts — the ConfidenceVerdict: a matcher's graded judgement
 * that two (or more) identifier combinations belong to the same person.
 *
 * Mirrors the shape of `Customer360MergeSchema` (api/identity.api.v1.ts) — `rule_version`
 * + `identifier_combo[]` — but is the DECISION-TIME verdict (pre-commit) rather than the
 * post-commit read DTO. The resolver/matcher produces a ConfidenceVerdict; the committed
 * Customer360Merge is its durable projection.
 *
 * CONFIDENCE IS AN INTEGER 0–100 — NEVER MONEY, NEVER BLENDED WITH MONEY.
 *  - `score` is a UNITLESS integer in [0,100]. It is NOT minor-units, NOT a currency amount,
 *    and MUST NEVER be added to / mixed with a `MinorUnits` money value (those are bigint
 *    minor units + currency_code, a different domain entirely). "Confidence before decisions"
 *    — the score gates the decision; it is never a quantity of money.
 *  - Deterministic-first (D-5): the only enabled matcher emits exact verdicts (score 100,
 *    band 'exact'); the sub-100 bands exist for the deferred probabilistic/ML strategies,
 *    which are registered-DISABLED (see matcher.ts) and emit nothing until implemented.
 */
import { z } from 'zod';
import { IdentifierHashSchema, IdentifierTypeSchema } from './identifier.js';

/**
 * The confidence band — a coarse bucket over the integer `score`, for UI + gating.
 * `exact` is the deterministic strong-key match (score 100). The remaining bands are
 * reserved for the (currently disabled) probabilistic strategies.
 */
export const ConfidenceBandSchema = z.enum(['exact', 'high', 'medium', 'low', 'none']);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

/**
 * One element of `identifier_combo`: a hash-only descriptor of an identifier that
 * contributed to the verdict. Hash-only (I-S02) — never raw PII. Kept structured (rather
 * than the api DTO's free `string[]`) so a verdict is machine-auditable: which exact
 * identifier-types/hashes produced this judgement.
 */
export const IdentifierComboMemberSchema = z.object({
  identifier_type: IdentifierTypeSchema,
  identifier_hash: IdentifierHashSchema,
});
export type IdentifierComboMember = z.infer<typeof IdentifierComboMemberSchema>;

/**
 * ConfidenceVerdict — a matcher's graded judgement, with its evidence.
 *
 * `{ score (int 0-100), band, reasons[], matcher_id, rule_version, identifier_combo[] }`.
 */
export const ConfidenceVerdictSchema = z.object({
  /**
   * UNITLESS confidence integer in [0,100]. NEVER money, never blended with MinorUnits.
   * 100 = deterministic certainty; 0 = no evidence (mint a fresh identity).
   */
  score: z.number().int().min(0).max(100),
  /** Coarse band derived from `score` (exact|high|medium|low|none). */
  band: ConfidenceBandSchema,
  /**
   * Human-/machine-readable reason codes the matcher cites for this score
   * (e.g. 'strong_key:email', 'phone_guard:suppressed', 'cycle_guard:alias_loop').
   * Append-only audit of WHY — never raw PII.
   */
  reasons: z.array(z.string()),
  /** The matcher that produced this verdict (see IDENTITY_MATCHER_REGISTRY). */
  matcher_id: z.string().min(1),
  /** The rule version the verdict was produced under (mirrors IDENTITY_RULE_VERSION). */
  rule_version: z.string().min(1),
  /**
   * The exact identifier combination that produced the verdict — hash-only (I-S02).
   * Mirrors `Customer360Merge.identifier_combo` but structured per member.
   */
  identifier_combo: z.array(IdentifierComboMemberSchema),
});
export type ConfidenceVerdict = z.infer<typeof ConfidenceVerdictSchema>;
