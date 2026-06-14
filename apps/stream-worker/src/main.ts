/**
 * Stream-worker (Deployable 2) — KafkaJS consumers (separate live + backfill groups).
 * Pipeline: validate(Apicurio) → dedup(event_id, server-wins) → enrich →
 *   sessionize → bot-filter → quality. Identity resolution is ASYNC off Bronze (ADR-008).
 * Spec: docs/04 §C; docs/05 §4.
 */
export async function main() {
  // TODO: live + backfill consumer groups; brand_id == partition key asserted.
}
