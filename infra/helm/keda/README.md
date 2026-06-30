# KEDA — Brain workload autoscaling

Installs the **upstream KEDA operator** (`kedacore/keda`) into the `keda` namespace via ArgoCD:
`infra/argocd/envs/prod/keda.yaml` (multi-source: upstream chart `2.15.1` + this `values-prod.yaml`).

## Why this exists
The Trino chart **already emits** a KEDA `ScaledObject`
(`infra/helm/trino/templates/worker-scaledobject.yaml`, `apiVersion: keda.sh/v1alpha1`) that owns
Trino worker scaling when `workers.autoscaling.enabled=true`. That CRD and its controller are
provided **only** by installing KEDA — without this app the ScaledObject is an inert manifest.
KEDA is also the planned lag-based scaler for stream-worker backfill (blueprint K.2: scale-to-zero
on Kafka lag).

This app installs **only the operator** (controller + metrics-apiserver). Application
`ScaledObject`s ship with each workload's own chart, not here.

## What is NOT managed here
- No `ScaledObject`s (those live in the trino / stream-worker charts).
- The KEDA operator runs on the **fixed on-demand system node group** (control plane stability), not
  on Karpenter Spot capacity. See `infra/helm/karpenter/README.md`.

## IRSA the operator must add to `modules/eks/irsa`
- **None required today.** The current Trino `ScaledObject` uses a `cpu` trigger (reads
  metrics-server, no AWS API calls), so the KEDA operator needs no AWS IAM.
- **Add IRSA only when an AWS-backed scaler is introduced** — e.g. `aws-sqs-queue`,
  `aws-cloudwatch`, or MSK/Kafka with IAM auth. In that case create an IRSA role
  `brain-<env>-keda-operator` trusting the eks OIDC provider for
  `system:serviceaccount:keda:keda-operator`, scoped to the specific scaler's read permissions
  (`sqs:GetQueueAttributes`, `cloudwatch:GetMetricData`, `kafka-cluster:DescribeGroup` / `ReadData`,
  etc.), and set it under `serviceAccount.operator.annotations` in `values-prod.yaml`.

## Static verification
```
# values are plain YAML for the upstream chart (no local chart to lint here):
python3 -c "import yaml,sys; yaml.safe_load(open('infra/helm/keda/values-prod.yaml'))"
# render against the upstream chart (requires repo access):
helm template keda kedacore/keda --version 2.15.1 -n keda -f infra/helm/keda/values-prod.yaml
```
