/**
 * DrainEventsUseCase — reads pending spool rows and produces to Redpanda.
 *
 * Called by the drainer loop (interfaces/jobs/drainer.ts), NEVER by the HTTP handler.
 *
 * D-1 / F-3 invariants:
 *   - On Kafka produce error: leave row as 'pending', log, do NOT throw up to caller.
 *     The drainer loop calls this; a throw would crash the loop.
 *   - On produce success: mark row 'drained'.
 *   - Back-pressure: if Redpanda is down, the whole batch silently stays pending.
 *     Next drainer tick will retry. No event is dropped.
 *
 * Returns the count of rows drained in this batch.
 */
import type { SpoolRepository } from '../domain/ingest/repositories/spool.repository.js';
import type { CollectorKafkaProducer } from '../infrastructure/kafka-producer.js';
import { log } from "../log.js";

export class DrainEventsUseCase {
  constructor(
    private readonly spool: SpoolRepository,
    private readonly kafka: CollectorKafkaProducer,
    private readonly batchSize: number,
  ) {}

  async execute(): Promise<number> {
    // Row-claim (AUD-PERF-006): the claimed rows are locked (FOR UPDATE SKIP LOCKED) for the
    // duration of this pass, so an overlapping tick / second replica skips them (no double-produce).
    const claim = await this.spool.claimPending(this.batchSize);
    if (claim.entries.length === 0) {
      await claim.rollback();
      return 0;
    }

    let drained = 0;

    try {
      for (const entry of claim.entries) {
        const correlationId =
          typeof entry.rawBody['correlation_id'] === 'string'
            ? entry.rawBody['correlation_id']
            : `spool-${entry.id.toString()}`;
        // Per-message child logger: bind correlation_id + brand_id (tenant key, a UUID — not PII)
        // so every drain line for this event is correlatable end-to-end with the downstream
        // stream-worker consumer (which extracts the same correlation_id off the Kafka headers).
        const brandId =
          typeof entry.rawBody['brand_id'] === 'string' ? entry.rawBody['brand_id'] : undefined;
        const mlog = log.child({ correlation_id: correlationId, brand_id: brandId, spool_id: entry.id.toString() });
        try {
          await this.kafka.produce(entry.rawBody, correlationId);
          await claim.markDrained([entry.id]);
          drained++;
        } catch (err) {
          // F-3 back-pressure: leave this row 'pending'. Redpanda may be down.
          // Log the error but do NOT throw — the drainer loop must continue to next tick.
          // Pass the Error in fields.err so Sentry + stack handling fires (not a stringified message).
          mlog.error('produce failed — leaving spool row pending (back-pressure)', { err });
          // Stop processing this batch on first failure — producer reconnect may be needed.
          // Next tick the drainer will retry from the oldest pending row.
          break;
        }
      }

      if (drained > 0) {
        await claim.commit(); // drained marks become durable, locks release
      } else {
        await claim.rollback(); // whole batch stays pending (back-pressure hold)
      }
    } catch (err) {
      // Claim-settle / markDrained infrastructure error: release the claim so every row stays
      // 'pending' (no event loss; a re-produce next tick is absorbed by downstream event_id dedup).
      await claim.rollback().catch(() => undefined);
      throw err;
    }

    return drained;
  }
}
