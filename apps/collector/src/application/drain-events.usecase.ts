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

    // AUD-PERF-012: the body is the CANONICAL jsonb text straight from PG; correlation_id /
    // brand_id / event_id were projected in SQL — no JSON parse or stringify on this path.
    const batch = claim.entries.map((entry) => ({
      valueText: entry.rawBodyText,
      brandId: entry.brandId,
      eventId: entry.eventId,
      correlationId: entry.correlationId ?? `spool-${entry.id.toString()}`,
    }));

    try {
      // ONE producer.send for the whole claimed batch (AUD-PERF-002) — kafkajs batches the
      // messages natively; per-message correlation_id/trace headers are built by the producer.
      await this.kafka.produceBatch(batch);
    } catch (err) {
      // F-3 back-pressure: leave the WHOLE batch 'pending'. Redpanda may be down.
      // Log the error but do NOT throw — the drainer loop must continue to next tick.
      // Pass the Error in fields.err so Sentry + stack handling fires (not a stringified message).
      log.error('batch produce failed — leaving spool batch pending (back-pressure)', {
        err,
        batch_size: claim.entries.length,
        first_spool_id: claim.entries[0]?.id.toString(),
      });
      await claim.rollback().catch(() => undefined);
      return 0;
    }

    try {
      // ONE UPDATE … WHERE id = ANY($1) for the produced batch (AUD-PERF-002), then commit
      // the claim so the drained marks become durable and the row locks release.
      await claim.markDrained(claim.entries.map((entry) => entry.id));
      await claim.commit();
    } catch (err) {
      // Claim-settle / markDrained infrastructure error: release the claim so every row stays
      // 'pending' (no event loss; the re-produce next tick is absorbed by downstream event_id dedup).
      await claim.rollback().catch(() => undefined);
      throw err;
    }

    return claim.entries.length;
  }
}
