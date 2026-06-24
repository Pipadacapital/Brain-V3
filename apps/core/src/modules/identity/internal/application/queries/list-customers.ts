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
import type { Neo4jIdentityReader } from '../../infrastructure/neo4j-identity-reader.js';

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
  limit?: number;
  offset?: number;
}

export interface ListCustomersDeps {
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR. */
  reader: Neo4jIdentityReader;
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

  const term = params.search?.trim() ?? '';
  let identifierHashes: string[] | null = null;
  if (term.length > 0) {
    // Resolve the per-brand salt (shared resolution order with the resolver + consent gate). If the
    // salt is missing/wrong-length we treat the search as matching nothing rather than crash a read —
    // a browse must never hard-fail, and a bad salt could only ever mis-hash (never leak).
    const salt = resolveSaltHex(brandId);
    identifierHashes = salt && salt.length === 64 ? searchHashes(term, salt) : [];
  }

  const { items, total } = await deps.reader.listCustomers(brandId, {
    lifecycle,
    identifierHashes: identifierHashes ?? [],
    limit,
    offset,
  });
  return {
    items: items.map((r) => ({
      brain_id: r.brain_id,
      anonymous_id: r.anonymous_id,
      lifecycle_state: r.lifecycle_state,
      merged_into: r.merged_into,
      ai_processing_consent: r.ai_processing_consent,
      resolution_consent: r.resolution_consent,
      identifier_count: r.identifier_count,
      last_identifier_at: toIso(r.last_identifier_at),
      created_at: toIso(r.created_at) ?? '',
    })),
    total,
    limit,
    offset,
    searched: term.length > 0,
  };
}
