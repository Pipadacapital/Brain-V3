/**
 * Core monolith (Deployable 3) — the 13 bounded-context modules under ./modules/.
 * platform/ = auth, tenant-context, RLS session, revocation denylist (cross-cutting).
 * server/   = route registration, error envelope, rate-limit, idempotency.
 * RULE: only the Analytics API (modules/analytics) touches StarRocks/Iceberg (ADR-002).
 * Spec: docs/04 §C / §5; docs/05 §3.
 */
export async function main() {
  // TODO: Fastify bootstrap, OTel init, register module routers, tenant-context middleware.
}
