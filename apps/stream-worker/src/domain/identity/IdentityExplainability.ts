/**
 * IdentityExplainability — assemble a human- AND LLM-readable explanation of WHY an identity
 * decision was made (most importantly: why two profiles MERGED, or why one was SPLIT back out).
 *
 * Pure, read-only DOMAIN assembly — no IO. It cites the evidence the engine already recorded: the
 * exact hash-only `identifier_combo`, the `matcher_id` (+ version), the `rule_version`, and the
 * integer `ConfidenceVerdict` (score + band + reason codes). Inputs are the reversible
 * `IdentityDecision` (which embeds its verdict) and, when available, the richer `DecisionEvidence`
 * from the EvidenceStore (which round-trips the structured combo + gating thresholds). Nothing here
 * re-derives a decision — it only EXPLAINS one that was already issued.
 *
 * HASH-ONLY (I-S02): identifiers are cited by TYPE + a 12-hex hash prefix; never raw PII.
 * CONFIDENCE IS AN INTEGER 0-100 — never money, never blended. The narrative never invents a score:
 * if neither the decision nor the evidence carries a verdict, confidence is reported as `unknown`.
 */
import type {
  ConfidenceBand,
  ConfidenceVerdict,
  IdentifierComboMember,
  IdentityCommand,
  IdentityDecision,
} from '@brain/contracts';
import type { DecisionEvidence } from './decisions/EvidenceStore.js';

/** The structured, machine/LLM-readable citation block behind an explanation. */
export interface ExplanationCitations {
  matcher_id: string | null;
  matcher_version: string | null;
  rule_version: string;
  merge_id: string | null;
  canonical_brain_id: string | null;
  merged_brain_id: string | null;
  /** UNITLESS confidence integer in [0,100], or null when no verdict was recorded. */
  confidence_score: number | null;
  confidence_band: ConfidenceBand | null;
  /** Matcher reason codes / signals — the append-only audit of WHY. Never raw PII. */
  reasons: string[];
  /** The exact hash-only identifier combination that produced the decision. */
  identifier_combo: IdentifierComboMember[];
  /** The gating thresholds the engine evaluated (integer counts/days — never money). */
  thresholds: Record<string, number>;
}

/** A complete identity-decision explanation: a one-line headline, a narrative, and the citations. */
export interface IdentityExplanation {
  brand_id: string;
  command: IdentityCommand;
  decision_id: string | null;
  /** One-line human summary. */
  headline: string;
  /** Multi-sentence human- AND LLM-readable explanation, citing the evidence inline. */
  narrative: string;
  citations: ExplanationCitations;
}

/** First 12 hex chars of a salted hash — an opaque, hash-only display reference (never raw PII). */
function hashPrefix(hash: string): string {
  return hash.slice(0, 12);
}

/** "email (a1b2c3d4e5f6), phone (0f1e2d3c4b5a)" — a hash-only, readable description of the combo. */
function describeCombo(combo: IdentifierComboMember[]): string {
  if (combo.length === 0) return 'no recorded identifier evidence';
  return combo.map((m) => `${m.identifier_type} (${hashPrefix(m.identifier_hash)}…)`).join(', ');
}

/** The verdict embedded on the commands that carry one (mint / link / merge / route_to_review). */
function verdictOf(decision: IdentityDecision): ConfidenceVerdict | null {
  return 'verdict' in decision ? decision.verdict : null;
}

/** "100/100 (exact)" or "confidence unknown" — never fabricates a score. */
function describeConfidence(score: number | null, band: ConfidenceBand | null): string {
  if (score == null) return 'confidence unknown (no verdict recorded for this decision)';
  return `${score}/100${band ? ` (${band})` : ''}`;
}

/**
 * Assemble the explanation for any issued IdentityDecision. Evidence (when supplied) is the
 * canonical source for the combo / matcher / score / thresholds; otherwise the decision's embedded
 * verdict is used. Deterministic: same inputs → same explanation.
 */
