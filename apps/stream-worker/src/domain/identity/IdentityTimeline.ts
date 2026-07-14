/**
 * IdentityTimeline — the read-side projection over the identity DECISION LOG + identity_audit.
 *
 * A per-brain_id chronological history of the reversible Commands the identity engine issued
 * (mint / link / merge / unmerge / suppress / route_to_review) with their rule_version + evidence
 * references, assembled from the append-then-reference Decision Log (DecisionLogRepository, persisted
 * additively into the identity_audit compliance ledger) and the per-decision EvidenceStore.
 *
 * Pure DOMAIN projection — no infra imports. The engine-side caller that already holds a
 * `DecisionLogEntry` (+ optional `DecisionEvidence`) uses `timelineRecordFromDecision` so the
 * projected records never drift from the audit-sourced ones.
 *
 * HASH-ONLY (I-S02): records carry identifier TYPES + the structured hash-only `identifier_combo`,
 * never raw PII. CONFIDENCE IS AN INTEGER 0-100 — never money, never blended.
 */
import type { ConfidenceBand, IdentifierComboMember, IdentityCommand } from '@brain/contracts';
import type { DecisionLogEntry } from './decisions/DecisionLogRepository.js';
import type { DecisionEvidence } from './decisions/EvidenceStore.js';

/**
 * The timeline action set: the reversible IdentityCommand union plus the two legacy identity_audit
 * actions that predate the Decision Log (`rebind`, `erase`) so a historical row is never dropped.
 */
export type TimelineAction = IdentityCommand | 'rebind' | 'erase';

/**
 * One projected timeline record (hash-only). Buildable from BOTH a rich `DecisionLogEntry`
 * (+evidence) AND a bare identity_audit row — the common shape the projection sorts + sequences.
 */
export interface IdentityTimelineRecord {
  /** Tenant key (brand_id-first). */
  brand_id: string;
  /** The PRIMARY subject brain_id of this record (canonical side for a merge/unmerge). */
  brain_id: string;
  /** The OTHER brain_id involved (merged side / review counterpart), when applicable. */
  related_brain_id?: string | null;
  action: TimelineAction;
  /** ISO-8601 instant the decision was recorded (chronological sort key). */
  occurred_at: string;
  /** Resolution rule version the decision was issued under. */
  rule_version: string;
  /** Deterministic merge_id (merge / unmerge rows only). */
  merge_id?: string | null;
  /** Identifier TYPES that participated (e.g. ['email','phone']) — type-only, never raw PII. */
  identifier_types: string[];
  /** The exact hash-only identifier combination behind the decision (from the EvidenceStore). */
  identifier_combo: IdentifierComboMember[];
  /** The matcher that produced the verdict (IDENTITY_MATCHER_REGISTRY id), when known. */
  matcher_id?: string | null;
  /** UNITLESS confidence integer in [0,100] (never money), when known. */
  confidence_score?: number | null;
  confidence_band?: ConfidenceBand | null;
  /** Free-text reason (route_to_review / unmerge), when present. */
  reason?: string | null;
  /** The deterministic decision id (join key to the EvidenceStore), when known. */
  decision_id?: string | null;
  /** Reference to the evidence record (== decision_id), when known. */
  evidence_ref?: string | null;
}

/** A timeline record stamped with its position in the chronological history. */
export interface TimelineEntry extends IdentityTimelineRecord {
  /** 0-based position in the chronological order (stable). */
  sequence: number;
}

/** A brain_id's full chronological identity history. */
export interface IdentityTimeline {
  brand_id: string;
  brain_id: string;
  entries: TimelineEntry[];
  count: number;
}

/**
 * Pure projection: filter the records to the subject brain_id, sort chronologically (occurred_at
 * ascending, then decision_id for a stable tie-break), and stamp each with its sequence index.
 *
 * Deterministic: the same record set always yields the same ordered timeline. A record matches the
 * subject when it is the primary OR the related brain_id (so a merged-away identity still sees the
 * merge that absorbed it).
 */
