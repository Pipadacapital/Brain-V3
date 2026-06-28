/**
 * pixel-sdk/transport — durable, one-event-per-POST delivery (ADR-1 / REC-5).
 *
 * INVARIANTS:
 *  - ONE event per POST (NO batched array — VETOED until a drainer fan-out exists, REC-5).
 *  - event_id is minted ONCE at enqueue and REUSED on every retry (R4 / D2.2): a retried
 *    event keeps its id (Bronze (brand_id,event_id) PK dedups it exactly-once).
 *  - sendBeacon on pagehide/visibilitychange; fetch(keepalive) as the durable fallback.
 *  - A durable localStorage queue survives a tab close; drained on next load + on triggers.
 *  - NO Set-Cookie, NO credentials — the edge stays stateless (REC-4).
 */
import type { BrowserEnv, CollectorEventV1 } from './types.js';

const QUEUE_KEY = '__brain_queue';
const MAX_QUEUE = 200; // bounded — never unbounded growth

// Keep-critical eviction (G1). CRITICAL families = conversion / money / identity / our own loss-signal;
// they must NEVER be evicted to make room for high-volume behavioural noise (scroll/click/page_view).
// Mirrors the served pixel (apps/collector pixel-asset.route.ts) so the npm SDK is not a weaker pixel.
const CRITICAL_RE = /^(order\.|payment\.|checkout\.|cart\.|purchase|identify|pixel\.dropped)/;
function isCritical(ev: CollectorEventV1): boolean {
  return typeof ev?.event_name === 'string' && CRITICAL_RE.test(ev.event_name);
}

// Exponential-backoff retry schedule (G2): 1s → 2 → 4 → 8 → 16 → 30s (cap), then idle until next trigger.
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function readQueue(env: BrowserEnv): CollectorEventV1[] {
  const raw = env.storage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as CollectorEventV1[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Trim to MAX_QUEUE, evicting OLDEST NON-critical first; drop critical only as a last resort. */
function evictToCap(q: CollectorEventV1[]): { kept: CollectorEventV1[]; dropped: number } {
  if (q.length <= MAX_QUEUE) return { kept: q, dropped: 0 };
  let over = q.length - MAX_QUEUE;
  let dropped = 0;
  const kept: CollectorEventV1[] = [];
  for (const ev of q) {
    if (over > 0 && !isCritical(ev)) {
      over--;
      dropped++;
      continue;
    }
    kept.push(ev);
  }
  if (kept.length > MAX_QUEUE) {
    const extra = kept.length - MAX_QUEUE;
    return { kept: kept.slice(extra), dropped: dropped + extra };
  }
  return { kept, dropped };
}

/** Persist the queue with keep-critical eviction. Returns how many events were dropped. */
function writeQueue(env: BrowserEnv, q: CollectorEventV1[]): number {
  const { kept, dropped } = evictToCap(q);
  env.storage.setItem(QUEUE_KEY, JSON.stringify(kept));
  return dropped;
}

export class Transport {
  /** Client-side events dropped to keep-critical eviction since the last consume (No-event-loss metric). */
  private droppedCount = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly env: BrowserEnv,
    private readonly collectUrl: string,
  ) {
    // Drain on a flush trigger (pagehide / visibilitychange:hidden).
    this.env.onFlushTrigger(() => {
      void this.flush();
    });
  }

  /** Enqueue an event (event_id already minted by the caller) + attempt an immediate flush. */
  async enqueue(event: CollectorEventV1): Promise<void> {
    const q = readQueue(this.env);
    q.push(event);
    this.droppedCount += writeQueue(this.env, q);
    await this.flush();
  }

  /**
   * Read-and-reset the client-side drop count. The SDK client piggybacks this onto a critical
   * `pixel.dropped` event so the collector learns about any client-side loss (No-event-loss
   * observability) — the served pixel does the same.
   */
  consumeDroppedCount(): number {
    const n = this.droppedCount;
    this.droppedCount = 0;
    return n;
  }

  /**
   * Flush the queue ONE EVENT PER POST. A failed send keeps the event (with its original
   * event_id) at the head of the queue and schedules an exponential-backoff retry (G2) so the
   * queue is not stranded until the next page trigger — never duplicated, never reordered
   * destructively. Beacon is best-effort; fetch(keepalive) is the durable confirm.
   */
  async flush(): Promise<void> {
    let q = readQueue(this.env);
    while (q.length > 0) {
      const event = q[0]!;
      const body = JSON.stringify(event); // ONE object — never an array (REC-5)
      const ok = await this.sendOne(this.collectUrl, body);
      if (!ok) {
        // Keep the event (same event_id) for the next retry; stop draining this pass + back off.
        this.droppedCount += writeQueue(this.env, q);
        this.scheduleRetry();
        return;
      }
      this.resetRetry(); // a good send means we're online — clear any pending backoff
      q = q.slice(1);
      this.droppedCount += writeQueue(this.env, q);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.retryAttempt >= RETRY_DELAYS.length) return;
    const delay = RETRY_DELAYS[this.retryAttempt]!;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, delay);
  }

  private resetRetry(): void {
    this.retryAttempt = 0;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private async sendOne(url: string, body: string): Promise<boolean> {
    // Prefer sendBeacon during unload (survives tab close); fall back to fetch(keepalive).
    if (this.env.sendBeacon) {
      try {
        if (this.env.sendBeacon(url, body)) return true;
      } catch {
        // fall through to fetch
      }
    }
    try {
      return await this.env.fetchKeepalive(url, body);
    } catch {
      return false;
    }
  }
}
