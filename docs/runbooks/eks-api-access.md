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

**Preconditions (one-time):**

- The node role has `AmazonSSMManagedInstanceCore`
  (`modules/eks` `node_AmazonSSMManagedInstanceCore` — AUD-INFRA-008a; needs
  one envs/prod apply). The EKS-optimized AL2 AMIs already ship the SSM agent,
  and agent egress rides the fck-nat instance — no extra VPC endpoints needed.
- Your IAM principal can `ssm:StartSession` (and the Session Manager plugin is
  installed locally: `session-manager-plugin --version`).

**Session:**

```sh
# 1. The private API endpoint host (no scheme) + a system node instance id:
EP=$(aws eks describe-cluster --region ap-south-1 --name brain-prod \
      --query 'cluster.endpoint' --output text | sed 's#https://##')
IID=$(aws ec2 describe-instances --region ap-south-1 \
      --filters "Name=tag:eks:nodegroup-name,Values=brain-prod-system" \
                "Name=instance-state-name,Values=running" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)

# 2. Port-forward localhost:8443 → the private endpoint through the node:
aws ssm start-session --region ap-south-1 --target "$IID" \
  --document-name AWS-StartPortForwardingSessionToRemoteSocket \
  --parameters host="$EP",portNumber="443",localPortNumber="8443"

# 3. In another shell — kubectl must present the endpoint HOSTNAME for TLS
#    (the API server cert's SANs include it, not localhost):
sudo sh -c "echo '127.0.0.1 $EP' >> /etc/hosts"      # remove when done
aws eks update-kubeconfig --region ap-south-1 --name brain-prod
kubectl config set-cluster "arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod" \
  --server "https://$EP:8443"
kubectl get nodes    # verify
```

Cleanup: kill the session, remove the `/etc/hosts` line, and
`kubectl config set-cluster … --server "https://$EP"` (default 443) if you
keep the kubeconfig.

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
