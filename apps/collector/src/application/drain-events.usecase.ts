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
    const pending = await this.spool.pollPending(this.batchSize);
    if (pending.length === 0) return 0;

    let drained = 0;

    for (const entry of pending) {
      try {
        const correlationId =
          typeof entry.rawBody['correlation_id'] === 'string'
            ? entry.rawBody['correlation_id']
            : `spool-${entry.id.toString()}`;

        await this.kafka.produce(entry.rawBody, correlationId);
        await this.spool.markDrained(entry.id);
        drained++;
      } catch (err) {
        // F-3 back-pressure: leave this row 'pending'. Redpanda may be down.
        // Log the error but do NOT throw — the drainer loop must continue to next tick.
        log.error(`produce failed for spool id=${entry.id.toString()}: ${String(err)}`);
        // Stop processing this batch on first failure — producer reconnect may be needed.
        // Next tick the drainer will retry from the oldest pending row.
        break;
      }
    }

    return drained;
  }
}
