# EKS API access — operator paths + private-only close-out (AUD-INFRA-008a)

**Current posture (deliberate, AUD-COST-009):** the `brain-prod` EKS API
endpoint is public **pinned to a single operator /32**
(`eks_public_access_cidrs` in `infra/terraform/envs/prod/terraform.tfvars`)
with private access also enabled. Good exposure posture, fragile operations:
an ISP IP rotation kills ALL kubectl access until the allowlist is re-applied
(this already bit a prior session). This runbook covers (A) the fast allowlist
refresh, (B) the SSM port-forward path that works with a **private-only**
endpoint, and (C) the private-only close-out itself.

## A. Allowlist refresh (public endpoint, IP rotated)

1. Get your current egress IP: `curl -s https://checkip.amazonaws.com`.
2. Edit `infra/terraform/envs/prod/terraform.tfvars`:
   `eks_public_access_cidrs = ["<new-ip>/32"]` — commit it (the file is
   TRACKED; see the AUD-INFRA-008c header note in the file).
3. Apply via the normal envs/prod terraform lane. **ORDERING GUARD:** if any
   one-shot `imports-aud-infra-*.tf` file still exists, that import apply must
   come first (see the header of each file). Review the plan: the only change
   should be `module.eks.aws_eks_cluster.main` `vpc_config.public_access_cidrs`
   (in-place).
4. `aws eks update-kubeconfig --region ap-south-1 --name brain-prod` and verify
   `kubectl get nodes`.

Faster break-glass (console/CLI, bring terraform in line afterwards or the
next apply reverts it):
`aws eks update-cluster-config --region ap-south-1 --name brain-prod --resources-vpc-config publicAccessCidrs=<new-ip>/32`.

## B. SSM port-forward path (works private-only — the fallback and the future default)

**VERIFIED WORKING end-to-end 2026-07-13** (kubectl get nodes via the tunnel).
This path does NOT depend on the operator's public IP, so an ISP rotation
never blocks it. **This is the permanent answer to the recurring IP-allowlist
pain — prefer it over Path A.**

**Preconditions (all satisfied on brain-prod):**

- The node role has `AmazonSSMManagedInstanceCore`
  (`modules/eks` `node_AmazonSSMManagedInstanceCore` — AUD-INFRA-008a; already
  applied). The EKS-optimized AMIs ship the SSM agent, and agent egress rides
  the fck-nat instance — no extra VPC endpoints needed. Confirm with
  `aws ssm describe-instance-information` (nodes show `Online`).
- Your IAM principal can `ssm:StartSession`.
- `session-manager-plugin` on PATH. If missing, install WITHOUT sudo:
  ```sh
  curl -sL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/sessionmanager-bundle.zip" -o /tmp/smp.zip
  ( cd /tmp && unzip -o -q smp.zip )
  mkdir -p ~/.local/bin && cp /tmp/sessionmanager-bundle/bin/session-manager-plugin ~/.local/bin/
  # then ensure ~/.local/bin (or a symlink into an on-PATH dir) resolves it.
  ```

**One command (preferred):**

```sh
tools/ops/eks-ssm-tunnel.sh      # installs the plugin if needed, opens the
                                 # tunnel, configures the kubeconfig context,
                                 # holds foreground (Ctrl-C to stop)
# in another shell:
kubectl --context brain-prod-ssm get nodes
```

**Manual equivalent (what the script does):**

```sh
EP=$(aws eks describe-cluster --region ap-south-1 --name brain-prod \
      --query 'cluster.endpoint' --output text | sed 's#https://##')
IID=$(aws ssm describe-instance-information --region ap-south-1 \
      --query 'InstanceInformationList[?PingStatus==`Online`]|[0].InstanceId' --output text)

# Tunnel localhost:8443 → the private endpoint through the node:
aws ssm start-session --region ap-south-1 --target "$IID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="$EP",portNumber="443",localPortNumber="8443" &

# Dedicated context — --tls-server-name presents the cert's real hostname for
# TLS (SANs include $EP, not localhost) so NO /etc/hosts + sudo edit is needed:
kubectl config view --raw \
  -o jsonpath='{.clusters[?(@.name=="arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod")].cluster.certificate-authority-data}' \
  | base64 -d > /tmp/eks_ca.crt
kubectl config set-cluster brain-prod-ssm --server="https://127.0.0.1:8443" \
  --tls-server-name="$EP" --certificate-authority=/tmp/eks_ca.crt --embed-certs=true
kubectl config set-context brain-prod-ssm --cluster=brain-prod-ssm \
  --user="arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod"
kubectl --context brain-prod-ssm get nodes    # verify
```

Cleanup: kill the SSM session (Ctrl-C / kill the `aws ssm start-session` PID).
The `brain-prod-ssm` context is harmless to keep — it only works while a tunnel
is open. The default (public-endpoint) context is untouched.

## C. Private-only close-out (APPLY DECISION — do not rush)

Only after **B is verified end-to-end from the operator machine**:

1. Set `eks_public_access_cidrs = []` in envs/prod `terraform.tfvars`.
2. Plan/apply — the endpoint flips to private-only (`endpoint_public_access`
   becomes false; the module handles it, `modules/eks` AUD-COST-009 block).
3. Immediately re-verify path B still works (it is now the ONLY path).
4. ArgoCD/argo-workflows UI access is unchanged (in-cluster port-forwards ride
   the same kubectl tunnel).

**Do NOT flip to `[]` in the same change that adds the SSM policy** — if the
policy apply fails you are locked out with no path back except the AWS console
`update-cluster-config` break-glass above.
