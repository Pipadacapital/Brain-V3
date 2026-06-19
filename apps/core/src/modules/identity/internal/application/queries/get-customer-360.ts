/**
 * getCustomer360 — identity control-plane read use-case (P0-C, slice 1).
 *
 * Given a brand + brain_id, returns the resolved customer profile: lifecycle + consent
 * state, the linked identifiers (HASHED — never raw PII, I-S02), and the merge history.
 *
 * Reads ONLY the identity-graph tables (customer, identity_link, identity_merge_event)
 * via @brain/db's DbPool, whose query() runs each statement in an RLS transaction under
 * the brain_app role (SET LOCAL ROLE + app.current_brand_id GUC). Tenant isolation is the
 * GUC/RLS guarantee; the explicit `WHERE brand_id = $1` is belt-and-suspenders.
 *
 * brand_id is supplied by the caller (BFF, from the session JWT) — NEVER the request body.
 * No metric-engine coupling: identity is its own bounded context (boundary discipline).
 */

import type { DbPool, QueryContext } from '@brain/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// ── Result shape (honest discriminated union — matches @brain/contracts Customer360) ──

export interface Customer360Profile {
  brain_id: string;
  anonymous_id: string | null;
  merged_into: string | null;
  lifecycle_state: string;
  ai_processing_consent: boolean;
  resolution_consent: boolean;
  created_at: string;
}

export interface Customer360Identifier {
  identifier_type: string;
  tier: string;
  is_active: boolean;
  created_at: string;
  /** First 12 hex chars of the salted hash — opaque reference, NEVER raw PII. */
  identifier_hash_prefix: string;
}

export interface Customer360Merge {
  role: 'canonical' | 'merged';
  canonical_brain_id: string;
  merged_brain_id: string;
  confidence: string;
  rule_version: string;
  identifier_combo: string[];
  committed_at: string;
}

export type Customer360 =
  | { state: 'not_found'; brain_id: string }
  | {
      state: 'found';
      customer: Customer360Profile;
      identifiers: Customer360Identifier[];
      merges: Customer360Merge[];
    };

export interface Customer360Deps {
  pool: DbPool;
}

export async function getCustomer360(
  brandId: string,
  brainId: string,
  correlationId: string,
  deps: Customer360Deps,
): Promise<Customer360> {
  // Invalid brain_id can never match a row — fail closed as not_found (avoids a pg
  // invalid-uuid error leaking through the parameterized query).
  if (!UUID_RE.test(brainId)) {
    return { state: 'not_found', brain_id: brainId };
  }

  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const customerRes = await client.query<{
      brain_id: string;
      anonymous_id: string | null;
      merged_into: string | null;
      lifecycle_state: string;
      ai_processing_consent: boolean;
      resolution_consent: boolean;
      created_at: Date;
    }>(
      ctx,
      `SELECT brain_id, anonymous_id, merged_into, lifecycle_state,
              ai_processing_consent, resolution_consent, created_at
         FROM customer
        WHERE brand_id = $1 AND brain_id = $2`,
      [brandId, brainId],
    );

    if (customerRes.rows.length === 0) {
      return { state: 'not_found', brain_id: brainId };
    }
    const c = customerRes.rows[0]!;

    const linksRes = await client.query<{
      identifier_type: string;
      tier: string;
      is_active: boolean;
      created_at: Date;
      identifier_hash_prefix: string;
    }>(
      ctx,
      `SELECT identifier_type, tier, is_active, created_at,
              left(identifier_value, 12) AS identifier_hash_prefix
         FROM identity_link
        WHERE brand_id = $1 AND brain_id = $2
        ORDER BY is_active DESC, identifier_type ASC, created_at ASC`,
      [brandId, brainId],
    );

    const mergesRes = await client.query<{
      canonical_brain_id: string;
      merged_brain_id: string;
      confidence: string;
      rule_version: string;
      identifier_combo: string[];
      committed_at: Date;
    }>(
      ctx,
      `SELECT canonical_brain_id, merged_brain_id, confidence, rule_version,
              identifier_combo, committed_at
         FROM identity_merge_event
        WHERE brand_id = $1 AND (canonical_brain_id = $2 OR merged_brain_id = $2)
        ORDER BY committed_at DESC`,
      [brandId, brainId],
    );

    return {
      state: 'found',
      customer: {
        brain_id: c.brain_id,
        anonymous_id: c.anonymous_id,
        merged_into: c.merged_into,
        lifecycle_state: c.lifecycle_state,
        ai_processing_consent: c.ai_processing_consent,
        resolution_consent: c.resolution_consent,
        created_at: toIso(c.created_at),
      },
      identifiers: linksRes.rows.map((r) => ({
        identifier_type: r.identifier_type,
        tier: r.tier,
        is_active: r.is_active,
        created_at: toIso(r.created_at),
        identifier_hash_prefix: r.identifier_hash_prefix,
      })),
      merges: mergesRes.rows.map((r) => ({
        role: r.canonical_brain_id === brainId ? 'canonical' : 'merged',
        canonical_brain_id: r.canonical_brain_id,
        merged_brain_id: r.merged_brain_id,
        confidence: r.confidence,
        rule_version: r.rule_version,
        identifier_combo: r.identifier_combo,
        committed_at: toIso(r.committed_at),
      })),
    };
  } finally {
    client.release();
  }
}
