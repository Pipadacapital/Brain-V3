/**
 * listCustomers — identity control-plane BROWSE use-case (the discover front-door).
 *
 * Customer 360 only resolves a known brain_id; this returns a paginated, filterable PAGE of customer
 * summaries for the active brand so an operator can FIND a customer (then drill into 360 / merge /
 * unmerge / erase). Reads ONLY the identity-graph via the customer_list_for_brand SECURITY INVOKER
 * seam (RLS-enforced under brain_app) — the explicit brand scope is the GUC, never the request body.
 *
 * PII discipline (I-S02): returns counts + lifecycle/consent only — no raw PII, not even hashed
 * identifier values. Search-by-email/phone is done by hashing the operator's term with the per-brand
 * salt (the SAME salt the resolver wrote with) and matching the salted hash; the raw term is hashed
 * in-process and never persisted or logged, and never reaches Postgres.
 */

import { hashIdentifier, resolveSaltHex } from '@brain/identity-core';
import type { IdentityReader } from '../../infrastructure/neo4j-identity-reader.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export interface CustomerListItem {
  brain_id: string;
  anonymous_id: string | null;
  lifecycle_state: string;
  merged_into: string | null;
  ai_processing_consent: boolean;
  resolution_consent: boolean;
  identifier_count: number;
  last_identifier_at: string | null;
  created_at: string;
  /**
   * Business (RFM/lifecycle) SEGMENT folded from gold_customer_scores at read time (VIP / loyal /
   * at_risk / churned / first_time_buyer / window_shopper / high_value / cart_abandoner). Null when the
   * customer has no score row yet — honest-empty per row, never a fabricated segment.
   */
  segment: string | null;
  /** Lifetime realized value in bigint MINOR units (string, BigInt-safe); paired with currency_code. Null = no money signal. */
  ltv_minor: string | null;
  /** Sibling currency for ltv_minor — never blended. Null when ltv_minor is null. */
  currency_code: string | null;
  /** Realized lifetime order count. Null when the customer has no score row yet. */
  order_count: number | null;
}

/** Per-row business-signal enrichment from the Gold scores mart (injected; store-agnostic). */
export interface CustomerScoreEnrichment {
  segment: string;
  ltvMinor: string;
  currencyCode: string | null;
  orderCount: number;
}

export interface CustomerList {
  items: CustomerListItem[];
  total: number;
  limit: number;
  offset: number;
  searched: boolean;
}

export interface ListCustomersParams {
  lifecycle?: string | null;
  /** Raw operator search term (email or phone). Hashed server-side; never stored. */
  search?: string | null;
  /**
   * Business-SEGMENT filter (a valid lifecycle segment value, e.g. 'VIP' / 'loyal' / 'at_risk' /
   * 'churned' / 'first_time_buyer' / 'window_shopper'). When set, the browse is restricted to the
   * brain_ids whose derived segment matches (resolved upstream from gold_customer_scores). null = no
   * segment filter.
   */
  segment?: string | null;
  /**
   * Acquisition-SOURCE drilldown filter (P3): a first-touch acquisition source (the
   * gold_customer_360.acquisition_source channel, e.g. 'google' / 'meta' / 'direct'). When set, the
   * browse is restricted to the brain_ids acquired via that source (resolved upstream from
   * gold_customer_360). Lets the UTM-source matrix link straight into the customers it acquired. null =
   * no acquisition-source filter.
   */
  acquisitionSource?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListCustomersDeps {
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR (DIP — IdentityReader port). */
  reader: IdentityReader;
  /**
   * Per-brand salt resolver (the single brandSaltSource: dev-derived / prod KMS-unwrapped from
   * brand_identity_salt). When present the search term is hashed with the SAME salt the brand's
   * identities were hashed with — so search works for runtime-created prod brands (no IDENTITY_SALT
   * env). Optional: absent (older callers / tests) → falls back to the dev resolveSaltHex.
   */
  saltFn?: (brandId: string) => Promise<string>;
  /**
   * Page enrichment: brain_ids → { segment, ltvMinor, currencyCode, orderCount } from gold_customer_scores
   * (injected; the use-case stays store-agnostic). Absent → rows carry null segment/LTV/order_count
   * (honest-empty; the working list is unchanged).
   */
  enrichScores?: (brandId: string, brainIds: string[]) => Promise<Map<string, CustomerScoreEnrichment>>;
  /**
   * Segment-membership resolver: the brain_ids whose derived lifecycle segment === `segment`. Absent →
   * the segment filter is ignored (the param is a no-op, never a hard-fail of a browse).
   */
  segmentMembers?: (brandId: string, segment: string) => Promise<string[]>;
  /**
   * Acquisition-source-membership resolver (P3 drilldown): the brain_ids whose
   * gold_customer_360.acquisition_source === `acquisitionSource`. Absent → the acquisition-source filter
   * is a no-op (never a hard-fail of a browse). When both this and segmentMembers resolve, the browse is
   * the INTERSECTION (the customers who match both the segment and the acquisition source).
   */
  acquisitionSourceMembers?: (brandId: string, acquisitionSource: string) => Promise<string[]>;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Turn an operator search term into the set of salted hashes it could match. An '@' means email; an
 * otherwise digit-dominant term means phone. We hash BOTH interpretations when ambiguous so a paste of
 * "9876543210" finds the phone link and "a@b.com" finds the email link — the seam matches ANY of them.
 */
function searchHashes(term: string, saltHex: string): string[] {
  const t = term.trim();
  if (t.length === 0) return [];
  const hashes: string[] = [];
  if (t.includes('@')) {
    hashes.push(hashIdentifier(t, 'email', saltHex));
  } else {
    // Phone candidate when the term is mostly digits (allow +, spaces, dashes, parens).
    const digits = t.replace(/[\s\-()+]/g, '');
    if (digits.length >= 6 && /^\d+$/.test(digits)) {
      hashes.push(hashIdentifier(t, 'phone', saltHex));
    } else {
      // Last resort: treat as an email-shaped token (handles a partial paste without '@' rarely).
      hashes.push(hashIdentifier(t, 'email', saltHex));
    }
  }
  return hashes;
}

export async function listCustomers(
  brandId: string,
  params: ListCustomersParams,
  _correlationId: string,
  deps: ListCustomersDeps,
): Promise<CustomerList> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);
  const lifecycle = params.lifecycle && params.lifecycle.trim().length > 0 ? params.lifecycle.trim() : null;

