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
const MAX_QUEUE = 200; // bounded — drop oldest beyond this (never unbounded growth)

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

function writeQueue(env: BrowserEnv, q: CollectorEventV1[]): void {
  const bounded = q.length > MAX_QUEUE ? q.slice(q.length - MAX_QUEUE) : q;
  env.storage.setItem(QUEUE_KEY, JSON.stringify(bounded));
}

export class Transport {
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
    writeQueue(this.env, q);
    await this.flush();
  }

  /**
   * Flush the queue ONE EVENT PER POST. A failed send keeps the event (with its original
   * event_id) at the head of the queue for the next retry — never duplicated, never reordered
   * destructively. Beacon is best-effort; fetch(keepalive) is the durable confirm.
   */
  async flush(): Promise<void> {
    let q = readQueue(this.env);
    while (q.length > 0) {
      const event = q[0]!;
      const body = JSON.stringify(event); // ONE object — never an array (REC-5)
      const ok = await this.sendOne(this.collectUrl, body);
      if (!ok) {
        // Keep the event (same event_id) for the next retry; stop draining this pass.
        writeQueue(this.env, q);
        return;
      }
      q = q.slice(1);
      writeQueue(this.env, q);
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
