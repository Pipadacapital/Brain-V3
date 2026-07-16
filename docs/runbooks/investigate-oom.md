# Runbook — Investigate OOM (prod)

Audit trail: **AUD-OPS-022**. The existing memory docs (`docs/ops/local-memory-budget.md`,
`docs/ops/spark-tuning.md`) are local-compose scoped; this page is the prod on-call chain.
The headline trap: **duckdb-serving is the sole serving engine — all replicas down presents as
platform-wide BFF 500s ("fetch failed") and looks exactly like an app bug.** It isn't. Check
infrastructure BEFORE debugging application code. (The engine is designed NOT to OOM — a
pathological query hits the in-process `memory_limit`/watchdog and 504s — so a genuine
OOM-kill here usually means the pod limit was squeezed below the configured memory_limit.)

## Symptom → suspect table

| Symptom | Suspect | First check |
|---|---|---|
| EVERY BFF/analytics API 500s "fetch failed" at once; dashboards dead | **duckdb-serving** replicas down (the historic outage signature, inherited from Trino) | `kubectl -n duckdb-serving get pods` — RESTARTS climbing; `describe pod` → `Last State: Terminated, Reason: OOMKilled` |
| `v4-silver` / `v4-gold` Argo workflows failing / retrying | **Spark driver** (local[*] mode: driver IS the job) | `argo -n argo list`; `kubectl -n argo logs <pod>` → `java.lang.OutOfMemoryError` / exit 137 |
| Bronze landing lag climbing, commits stop, connector tasks FAILED | **kafka-connect** heap | `kubectl -n kafka get pods`; task state via `curl :8083/connectors/<name>/status` |
| One app namespace crash-looping, others fine | that app's container limit | `kubectl -n <ns> describe pod` last-state |
| Random evictions across namespaces on one node | **node-level** pressure (not a container limit) | `kubectl top nodes`; `kubectl get events -A --field-selector reason=Evicted` |

## Confirm it IS an OOM (not a crash)

```bash
kubectl -n <ns> get pods                                   # RESTARTS > 0?
kubectl -n <ns> describe pod <pod> | grep -A5 'Last State' # Reason: OOMKilled / Exit Code: 137
kubectl top pods -n <ns>                                   # live usage vs limit (needs metrics-server)
```

PromQL (kube-prometheus-stack):
```promql
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
increase(container_oom_events_total[1h]) > 0
container_memory_working_set_bytes / on(pod,container) kube_pod_container_resource_limits{resource="memory"} > 0.9
```

## Per-component bounded-heap knobs (the fixes that already worked)

- **duckdb-serving** — same bounded-memory posture that fixed the historic Trino outage, no JVM:
  `DUCKDB_SERVING_MEMORY_LIMIT` (DuckDB's in-process cap) must fit inside the pod memory limit
  with headroom for the Python runtime + Arrow buffers (`infra/helm/duckdb-serving` values:
  3.5Gi request / 4Gi limit around a 3GB memory_limit); spills go to `temp_directory`, the
  watchdog interrupts at the statement timeout, and the admission semaphore bounds concurrency.
  If pods still OOM-kill, LOWER `DUCKDB_SERVING_MAX_CONCURRENT` / the memory_limit before
  raising the pod limit — pressure here is usually one heavy mart scan, and the freshness
  exporter + BFF both hammer serving during a refresh. Replicas are stateless: HPA min 2 means
  one death is a blip, not an outage.
- **Spark crons** — `sparkV4.driverMemory` in `infra/helm/cronworkflows/values*.yaml` (pinned
  via `--driver-memory`) must fit inside `sparkV4.resources.limits.memory` with ~25% native
  headroom. Prefer the data-side knobs FIRST: the adaptive batching envs
  (`SILVER_BATCH_TARGET_ROWS`, `SILVER_INCREMENTAL_OVERLAP_HOURS` — `iceberg_base.py`) exist
  precisely so jobs scale by bounding batch size, not by growing the heap. A job that OOMs
  only under `FULL_REFRESH=1` needs a temporarily larger one-off pod
  (see `rerun-medallion.md` §3), not a permanent bump.
- **kafka-connect** — heap via the chart's JVM opts / container limit; raising
  `iceberg.control.commit.interval-ms` reduces commit-time pressure at the cost of freshness
  (ADR-0010 ops notes).
- **Node-level** — if the sum of limits over-commits the node, fix scheduling (the batch pool
  nodeSelector exists for the Spark crons — AUD-PROD-006) rather than shrinking every limit.

## After mitigation

1. Verify serving: `/readyz` 200 on every duckdb-serving pod, `SELECT 1` through
   `POST /v1/query`, then a real `brain_serving.mv_*` read; BFF endpoints 200 again.
2. Verify freshness recovered: `brain_data_freshness_seconds` back under SLA (a serving outage
   also stalls the freshness exporter — expect a spike-then-recover).
3. Any memory-limit change is a values-file PR (GitOps) — never a live `kubectl edit`; note
   the OOM evidence (pod, timestamp, working-set graph) in the PR so limits stay
   evidence-based (OOM-budget discipline, `docs/ops/local-memory-budget.md`).