export function buildIdentityTimeline(
  brandId: string,
  brainId: string,
  records: IdentityTimelineRecord[],
): IdentityTimeline {
  const relevant = records.filter(
    (r) => r.brand_id === brandId && (r.brain_id === brainId || r.related_brain_id === brainId),
  );

  relevant.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
    const ka = a.decision_id ?? '';
    const kb = b.decision_id ?? '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    // Final tie-break on action for a fully-stable order.
    return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
  });

  const entries: TimelineEntry[] = relevant.map((r, i) => ({ ...r, sequence: i }));
  return { brand_id: brandId, brain_id: brainId, entries, count: entries.length };
}

/**
 * Map a rich `DecisionLogEntry` (+ optional `DecisionEvidence`) to the common timeline record. The
 * engine-side path (which holds the issued IdentityDecision) uses this so the projection it produces
 * is byte-compatible with the identity_audit-sourced records the BFF reader returns.
 *
 * Confidence/identifier_combo are taken from the EvidenceStore when available (it round-trips the
 * structured combo), otherwise from the decision's embedded verdict.
 */
export function timelineRecordFromDecision(
  entry: DecisionLogEntry,
  evidence?: DecisionEvidence | null,
): IdentityTimelineRecord {
  const d = entry.decision;
  const base = {
    brand_id: d.brand_id,
    occurred_at: entry.recorded_at,
    rule_version: d.rule_version,
    decision_id: entry.decision_id,
    evidence_ref: entry.evidence_ref,
    identifier_combo: evidence?.identifier_combo ?? comboFromDecision(entry),
    matcher_id: evidence?.matcher_id ?? verdictOf(entry)?.matcher_id ?? null,
    confidence_score: evidence?.score ?? verdictOf(entry)?.score ?? null,
    confidence_band: evidence?.band ?? verdictOf(entry)?.band ?? null,
  };

  switch (d.command) {
    case 'mint':
      return { ...base, brain_id: d.brain_id, action: 'mint', identifier_types: d.identifiers.map((i) => i.identifier_type) };
    case 'link':
      return { ...base, brain_id: d.brain_id, action: 'link', identifier_types: d.identifiers.map((i) => i.identifier_type) };
    case 'merge':
      return {
        ...base, brain_id: d.canonical_brain_id, related_brain_id: d.merged_brain_id,
        action: 'merge', merge_id: d.merge_id, identifier_types: comboTypes(base.identifier_combo),
      };
    case 'unmerge':
      return {
        ...base, brain_id: d.canonical_brain_id, related_brain_id: d.merged_brain_id,
        action: 'unmerge', merge_id: d.merge_id, reason: d.reason, identifier_types: comboTypes(base.identifier_combo),
      };
    case 'suppress':
      return {
        ...base, brain_id: '', action: 'suppress', reason: d.reason,
        identifier_types: [d.identifier_type],
      };
    case 'route_to_review':
      return {
        ...base, brain_id: d.brain_id_a, related_brain_id: d.brain_id_b,
        action: 'route_to_review', reason: d.reason, identifier_types: comboTypes(base.identifier_combo),
      };
  }
}

/** The verdict embedded on the commands that carry one (mint/link/merge/route_to_review). */
function verdictOf(entry: DecisionLogEntry) {
  const d = entry.decision;
  return 'verdict' in d ? d.verdict : null;
}

/** Pull the structured identifier_combo from the decision's verdict (when it carries one). */
function comboFromDecision(entry: DecisionLogEntry): IdentifierComboMember[] {
  return verdictOf(entry)?.identifier_combo ?? [];
}

/** Distinct identifier TYPES present in a combo (for the type-only summary field). */
function comboTypes(combo: IdentifierComboMember[]): string[] {
  return [...new Set(combo.map((m) => m.identifier_type))];
}
