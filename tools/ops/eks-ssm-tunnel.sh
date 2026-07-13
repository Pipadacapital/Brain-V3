#!/usr/bin/env bash
# eks-ssm-tunnel.sh — IP-INDEPENDENT kubectl access to brain-prod via SSM.
#
# WHY: the EKS API endpoint is (optionally) pinned to a single operator /32
# (eks_public_access_cidrs). An ISP IP rotation kills all kubectl access until
# a terraform apply re-adds the new IP — a recurring operational pain. This
# path does NOT depend on the operator's public IP at all: it opens an AWS SSM
# port-forward through an SSM-managed cluster node to the (private) EKS API
# endpoint, and points a dedicated kubeconfig context at the local tunnel.
# SSM authenticates via your IAM principal, so it works from any network and
# even when the endpoint is PRIVATE-ONLY (eks_public_access_cidrs = []).
#
# PRECONDITIONS (already satisfied on brain-prod — see docs/runbooks/eks-api-access.md):
#   - node role has AmazonSSMManagedInstanceCore (modules/eks) — nodes show
#     "Online" in `aws ssm describe-instance-information`.
#   - your IAM principal can ssm:StartSession.
#   - session-manager-plugin on PATH (this script installs it to ~/.local/bin
#     without sudo if missing).
#
# USAGE:
#   tools/ops/eks-ssm-tunnel.sh            # start tunnel + configure context, then FOREGROUND-hold
#   KUBECONTEXT=brain-prod-ssm kubectl ... # in another shell, OR: kubectl --context brain-prod-ssm ...
#   Ctrl-C to tear the tunnel down.
#
# The context name is stable (brain-prod-ssm), so once this has run you just
# keep using `kubectl --context brain-prod-ssm ...` for the life of the tunnel.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
CLUSTER="${EKS_CLUSTER:-brain-prod}"
LOCAL_PORT="${LOCAL_PORT:-8443}"
CONTEXT="brain-prod-ssm"
ACCOUNT="${AWS_ACCOUNT:-380254378136}"
CLUSTER_ARN="arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${CLUSTER}"

log() { printf '\033[36m[eks-ssm]\033[0m %s\n' "$*" >&2; }

# ── 0. session-manager-plugin (no-sudo install to ~/.local/bin if missing) ──────
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  log "session-manager-plugin not found — installing to ~/.local/bin (no sudo)…"
  arch="$(uname -m)"; case "$arch" in arm64|aarch64) sub=mac_arm64;; *) sub=mac;; esac
  tmp="$(mktemp -d)"
  curl -sL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${sub}/sessionmanager-bundle.zip" -o "$tmp/smp.zip"
  ( cd "$tmp" && unzip -o -q smp.zip )
  mkdir -p "$HOME/.local/bin"
  cp "$tmp/sessionmanager-bundle/bin/session-manager-plugin" "$HOME/.local/bin/"
  chmod +x "$HOME/.local/bin/session-manager-plugin"
  export PATH="$HOME/.local/bin:$PATH"
  command -v session-manager-plugin >/dev/null 2>&1 || { log "install failed — add ~/.local/bin to PATH"; exit 1; }
  log "installed $(session-manager-plugin --version)"
fi

# ── 1. resolve the private API endpoint host + an Online SSM node as the jump ───
EP="$(aws eks describe-cluster --region "$REGION" --name "$CLUSTER" --query 'cluster.endpoint' --output text | sed 's#https://##')"
# Project InstanceId FIRST then take [0]; `| head -1` is a belt-and-suspenders guard so IID is
# ALWAYS a single token (a multi-line value fails SSM's --target regex, which forbids newlines).
IID="$(aws ssm describe-instance-information --region "$REGION" \
        --query 'InstanceInformationList[?PingStatus==`Online`].InstanceId | [0]' --output text | head -1)"
[ -n "$EP" ] && [ "$IID" != "None" ] && [ -n "$IID" ] || { log "no endpoint or no Online SSM node"; exit 1; }
log "endpoint=$EP  jump-node=$IID  local=127.0.0.1:${LOCAL_PORT}"

# ── 2. kubeconfig context pinned to the tunnel (CA reused, SNI overridden) ──────
# --tls-server-name presents the API cert's real hostname for TLS verification
# WITHOUT editing /etc/hosts (the cert SANs include $EP, not localhost).
CA="$(mktemp)"
kubectl config view --raw -o jsonpath="{.clusters[?(@.name==\"$CLUSTER_ARN\")].cluster.certificate-authority-data}" | base64 -d > "$CA"
[ -s "$CA" ] || { log "could not read cluster CA from kubeconfig — run: aws eks update-kubeconfig --region $REGION --name $CLUSTER"; exit 1; }
kubectl config set-cluster "$CONTEXT" --server="https://127.0.0.1:${LOCAL_PORT}" \
  --tls-server-name="$EP" --certificate-authority="$CA" --embed-certs=true >/dev/null
kubectl config set-context "$CONTEXT" --cluster="$CONTEXT" --user="$CLUSTER_ARN" >/dev/null
rm -f "$CA"
log "kubeconfig context '$CONTEXT' ready → use:  kubectl --context $CONTEXT get nodes"

# ── 3. hold the port-forward in the foreground (Ctrl-C tears it down) ───────────
log "opening SSM port-forward (Ctrl-C to stop)…"
exec aws ssm start-session --region "$REGION" --target "$IID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="$EP",portNumber="443",localPortNumber="${LOCAL_PORT}"
