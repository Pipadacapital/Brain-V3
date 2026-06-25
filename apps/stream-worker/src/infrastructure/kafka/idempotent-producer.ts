/**
 * createIdempotentProducer — the single EoS-correct way to build an idempotent
 * Kafka producer in the stream-worker.
 *
 * WHY this exists (no-event-loss invariant):
 *   `idempotent: true` makes KafkaJS enforce acks=-1 + maxInFlightRequests=1 and
 *   tag each produce with a sequence number so the broker dedupes transient
 *   retries — the foundation of exactly-once at the broker layer.
 *
 *   But idempotent EoS only holds if the producer is allowed to KEEP retrying a
 *   transient failure with the same sequence number. KafkaJS's own default for an
 *   idempotent producer is therefore `retries: Number.MAX_SAFE_INTEGER`. Our job
 *   clients are constructed with a client-level `retry: { retries: 5 }` (sane for
 *   connection establishment), which the producer would otherwise INHERIT —
 *   capping produce retries at 5. KafkaJS warns about exactly this:
 *     "Limiting retries for the idempotent producer may invalidate EoS guarantees"
 *   and the practical consequence is real: after 5 transient broker errors the
 *   produce throws and the event is lost — violating Brain's "No event loss" rule
 *   and "Bronze is source of truth".
 *
 *   So we override retries back to MAX_SAFE_INTEGER at the PRODUCER level (leaving
 *   the client-level connection retry bounded). Backoff stays capped by KafkaJS's
 *   `maxRetryTime` (~30s), so this is "retry through a transient blip", not a hot
 *   loop. Operationally, jobs are bounded by their pod/cron deadline + SIGTERM
 *   drain — a permanently-dead broker fails the job loudly rather than dropping a
 *   record silently.
 */
import type { Kafka, Producer } from 'kafkajs';

export function createIdempotentProducer(kafka: Kafka): Producer {
  return kafka.producer({
    idempotent: true,
    // Equal to KafkaJS's idempotent default → EoS-safe AND silences the
    // "Limiting retries ... may invalidate EoS guarantees" warning (the warn
    // fires only when retries < MAX_SAFE_INTEGER).
    retry: { retries: Number.MAX_SAFE_INTEGER },
  });
}
