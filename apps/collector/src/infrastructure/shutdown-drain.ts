/**
 * shutdown-drain — the SIGTERM WAL drain sequence (ADR-0015 WAL durability posture:
 * drain + alert, not PVC/StatefulSet). Extracted from main.ts so the ORDER is unit-testable:
 *
 *   1. ONE final WAL flush bounded by INGEST_SHUTDOWN_FLUSH_TIMEOUT_MS — while the producer
 *      is STILL CONNECTED (the flush produces to the log; disconnect first = guaranteed no-op).
 *   2. Stop the flusher timer + close the append handle.
 *   3. Disconnect the producer.
 *
 * Every step is best-effort: a flush failure/timeout keeps the WAL on disk, where the next
 * boot's init() adopts it (crash-safe). The caller (main.ts) fails readiness and closes the
 * HTTP listener BEFORE invoking this, so no new appends race the final flush.
 */
import { log } from '../log.js';

export interface DrainableWal {
  drain(timeoutMs: number): Promise<'drained' | 'timeout'>;
  stop(): Promise<void>;
  pendingBytes(): number;
}

export interface DisconnectableProducer {
  disconnect(): Promise<void>;
}

export async function drainWalThenDisconnect(
  fallback: DrainableWal,
  producer: DisconnectableProducer,
  timeoutMs: number,
): Promise<'drained' | 'timeout'> {
  const result = await fallback.drain(timeoutMs).catch((err) => {
    // A flush ERROR keeps the WAL on disk — same recovery posture as a timeout.
    log.debug('final WAL flush failed on shutdown', { err });
    return 'drained' as const;
  });
  if (result === 'timeout') {
    log.warn(
      'final WAL flush exceeded the shutdown deadline — unflushed entries stay on disk for next-boot adoption',
      { timeout_ms: timeoutMs, pending_bytes: fallback.pendingBytes() },
    );
  }
  await fallback.stop().catch((err) => log.debug('fallback stop failed on shutdown', { err }));
  // Producer disconnect LAST — the drain above needed it connected.
  await producer.disconnect().catch((err) => log.debug('producer disconnect failed on shutdown', { err }));
  return result;
}
