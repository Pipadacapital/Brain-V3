// SPEC: B.3
/**
 * getCustomerJourney — the B.3 per-customer journey timeline (AMD-14).
 *
 * `GET /v1/customers/{brain_id}/journey` — a paginated, newest-first timeline of a resolved
 * customer's touchpoints. §1.11 serving: the HOT path reads the A.4 Redis touchpoint cache
 * (`{brand_id}:tp:{brain_id}` zset — the last ≤200 touchpoints); when the cache is COLD (no key,
 * TTL-expired, the A.4 lane flag-OFF for the brand, or no cache client wired) the read falls back
 * to the durable serving ledger (mv_journey_events_current over iceberg.brain_gold.journey_events).
 *
 * ONE opaque cursor spans both paths: it records which source is paginating (`c` = cache offset,
 * `t` = serving-ledger keyset sequence) so a continuation stays on the source the FIRST page chose — the
 * cache is the hot recent window, the ledger is the durable full history. An invalid/foreign
 * cursor decodes to null → first page (a read projection never hard-fails on a cursor).
 *
 * matched_via (AUD-JE-34) is the B.4 coarse stitch-provenance basis on the ledger path
 * ('order' | 'deterministic' | 'anonymous' — derived by the metric-engine journey-events read,
 * never null there); it stays honestly NULL on the A.4 cache path only (the hot-cache member
 * carries no provenance). journey_version is the DERIVED journey-level version (AMD-11 = max
 * data_version) — present on the ledger path, null on the pre-ledger cache path. brand_id is from
 * the SESSION (D-1), NEVER the path — the {brain_id} path segment only scopes WITHIN the caller's
 * brand.
 *
 * @see packages/metric-engine/src/journey-touchpoint-cache.ts (cache read)
 * @see packages/metric-engine/src/journey-events.ts (serving ledger fallback)
 */

import type { SilverPool, TouchpointZsetClient } from '@brain/metric-engine';
import { computeJourneyEventsCurrent, readTouchpointCachePage } from '@brain/metric-engine';
import { touchpointCacheKey } from '@brain/tenant-context';
import type { CustomerJourneyItem, CustomerJourneyTimeline } from '@brain/contracts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface CustomerJourneyParams {
  /** The resolved customer's brain_id (from the path — scoped WITHIN the session brand). */
  brainId: string;
  /** Opaque cursor from a previous page's next_cursor. Invalid → first page. */
  cursor?: string | null;
  /** Page size (server-clamped 1..200; default 50). */
  limit?: number;
  dataSource: 'synthetic' | 'live';
}

// ── Opaque cross-source cursor ────────────────────────────────────────────────
// base64url JSON. src 'c' = cache offset (off), src 't' = serving-ledger keyset (sn digits string).
interface CustomerJourneyCursor {
  v: 1;
  src: 'c' | 't';
  off?: number;
  sn?: string;
}

function encodeCursor(c: Omit<CustomerJourneyCursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CustomerJourneyCursor | null {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CustomerJourneyCursor;
    if (p !== null && typeof p === 'object' && p.v === 1 && (p.src === 'c' || p.src === 't')) {
      if (p.src === 'c' && typeof p.off === 'number' && Number.isInteger(p.off) && p.off >= 0) return p;
      if (p.src === 't' && typeof p.sn === 'string' && /^\d+$/.test(p.sn)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * getCustomerJourney — the resolved-customer timeline page (cache-first, serving fallback).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body/path).
 * @param deps    - the duckdb-serving pool (srPool) + optional A.4 touchpoint-cache client (tpCache).
 * @param params  - brainId + optional cursor + page size + data_source flag.
 */
export async function getCustomerJourney(
  brandId: string,
  deps: { srPool: SilverPool; tpCache?: TouchpointZsetClient },
  params: CustomerJourneyParams,
): Promise<CustomerJourneyTimeline> {
  if (!params.brainId || params.brainId.length === 0) {
    return { state: 'no_data' };
  }
  const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const decoded = params.cursor ? decodeCursor(params.cursor) : null;

  // ── Cache path: no cursor OR an explicit cache cursor, and a cache client is wired ──────
  const wantCache = deps.tpCache && (decoded === null || decoded.src === 'c');
  if (wantCache && deps.tpCache) {
    const offset = decoded?.src === 'c' ? (decoded.off ?? 0) : 0;
    try {
      const key = touchpointCacheKey({ brandId, brainId: params.brainId });
      const page = await readTouchpointCachePage(deps.tpCache, key, { offset, limit });
      if (page.total > 0) {
        // Warm cache → serve entirely from the hot window (deeper history is a serving-ledger read).
        const items: CustomerJourneyItem[] = page.items.map((t) => ({
          ts: t.ts,
          type: t.type,
          channel: t.channel,
          campaign: null, // the A.4 member carries no campaign (behavioral hot cache)
          url_path: t.url_path,
          session_id: t.session_id,
          matched_via: null, // the A.4 hot-cache member carries no stitch provenance (honest null)
          journey_version: null, // the cache predates the versioned ledger
        }));
        return {
          state: 'has_data',
          brain_id: params.brainId,
          items,
          next_cursor: page.hasMore ? encodeCursor({ src: 'c', off: offset + limit }) : null,
          journey_version: null,
          source: 'cache',
          data_source: params.dataSource,
        };
      }
      // Cold cache (total=0) → fall through to the serving ledger below.
    } catch {
      // Redis error → treat as cold cache and fall back to the serving ledger (§1.11 fail-soft).
    }
  }

  // ── Serving-ledger path: cold/absent cache, or an explicit ledger cursor ──────────────────
  const afterSequence = decoded?.src === 't' ? (decoded.sn ?? null) : null;
  const ledger = await computeJourneyEventsCurrent(brandId, deps, {
    brainId: params.brainId,
    afterSequence,
    limit,
  });
  if (!ledger.hasData) {
    return { state: 'no_data' };
  }

  let maxVersion: number | null = null;
  const items: CustomerJourneyItem[] = ledger.events.map((e) => {
    maxVersion = maxVersion === null ? e.dataVersion : Math.max(maxVersion, e.dataVersion);
    return {
      ts: e.occurredAt,
      type: e.eventType,
      channel: e.channel,
      campaign: e.campaign,
      url_path: null, // the ledger mart carries no url_path column (honest null)
      session_id: null, // the ledger metric read does not project session_key (honest null)
      // AUD-JE-34 — B.4 coarse stitch-provenance basis ('order'|'deterministic'|'anonymous');
      // never null on the ledger path (same serialization as the B.4 replay endpoints).
      matched_via: e.matchedVia,
      journey_version: e.dataVersion,
    };
  });

  return {
    state: 'has_data',
    brain_id: params.brainId,
    items,
    next_cursor:
      ledger.nextAfterSequence === null ? null : encodeCursor({ src: 't', sn: ledger.nextAfterSequence }),
    journey_version: maxVersion,
    source: 'serving',
    data_source: params.dataSource,
  };
}
