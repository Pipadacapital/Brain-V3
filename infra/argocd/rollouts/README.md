# Argo Rollouts — automated bake-window auto-rollback (B6 / R-06)

Today the prod bake window is **manual**: `deploy.yml` echoes the rollback criteria and a human watches a
Grafana dashboard for 30 min (2h for billing/ledger changes). This directory makes the rollback
**automatic** via [Argo Rollouts](https://argoproj.github.io/rollouts/) analysis.

## What's here

| File | What it is |
|------|------------|
| `analysis-templates.yaml` | `AnalysisTemplate`s encoding the bake-window SLOs as Prometheus queries — `collector-accept-ack-slo` (≥99.95% accept+ack) and `ingest-freshness` (Bronze writes flowing). Grounded in the real C2 metrics. The Analytics-API RED template is included **disabled** pending OTel HTTP instrumentation. |
| `collector-rollout.yaml` | A **reference** `Rollout` (collector) whose canary runs the analysis and auto-aborts → rolls back to the last stable ReplicaSet on a breach. |

## How auto-rollback works

The canary holds new code at a low traffic weight while the `AnalysisTemplate`s probe Prometheus. If the
accept+ack rate dips below 99.95% (or Bronze writes stop) within the bake window, the analysis fails, the
Rollout aborts, and Argo restores the previous ReplicaSet — no human in the loop. The K8s readiness rule
(2 consecutive `/readyz` failures) is the `readinessProbe.failureThreshold`.

## Prerequisites / promotion path (cluster-in-the-loop)

1. **Install the Argo Rollouts controller** in the cluster (Helm `argo/argo-rollouts`).
2. **Apply the AnalysisTemplates** (add this dir to the ArgoCD app-of-apps), injecting `PROMETHEUS_ADDRESS`
   (in-cluster Prometheus or the Grafana Cloud Mimir query endpoint).
3. **Convert `infra/helm/collector`'s `Deployment` → this `Rollout`** and validate progressive traffic
   shifting + a forced-failure rollback on a real cluster. Then extend the same pattern to
   core / stream-worker / web.

These manifests are **not yet wired into the live charts** — converting a `Deployment` to a `Rollout`
is a deploy-mechanics change that must be proven against a cluster before it gates prod. The
cross-brand-isolation "immediate rollback" signal stays enforced by the isolation-fuzz CI gate + a
runtime alert (it is not a single Prometheus gauge), not by this rollout analysis.
