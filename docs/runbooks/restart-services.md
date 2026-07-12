# Runbook — Restart services (prod)

Audit trail: **AUD-OPS-021**. Restart is the most common operator action (crash recovery,
secret rotation pickup, config change) — this page says HOW per service, WHAT each restart
costs, and how to verify. All prod apps are one-Deployment-per-namespace, so
`kubectl -n <ns> rollout restart deployment` is the universal verb (StatefulSets noted below).

**Why restarts matter for secrets:** ESO refreshes a rotated Secrets Manager value into the
k8s Secret within 1h (`refreshInterval`), but **pods consume env at start** — nothing picks up
a rotated value until you roll the Deployment (`infra/helm/external-secrets-config/README.md`).
See the rotation appendix in `prod-secrets-worksheet.md` for which services to roll per secret.

## Per-service matrix

| Service (ns) | Restart | Safety notes |
|---|---|---|
| **web** (`web`) | `kubectl -n web rollout restart deployment` | Stateless. Zero-risk rolling restart. |
| **core** (`core`) | `kubectl -n core rollout restart deployment` | Stateless API; DB via pgbouncer. In-flight requests retried by clients. The PreSync migration hook is DISABLED in prod — a core restart never runs DDL. |
| **collector** (`collector`) | `kubectl -n collector rollout restart deployment` | **Accept-before-validate + PG spool**: accepted events are spooled/produced before the pod dies; a rolling restart (≥2 replicas) is loss-free. Watch for ANY non-2xx at the edge during the roll — that would be an event-loss bug, not an expected cost. |
| **stream-worker** (`stream-worker`) | `kubectl -n stream-worker rollout restart deployment` | **Singleton semantics — leader lock** (PG advisory lock over `DATABASE_URL` = DIRECT Aurora, never pgbouncer). The old pod's lock releases when its connection closes; expect a short leader-takeover pause (consumers resume from committed offsets — no loss). Do NOT scale replicas as a "faster restart". |
| **kafka-connect** (`kafka`) | `kubectl -n kafka rollout restart deployment/kafka-connect-prod-kafka-connect` | **Sole Bronze landing writer.** Restart = up to one commit interval (~30s) of landing pause; **exactly-once across restarts** (offsets live in the Iceberg snapshot metadata — probed in `adr-0010-kafka-connect-bronze.md`); topics retain 7d, so nothing is lost. AFTER restart verify `/connectors` is non-empty (a `[]` list is the AUD-OPS-018 registration-loss failure — see that recovery section). |
| **trino** (`trino`) | `kubectl -n trino rollout restart deployment` | **Sole serving engine**: while the coordinator is down EVERY BFF analytics read 500s ("fetch failed" — looks like an app bug, isn't; see `investigate-oom.md`). Redis cache absorbs warm keys only. Restart in a quiet window; single-replica means a hard gap, not a rolling one. |
| **iceberg-rest** (`iceberg-rest`) | `kubectl -n iceberg-rest rollout restart deployment` | Catalog API. Trino queries + Spark job starts fail during the gap (bounded retries absorb it); Connect keeps committing only if the catalog answers — keep the gap short. |
| **pgbouncer** (`pgbouncer`) | `kubectl -n pgbouncer rollout restart deployment` | Core/collector DB path (`:6432`). Clients reconnect; expect a brief burst of connection errors. stream-worker is UNAFFECTED (direct Aurora). Roll pgbouncer FIRST in a DB-password rotation. |
| **neo4j** (`neo4j`) | `kubectl -n neo4j rollout restart statefulset` | Identity SoR (ADR-0004), single instance on the on-demand pool: identity resolution + stitch export pause until Ready (PVC-backed, no data loss). Silver identity marts simply fold later rows on the next cycle. |
| **Kafka brokers** (`kafka`) | do NOT `rollout restart` | Strimzi-managed: `kubectl -n kafka annotate strimzikafkanodepool/combined strimzi.io/manual-rolling-update=true` and let the operator roll broker-by-broker. NEVER delete broker pods/PVCs by hand — see `kafka-operations.md` HARD RULES. |

## Verify after a restart

```bash
kubectl -n <ns> rollout status deployment            # completes, no crash-loop
# health endpoints: collector /healthz + /readyz, core /health, web / — all 200
# landing alive (after kafka-connect/trino/iceberg-rest restarts):
kubectl -n kafka exec deploy/kafka-connect-prod-kafka-connect -- curl -s localhost:8083/connectors   # non-empty
# freshness recovering (Prometheus): brain_data_freshness_seconds falling back under SLA
```

If a restart was for a rotated secret: `kubectl get externalsecrets -A` must show
`SecretSynced` BEFORE the roll — restarting against a stale k8s Secret just re-reads the old
value.
