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

import type { IdentityReader } from '../../infrastructure/neo4j-identity-reader.js';

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

/**
 * One order on a customer's profile (the Orders sub-tab, formerly count-only). Folded from the
 * Silver order-state mart (injected; identity stays store-agnostic). Money = SIGNED bigint MINOR
 * units as a string (I-S07) paired with currency_code — never a float, never blended.
 */
export interface Customer360Order {
  order_id: string;
  lifecycle_state: string;
  is_terminal: boolean;
  order_value_minor: string;
  currency_code: string | null;
  first_event_at: string | null;
  state_effective_at: string | null;
}

export type Customer360 =
  | { state: 'not_found'; brain_id: string }
  | {
      state: 'found';
      customer: Customer360Profile;
      identifiers: Customer360Identifier[];
      merges: Customer360Merge[];
      /** The customer's orders (latest state each, newest-first). Empty = no orders (or scores tier absent). */
      orders: Customer360Order[];
    };

export interface Customer360Deps {
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR (DIP — IdentityReader port). */
  reader: IdentityReader;
  /**
   * Per-customer order list resolver (injected; folds brain_serving.mv_silver_order_state). Absent →
   * orders is [] (honest-empty; the profile still resolves). Fail-soft on a serving hiccup.
   */
  ordersReader?: (brandId: string, brainId: string) => Promise<Customer360Order[]>;
}

export async function getCustomer360(
  brandId: string,
  brainId: string,
  _correlationId: string,
  deps: Customer360Deps,
): Promise<Customer360> {
  // Invalid brain_id can never match — fail closed as not_found.
  if (!UUID_RE.test(brainId)) {
    return { state: 'not_found', brain_id: brainId };
  }

  const r = await deps.reader.getCustomer360(brandId, brainId);
  if (r.customer === null) {
    return { state: 'not_found', brain_id: brainId };
  }
  const c = r.customer;

  // Per-customer order list (Orders sub-tab). Fail-soft: a serving hiccup degrades to [] — never a 500.
  const orders = deps.ordersReader
    ? await deps.ordersReader(brandId, brainId).catch(() => [] as Customer360Order[])
    : [];

  return {
    state: 'found',
    orders,
    customer: {
      brain_id: c.brain_id,
      anonymous_id: c.anonymous_id,
      merged_into: c.merged_into,
      lifecycle_state: c.lifecycle_state,
      ai_processing_consent: c.ai_processing_consent,
      resolution_consent: c.resolution_consent,
      created_at: toIso(c.created_at),
    },
    identifiers: r.identifiers.map((x) => ({
      identifier_type: x.identifier_type,
      tier: x.tier,
      is_active: x.is_active,
      created_at: toIso(x.created_at),
      identifier_hash_prefix: x.identifier_hash_prefix,
    })),
    merges: r.merges.map((x) => ({
      role: x.canonical_brain_id === brainId ? ('canonical' as const) : ('merged' as const),
      canonical_brain_id: x.canonical_brain_id,
      merged_brain_id: x.merged_brain_id,
      confidence: x.confidence,
      rule_version: x.rule_version,
      identifier_combo: x.identifier_combo,
      committed_at: toIso(x.committed_at),
    })),
  };
}
