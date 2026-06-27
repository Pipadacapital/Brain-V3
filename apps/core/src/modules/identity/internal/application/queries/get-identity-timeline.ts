/**
 * getIdentityTimeline — identity control-plane read use-case: a brain_id's decision history.
 *
 * Customer 360 (get-customer-360) shows a customer's CURRENT identity state; this shows HOW it got
 * there — the chronological log of mint / link / merge / unmerge / rebind / erase decisions with
 * their rule_version + evidence references, read from the immutable identity_audit ledger via the
 * IdentityTimelineReader port (DIP). brand_id is supplied by the caller (BFF, from the session JWT) —
 * NEVER the request body. Hash-only (I-S02): entries carry identifier TYPES + references, never raw PII.
 */
import type { IdentityTimelineReader } from '../../infrastructure/identity-timeline-reader.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(v: Date | null): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

export interface IdentityTimelineEntry {
  /** 0-based chronological position. */
  sequence: number;
  /** The decision kind: mint | link | merge | unmerge | rebind | erase | … */
  action: string;
  occurred_at: string | null;
  rule_version: string;
  merge_id: string | null;
  /** The other identity involved (merged side / review counterpart), when applicable. */
  related_brain_id: string | null;
  /** Identifier TYPES that participated (type-only, never raw PII). */
  identifier_types: string[];
  reason: string | null;
  /** Reference to the decision/evidence record, when recorded. */
  decision_id: string | null;
}

export type IdentityTimelineResult =
  | { state: 'invalid'; brain_id: string }
  | { state: 'found'; brain_id: string; entries: IdentityTimelineEntry[]; count: number };

export interface IdentityTimelineDeps {
  reader: IdentityTimelineReader;
}

export async function getIdentityTimeline(
  brandId: string,
  brainId: string,
  _correlationId: string,
  deps: IdentityTimelineDeps,
): Promise<IdentityTimelineResult> {
  if (!UUID_RE.test(brainId)) {
    return { state: 'invalid', brain_id: brainId };
  }

  const rows = await deps.reader.getIdentityTimeline(brandId, brainId);
  const entries: IdentityTimelineEntry[] = rows.map((r, i) => ({
    sequence: i,
    action: r.action,
    occurred_at: toIso(r.occurred_at),
    rule_version: r.rule_version,
    merge_id: r.merge_id,
    related_brain_id: r.related_brain_id,
    identifier_types: r.identifier_types,
    reason: r.reason,
    decision_id: r.decision_id,
  }));

  return { state: 'found', brain_id: brainId, entries, count: entries.length };
}