  const segment = params.segment && params.segment.trim().length > 0 ? params.segment.trim() : null;
  const acquisitionSource =
    params.acquisitionSource && params.acquisitionSource.trim().length > 0 ? params.acquisitionSource.trim() : null;

  // GOLD-MART FILTERS (resolved at the Gold marts, applied as a brain_id allowlist in the graph). When a
  // filter is requested and its resolver is wired, fetch its members; an EMPTY member set (the filter has
  // no customers) means the page is honestly empty. No resolver wired → that param is a no-op (no filter).
  // Both segment + acquisition_source set → the browse is the INTERSECTION of the two allowlists.
  let brainIdFilter: string[] | null = null;
  if (segment && deps.segmentMembers) {
    brainIdFilter = await deps.segmentMembers(brandId, segment).catch(() => []);
  }
  if (acquisitionSource && deps.acquisitionSourceMembers) {
    const acqMembers = await deps.acquisitionSourceMembers(brandId, acquisitionSource).catch(() => []);
    if (brainIdFilter === null) {
      brainIdFilter = acqMembers;
    } else {
      // Intersect with the already-resolved segment allowlist (customers who match BOTH).
      const acqSet = new Set(acqMembers);
      brainIdFilter = brainIdFilter.filter((id) => acqSet.has(id));
    }
  }

  const term = params.search?.trim() ?? '';
  let identifierHashes: string[] | null = null;
  if (term.length > 0) {
    // Resolve the per-brand salt (shared resolution order with the resolver + consent gate). If the
    // salt is missing/wrong-length we treat the search as matching nothing rather than crash a read —
    // a browse must never hard-fail, and a bad salt could only ever mis-hash (never leak).
    // Prefer the injected brandSaltSource (dev-derived / prod KMS-unwrapped); fall back to the dev
    // resolver only when no saltFn was wired (older callers / tests). Fail-soft: a bad/missing salt
    // makes the search match nothing — never crash a browse, never leak (a wrong salt only mis-hashes).
    const salt = deps.saltFn ? await deps.saltFn(brandId).catch(() => '') : resolveSaltHex(brandId);
    identifierHashes = salt && salt.length === 64 ? searchHashes(term, salt) : [];
  }

  const { items, total } = await deps.reader.listCustomers(brandId, {
    lifecycle,
    identifierHashes: identifierHashes ?? [],
    limit,
    offset,
    brainIdFilter,
  });

  // Page enrichment: fold segment + LTV + order_count onto exactly the brain_ids on THIS page (a cheap
  // brain_id IN (...) read). Fail-soft — a scores-tier hiccup degrades to null enrichment, never a 500.
  let enrich = new Map<string, CustomerScoreEnrichment>();
  if (deps.enrichScores && items.length > 0) {
    enrich = await deps
      .enrichScores(brandId, items.map((r) => r.brain_id))
      .catch(() => new Map<string, CustomerScoreEnrichment>());
  }

  return {
    items: items.map((r) => {
      const e = enrich.get(r.brain_id);
      return {
        brain_id: r.brain_id,
        anonymous_id: r.anonymous_id,
        lifecycle_state: r.lifecycle_state,
        merged_into: r.merged_into,
        ai_processing_consent: r.ai_processing_consent,
        resolution_consent: r.resolution_consent,
        identifier_count: r.identifier_count,
        last_identifier_at: toIso(r.last_identifier_at),
        created_at: toIso(r.created_at) ?? '',
        segment: e?.segment ?? null,
        ltv_minor: e?.ltvMinor ?? null,
        currency_code: e?.currencyCode ?? null,
        order_count: e?.orderCount ?? null,
      };
    }),
    total,
    limit,
    offset,
    searched: term.length > 0,
  };
}