export function explainIdentityDecision(
  decision: IdentityDecision,
  evidence?: DecisionEvidence | null,
): IdentityExplanation {
  const verdict = verdictOf(decision);
  const combo = evidence?.identifier_combo ?? verdict?.identifier_combo ?? [];
  const score = evidence?.score ?? verdict?.score ?? null;
  const band = (evidence?.band ?? verdict?.band ?? null) as ConfidenceBand | null;
  const reasons = evidence?.signals ?? verdict?.reasons ?? [];
  const matcher_id = evidence?.matcher_id ?? verdict?.matcher_id ?? null;
  const matcher_version = evidence?.matcher_version ?? null;

  const citations: ExplanationCitations = {
    matcher_id,
    matcher_version,
    rule_version: decision.rule_version,
    merge_id: decision.command === 'merge' || decision.command === 'unmerge' ? decision.merge_id : null,
    canonical_brain_id:
      decision.command === 'merge' || decision.command === 'unmerge' ? decision.canonical_brain_id : null,
    merged_brain_id:
      decision.command === 'merge' || decision.command === 'unmerge' ? decision.merged_brain_id : null,
    confidence_score: score,
    confidence_band: band,
    reasons: [...reasons],
    identifier_combo: combo.map((m) => ({ ...m })),
    thresholds: { ...(evidence?.thresholds ?? {}) },
  };

  const matcherCite = matcher_id
    ? `${matcher_id}${matcher_version ? ` v${matcher_version}` : ''}`
    : 'the deterministic matcher';
  const conf = describeConfidence(score, band);

  let headline: string;
  let narrative: string;

  switch (decision.command) {
    case 'merge':
      headline = `Merged profile ${decision.merged_brain_id} into ${decision.canonical_brain_id} — confidence ${conf}.`;
      narrative =
        `Profiles ${decision.canonical_brain_id} and ${decision.merged_brain_id} were merged because ` +
        `${matcherCite} found they shared the same strong identifier(s): ${describeCombo(combo)}. ` +
        `The canonical survivor is ${decision.canonical_brain_id} (the lexicographically lowest brain_id — ` +
        `deterministic). Confidence ${conf} under rule ${decision.rule_version}` +
        `${reasons.length ? `; signals: ${reasons.join(', ')}` : ''}. ` +
        `merge_id ${decision.merge_id} — reversible via its unmerge compensation.`;
      break;
    case 'unmerge':
      headline = `Split profile ${decision.merged_brain_id} back out of ${decision.canonical_brain_id}.`;
      narrative =
        `The earlier merge ${decision.merge_id} of ${decision.merged_brain_id} into ` +
        `${decision.canonical_brain_id} was reversed (unmerge) under rule ${decision.rule_version}. ` +
        `Reason: ${decision.reason}. The two identities are now independent again` +
        `${combo.length ? `; the original merge had cited: ${describeCombo(combo)}` : ''}.`;
      break;
    case 'mint':
      headline = `Minted new identity ${decision.brain_id} — confidence ${conf}.`;
      narrative =
        `A new brain_id ${decision.brain_id} was minted because no existing profile matched the ` +
        `event's strong identifiers (${describeCombo(combo)}). Rule ${decision.rule_version}; ` +
        `confidence ${conf}${reasons.length ? `; signals: ${reasons.join(', ')}` : ''}.`;
      break;
    case 'link':
      headline = `Linked identifier(s) to existing identity ${decision.brain_id} — confidence ${conf}.`;
      narrative =
        `The event's identifier(s) (${describeCombo(combo)}) resolved to the existing profile ` +
        `${decision.brain_id} via ${matcherCite}, so they were linked rather than minting a new ` +
        `identity. Rule ${decision.rule_version}; confidence ${conf}` +
        `${reasons.length ? `; signals: ${reasons.join(', ')}` : ''}.`;
      break;
    case 'suppress':
      headline = `Suppressed shared identifier ${decision.identifier_type} (${hashPrefix(decision.identifier_hash)}…).`;
      narrative =
        `The ${decision.identifier_type} identifier (${hashPrefix(decision.identifier_hash)}…) was ` +
        `suppressed as a merge key until ${decision.suppressed_until}. Reason: ${decision.reason} ` +
        `(phone-guard, D-1)${thresholdSummary(citations.thresholds)}. Reversible via lift_suppression.`;
      break;
    case 'route_to_review':
      headline = `Routed ${decision.brain_id_a} ↔ ${decision.brain_id_b} to human review.`;
      narrative =
        `A probable association between ${decision.brain_id_a} and ${decision.brain_id_b} was NOT ` +
        `auto-committed — it was queued for human review (review_id ${decision.review_id}). ` +
        `Reason: ${decision.reason}. Evidence: ${describeCombo(combo)}; confidence ${conf} under ` +
        `rule ${decision.rule_version}${reasons.length ? `; signals: ${reasons.join(', ')}` : ''}.`;
      break;
    default: {
      // Exhaustiveness guard: IdentityCommand is a closed union; a new command must be handled here.
      const _exhaustive: never = decision;
      void _exhaustive;
      headline = 'Identity decision.';
      narrative = 'No explanation template for this command.';
    }
  }

  return {
    brand_id: decision.brand_id,
    command: decision.command,
    decision_id: evidence?.decision_id ?? null,
    headline,
    narrative,
    citations,
  };
}

/** Explain a MERGE specifically (asserts the command — for the "why did these merge?" surface). */
export function explainMerge(
  decision: Extract<IdentityDecision, { command: 'merge' }>,
  evidence?: DecisionEvidence | null,
): IdentityExplanation {
  return explainIdentityDecision(decision, evidence);
}

/** Explain a SPLIT/unmerge specifically (the "why were these separated?" surface). */
export function explainSplit(
  decision: Extract<IdentityDecision, { command: 'unmerge' }>,
  evidence?: DecisionEvidence | null,
): IdentityExplanation {
  return explainIdentityDecision(decision, evidence);
}

function thresholdSummary(thresholds: Record<string, number>): string {
  const keys = Object.keys(thresholds);
  if (keys.length === 0) return '';
  return ` [thresholds: ${keys.map((k) => `${k}=${thresholds[k]}`).join(', ')}]`;
}
