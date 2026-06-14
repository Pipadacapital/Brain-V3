/**
 * Collector (Deployable 1) — accept-before-validate ingest. ADR-003.
 * Flow: intake → envelope → spool (fsync → ACK) → drainer → Redpanda.
 * The 99.95% durability guarantee lives in ./spool/, NOT the Kafka client.
 * Spec: docs/04 §7 / §C; docs/05 §4.
 */
export async function main() {
  // TODO: Fastify server; POST /collect, /webhook/{connector}; durable spool.
}
