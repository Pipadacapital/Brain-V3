// SPEC: B.3
/**
 * @brain/metric-engine — readTouchpointCachePage (the A.4 Redis touchpoint-cache read seam).
 *
 * The B.3 journey-timeline API serves its HOT path from the real-time touchpoint cache the
 * stream-worker maintains (SPEC: A.4): a per-DETERMINISTIC-brain_id Redis zset
 *   key    = `{brand_id}:tp:{brain_id}`   (tenant-first, §0.5)
 *   score  = event timestamp in ms
 *   member = compact JSON `{type, channel, url_path, ts, session_id}`
 * capped at the last 200 touchpoints, 30d sliding TTL. This module is the READ half — the
 * write half lives in apps/stream-worker/src/touchpoint-cache. When the cache is cold (no
 * key, TTL-expired, or the A.4 lane is flag-OFF for the brand) the caller falls back to the
 * durable Trino ledger (mv_journey_events_current) — §1.11 cache→Trino fallback.
 *
 * PORT, NOT ioredis: the reader depends on a structural `TouchpointZsetClient` (zrevrange +
 * zcard only) so the composition root injects the SAME shared ioredis client the serving
 * cache uses (no second connection) and unit tests inject an in-memory double. Nothing here
 * imports ioredis. Mapping a member → item is a pure, null-safe JSON parse (a malformed
 * member is skipped, never throws — the cache is best-effort).
 *
 * NEWEST-FIRST: zrevrange returns members by DESCENDING score (newest touchpoint first),
 * matching the ledger's `ORDER BY occurred_at DESC`. Pagination is a bounded window offset
 * (0..199) — the cache holds at most 200 entries; deeper history is a Trino read.
 *
 * @see apps/stream-worker/src/touchpoint-cache/TouchpointCacheStore.ts — the write half (A.4)
 * @see packages/tenant-context/src/index.ts — touchpointCacheKey() (the key builder)
 * @see packages/metric-engine/src/journey-events.ts — the durable Trino fallback read
 */

/**
 * The minimal zset read surface (DIP). ioredis satisfies this structurally
 * (zrevrange(key, start, stop) → string[]; zcard(key) → number) — no import leaks to callers.
 */
export interface TouchpointZsetClient {
  /** Members with score DESCENDING (newest first), inclusive [start, stop] rank window. */
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Number of members in the zset (0 if the key is absent). */
  zcard(key: string): Promise<number>;
}

/** One cached touchpoint (the A.4 zset member shape, decoded). */
export interface TouchpointCacheItem {
  /** Event timestamp in ms (the zset score / member.ts). */
  ts: number;
  /** Touchpoint event type (e.g. page.viewed). */
  type: string;
  /** Deterministic channel label (silver_touchpoint parity). Null = unknown. */
  channel: string | null;
  /** Best-effort page path. Null = not a page event / absent. */
  url_path: string | null;
  /** Session id (or null). */
  session_id: string | null;
}

export interface TouchpointCachePage {
  /** The page of cached touchpoints, newest-first. */
  items: TouchpointCacheItem[];
  /** Total members currently in the zset (for hasMore + honest emptiness). */
  total: number;
  /** True iff further (older) cached entries exist beyond this page. */
  hasMore: boolean;
}

interface RawMember {
  type?: unknown;
  channel?: unknown;
  url_path?: unknown;
  ts?: unknown;
  session_id?: unknown;
}

/** Null-safe string (empty → null). */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/** Decode one zset member JSON → item; malformed members are dropped (best-effort cache). */
function decodeMember(raw: string): TouchpointCacheItem | null {
  let parsed: RawMember;
  try {
    parsed = JSON.parse(raw) as RawMember;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const type = str(parsed.type);
  if (type === null) return null; // a touchpoint with no type is unusable
  const tsNum =
    typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : Number(parsed.ts);
  return {
    ts: Number.isFinite(tsNum) ? tsNum : 0,
    type,
    channel: str(parsed.channel),
    url_path: str(parsed.url_path),
    session_id: str(parsed.session_id),
  };
}

/**
 * readTouchpointCachePage — one newest-first page from the A.4 touchpoint zset.
 *
 * @param client - the injected zset read port (the shared ioredis client at the root).
 * @param key    - the `{brand_id}:tp:{brain_id}` cache key (built by touchpointCacheKey; the
 *                 brand_id-first shape is the tenant-isolation invariant — the caller MUST
 *                 build it from the SESSION brand, never a query param).
 * @param window - { offset, limit } bounded page over the ≤200-entry zset.
 * @returns items (newest-first) + total zcard + hasMore. total=0 → cold cache (caller falls
 *          back to Trino). NEVER throws for an operational reason — a Redis error propagates to
 *          the caller, which treats it as a cold cache (fall back to Trino).
 */
export async function readTouchpointCachePage(
  client: TouchpointZsetClient,
  key: string,
  window: { offset: number; limit: number },
): Promise<TouchpointCachePage> {
  const offset = Math.max(0, Math.trunc(window.offset));
  const limit = Math.min(Math.max(1, Math.trunc(window.limit)), 200);

  const total = await client.zcard(key);
  if (total <= 0 || offset >= total) {
    return { items: [], total: Math.max(0, total), hasMore: false };
  }

  // Look-ahead by 1: a returned (offset+limit)-th member means a further page exists.
  const stop = offset + limit; // inclusive rank → fetches limit+1 members
  const raw = await client.zrevrange(key, offset, stop);
  const hasMore = raw.length > limit;
  const pageRaw = hasMore ? raw.slice(0, limit) : raw;

  const items: TouchpointCacheItem[] = [];
  for (const m of pageRaw) {
    const item = decodeMember(m);
    if (item !== null) items.push(item);
  }

  return { items, total, hasMore };
}
