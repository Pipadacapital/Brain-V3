export const meta = {
  name: 'wave1-parallel-prep',
  description: 'Wave-1 prod-functional prep: parallel GitOps file edits + ArgoCD drift recon',
  phases: [
    { title: 'Prep', detail: '3 manifest edits + drift safety recon, in parallel' },
  ],
}

const REPO = '/Users/rishabhporwal/Desktop/Brain V3'

phase('Prep')
const [metricsServer, alb, strimzi, driftRecon] = await parallel([
  () => agent(`In the repo ${REPO}: create a NEW file infra/argocd/envs/prod/metrics-server.yaml — an ArgoCD Application that installs the upstream metrics-server Helm chart into prod. CONTEXT: the cluster brain-prod (EKS 1.32) has NO metrics-server, so every HPA reports <unknown> and autoscaling is dead (audit finding AUD-LIVE-1). The root app-of-apps auto-syncs infra/argocd/envs/prod/, so this file becoming ArgoCD reality only needs a merge.

REQUIREMENTS (follow existing house style — read infra/argocd/envs/prod/keda.yaml and aws-load-balancer-controller.yaml first and mirror their header-comment style, labels, project: brain-prod, destination server):
1. Chart source: repoURL https://kubernetes-sigs.github.io/metrics-server, chart metrics-server. Pin targetRevision to the LATEST stable version — fetch https://kubernetes-sigs.github.io/metrics-server/index.yaml (curl) and use the newest non-prerelease chart version you see there.
2. namespace kube-system, inline helm valuesObject (like aws-load-balancer-controller.yaml does): replicas: 2, nodeSelector role: system (metrics feed HPAs — must not sit on Spot), modest resources (requests 50m/64Mi, limits 200m/128Mi), and the standard EKS-safe defaults (no --kubelet-insecure-tls needed on EKS).
3. syncPolicy: automated (prune true, selfHeal true) — justify in the header comment: HPAs are dead without it, so it must self-heal like external-secrets; plus syncOptions ServerSideApply=true.
4. sync-wave "0" annotation, labels project: brain / environment: prod / service: metrics-server.
DO NOT run git commit — file creation only. Return: the chart version you pinned and the full file path. Keep the file consistent with the repo's comment conventions.`, { label: 'edit:metrics-server', phase: 'Prep', model: 'fable' }),

  () => agent(`In the repo ${REPO}: edit infra/argocd/envs/prod/aws-load-balancer-controller.yaml to stop the permanent benign ArgoCD drift (audit AUD-LIVE-5). CONTEXT: the app is OutOfSync on exactly 3 resources — Secret aws-load-balancer-tls, MutatingWebhookConfiguration aws-load-balancer-webhook, ValidatingWebhookConfiguration aws-load-balancer-webhook — because the upstream chart generates a fresh self-signed webhook cert on every render (well-known helm/ArgoCD issue).

CHANGE: add to the Application spec:
1. ignoreDifferences entries: (a) group admissionregistration.k8s.io kind MutatingWebhookConfiguration name aws-load-balancer-webhook with jqPathExpressions ['.webhooks[].clientConfig.caBundle']; (b) same for ValidatingWebhookConfiguration; (c) kind Secret name aws-load-balancer-tls namespace kube-system with jsonPointers ['/data'].
2. Under syncPolicy.syncOptions add '- RespectIgnoreDifferences=true' (so a future sync does not clobber the live cert).
3. Add a short comment above ignoreDifferences explaining WHY (helm-generated self-signed webhook cert regenerates every render → eternal false drift; live cert is authoritative).
Read the file first; preserve everything else exactly. DO NOT git commit. Return a summary of the exact YAML you added.`, { label: 'edit:alb-ignorediff', phase: 'Prep', model: 'fable' }),

  () => agent(`In the repo ${REPO}: edit infra/helm/strimzi-kafka/templates/kafka-cr.yaml to stop ArgoCD tracking the Strimzi-operator-created Kafka data PVCs as prune candidates (audit AUD-LIVE-5 — DANGEROUS drift: data-0-brain-prod-kafka-combined-{0,1,2} show OutOfSync; a prune-sync would DELETE Kafka's data volumes).

CONTEXT: the KafkaNodePool template block already has a 'template:' section with 'persistentVolumeClaim:' (around line 44-60 — read the file first to see the exact structure). Strimzi propagates 'template.persistentVolumeClaim.metadata' onto the PVCs it creates.

CHANGE: under the KafkaNodePool's template.persistentVolumeClaim, ensure metadata.annotations includes:
  argocd.argoproj.io/compare-options: IgnoreExtraneous
  argocd.argoproj.io/sync-options: Prune=false,Delete=false
(merge with any existing metadata under persistentVolumeClaim — do not remove existing keys). If there are MULTIPLE template blocks that produce PVCs (check the whole file, all node pools / kafka + controller pools), annotate each. Add a one-line comment explaining: operator-created PVCs inherit ArgoCD tracking labels → without this they show as eternal OutOfSync prune candidates and a prune would destroy broker data.
Then run: helm template test ${REPO}/infra/helm/strimzi-kafka -f ${REPO}/infra/helm/strimzi-kafka/values-prod.yaml 2>&1 | head -80 — and confirm the annotations render inside the KafkaNodePool CR and the chart still renders without error. DO NOT git commit. Return: what you changed + render-check result.`, { label: 'edit:strimzi-pvc', phase: 'Prep', model: 'fable' }),

  () => agent(`READ-ONLY recon against the live prod EKS cluster (kubectl context arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod) and the repo ${REPO}. Three ArgoCD apps have legitimate git-vs-live drift and we plan to SYNC them; determine exactly what a sync would change and whether it is safe. Use ONLY read-only commands (kubectl get/describe -o yaml, helm template on repo charts, diff). Do NOT mutate anything, do NOT kubectl exec.

1. neo4j-prod: app sources = upstream chart neo4j 5.26.0 (helm.neo4j.com) + values from infra/helm/neo4j/values-prod.yaml. The live StatefulSet 'neo4j' in ns neo4j is OutOfSync. Get the live STS spec (kubectl get sts -n neo4j neo4j -o yaml), render the desired one if possible (helm repo may not be configured — if 'helm template' with the upstream repo fails, instead diff the live STS's image/nodeSelector/tolerations/resources/env against what infra/helm/neo4j/values-prod.yaml specifies). Report the EXACT fields that differ and whether syncing would trigger a pod restart of neo4j-0 (identity SoR — brief downtime acceptable but must be flagged).
2. kube-prometheus-stack-prod: only PrometheusRule 'kube-prometheus-stack-brain-slo' is OutOfSync. Get the live rule (kubectl get prometheusrule -n monitoring kube-prometheus-stack-brain-slo -o yaml | head -100) and compare its rule group names/alert names against the additionalPrometheusRulesMap in infra/helm/kube-prometheus-stack/values-prod.yaml. Report which alerts would be added/changed by a sync.
3. external-secrets-config-prod: 8 ExternalSecret resources OutOfSync in their namespaces (core-env, collector-env, stream-worker-env, web-env, pgbouncer-env, neo4j-auth, iceberg-rest-catalog-db). Pick two (core-env in ns core, stream-worker-env in ns stream-worker), get live spec, render the chart (helm template ${REPO}/infra/helm/external-secrets-config -f ${REPO}/infra/helm/external-secrets-config/values-prod.yaml) and report the spec fields that differ (e.g. refreshInterval, data keys added/removed). Flag if a sync would REMOVE any secret key a running pod consumes (check deployment envFrom).
Return a per-app verdict: SAFE-TO-SYNC / SYNC-WITH-RESTART / DO-NOT-SYNC, with the field-level evidence.`, { label: 'recon:drift-safety', phase: 'Prep', model: 'fable' }),
])

return { metricsServer, alb, strimzi, driftRecon }