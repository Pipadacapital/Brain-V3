// SPEC: B.3
/**
 * B3 — readTouchpointCachePage: the A.4 touchpoint-cache read seam (journey-timeline hot path).
 * Proves newest-first paging over the zset, the look-ahead hasMore signal, cold-cache honesty,
 * and best-effort decoding (a malformed member is dropped, never throws).
 */
import { describe, it, expect } from 'vitest';
import { readTouchpointCachePage, type TouchpointZsetClient } from './journey-touchpoint-cache.js';

/** In-memory zset double: members newest(highest-score)-first, captures the requested rank window. */
function fakeZset(membersNewestFirst: string[]): TouchpointZsetClient & { lastRange: [number, number] } {
  return {
    lastRange: [0, 0],
    async zcard(): Promise<number> {
      return membersNewestFirst.length;
    },
    async zrevrange(_key: string, start: number, stop: number): Promise<string[]> {
      this.lastRange = [start, stop];
      return membersNewestFirst.slice(start, stop + 1); // inclusive stop (Redis semantics)
    },
  };
}

function member(ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'page.viewed', channel: 'direct', url_path: '/p', ts, session_id: 's1', ...extra });
}

describe('B3 readTouchpointCachePage', () => {
  it('returns a newest-first page and signals hasMore via the look-ahead row', async () => {
    const z = fakeZset([member(9), member(8), member(7)]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.ts)).toEqual([9, 8]); // newest first, look-ahead (7) trimmed
    expect(page.hasMore).toBe(true);
    expect(z.lastRange).toEqual([0, 2]); // offset..offset+limit (inclusive → limit+1 members)
  });

  it('last page: no look-ahead row → hasMore=false', async () => {
    const z = fakeZset([member(2), member(1)]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 0, limit: 2 });
    expect(page.items.map((i) => i.ts)).toEqual([2, 1]);
    expect(page.hasMore).toBe(false);
  });

  it('honest cold cache: zcard 0 → empty page, no zrevrange call needed for data', async () => {
    const z = fakeZset([]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 0, limit: 50 });
    expect(page).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('offset beyond total → empty page (no negative slicing)', async () => {
    const z = fakeZset([member(1)]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 5, limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('best-effort: a malformed member is skipped, a valid one survives (never throws)', async () => {
    const z = fakeZset(['{not json', member(4), JSON.stringify({ channel: 'x' }) /* no type */]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 0, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ ts: 4, type: 'page.viewed', channel: 'direct', url_path: '/p', session_id: 's1' });
  });

  it('maps null-ish member fields to null (honest nullability)', async () => {
    const z = fakeZset([JSON.stringify({ type: 'identify', ts: 3, channel: '', url_path: null, session_id: '' })]);
    const page = await readTouchpointCachePage(z, 'b:tp:x', { offset: 0, limit: 10 });
    expect(page.items[0]).toEqual({ ts: 3, type: 'identify', channel: null, url_path: null, session_id: null });
  });
});
