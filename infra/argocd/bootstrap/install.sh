#!/usr/bin/env bash
################################################################################
# Brain – one-time GitOps bootstrap (AUD-COST-005)
#
# The chicken-and-egg installs that nothing else can GitOps: ArgoCD itself,
# then the AppProjects every Application references (ArgoCD refuses to sync an
# Application whose project doesn't exist), then the env root app-of-apps.
# Everything AFTER this — including the Argo Workflows controller + CronWorkflow
# CRDs (envs/<env>/argo-workflows.yaml) — is an ArgoCD Application synced from
# the repo.
#
# Prereqs: kubectl context pointed at the target EKS cluster (see AUD-COST-009 —
# eks_public_access_cidrs opens the endpoint for this bootstrap window), helm 3.
#
# Usage:  infra/argocd/bootstrap/install.sh <prod|staging>
#
# Bring-up order after this script (prod apps are MANUAL-sync — sync in waves):
#   argo-workflows (wave -2, CronWorkflow CRDs) → strimzi operator/kafka →
#   external-secrets + config (secrets before workloads) → platform add-ons
#   (karpenter, keda, alb-controller, cert-manager) → app charts. See
#   docs/runbooks/prod-m4-turn-on.md.
################################################################################
set -euo pipefail

ENVIRONMENT="${1:?usage: install.sh <prod|staging>}"
case "${ENVIRONMENT}" in prod | staging) ;; *)
  echo "unknown environment '${ENVIRONMENT}' (want prod|staging)" >&2
  exit 1
  ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pinned argo-cd chart (upgrade deliberately, not implicitly).
ARGOCD_CHART_VERSION="${ARGOCD_CHART_VERSION:-7.7.11}"

echo "[bootstrap] helm install argo-cd ${ARGOCD_CHART_VERSION} → namespace argocd"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null
helm repo update argo >/dev/null
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace \
  --version "${ARGOCD_CHART_VERSION}" \
  --wait --timeout 10m

echo "[bootstrap] AppProjects (brain / brain-prod / brain-staging)"
kubectl apply -f "${SCRIPT_DIR}/appprojects.yaml"

# AUD-COST-018: the gp3 StorageClass every PVC-bearing chart names (Neo4j —
# the identity SoR — binds its data PVC through it). The EBS CSI driver add-on
# itself is terraform (modules/eks aws_eks_addon.ebs_csi); a StorageClass is
# cluster-bootstrap state like the AppProjects, so it is applied here.
echo "[bootstrap] gp3 StorageClass (EBS CSI)"
kubectl apply -f "${SCRIPT_DIR}/gp3-storageclass.yaml"

if [ "${ENVIRONMENT}" = "prod" ]; then
  echo "[bootstrap] root app-of-apps (prod)"
  kubectl apply -f "${SCRIPT_DIR}/../app-of-apps.yaml"
else
  echo "[bootstrap] root app-of-apps (staging)"
  kubectl apply -f "${SCRIPT_DIR}/root-app-staging.yaml"
fi

echo "[bootstrap] done — initial admin password:"
echo "  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
