# EKS 1.32 → 1.33 upgrade (AUD-OPS-028, prereq AUD-INFRA-019)

**Why:** brain-prod was provisioned directly onto k8s 1.32, which already bills
EXTENDED support: `$12/day extendedSupport + $2.40/day base ≈ $432/mo` — 86% of
the $500/mo target. Upgrading to a standard-support version removes **$360/mo**.

**State (verified 2026-07-12):** cluster 1.32 `supportType=EXTENDED`; system MNG
`brain-prod-system` on `AL2_ARM_64` (release 1.32.9, 20 GB gp2 roots). AL2 EKS
AMIs **end at 1.32** — the MNG must move to AL2023 *before* the control-plane
bump or 1.33 node creation fails. Karpenter nodes are already AL2023
(`amiSelectorTerms alias: al2023@latest`) and follow the control-plane version
automatically via drift.

All three gates default to the live values in
`infra/terraform/envs/prod/{variables.tf,terraform.tfvars}` — an un-flipped plan
is a **no-op**.

## Pre-flight (read-only)

1. Wave-2 PDBs are in place (per audit M3.1 sequencing) — check
   `kubectl get pdb -A`.
2. No deprecated API usage blocking 1.33:
   `aws eks list-insights --cluster-name brain-prod --region ap-south-1` (all
   insights PASSING).
3. Healthy baseline: `kubectl get nodes`, `kubectl get pods -A | grep -v Running`,
   ArgoCD apps green.
4. Add-on compatibility for 1.33: the EBS CSI add-on version is data-source
   driven (`most_recent` for the cluster version — reconverges automatically);
   CoreDNS/kube-proxy/VPC-CNI are EKS defaults — check
   `aws eks describe-addon-versions --kubernetes-version 1.33` for anything
   pinned out-of-band.

## Step 1 — system MNG → AL2023 (+ gp3 roots), still on 1.32

In `infra/terraform/envs/prod/terraform.tfvars` uncomment:

```hcl
system_ami_type = "AL2023_ARM_64_STANDARD"
```

Plan shows: **create** `brain-prod-system-al2023` MNG (AL2023, launch template
with encrypted 20 GiB gp3 roots, IMDSv2) **before destroying** the AL2 group
(create-before-destroy via the name change). Apply via the normal
`prod-apply.yml` lane.

Verify: new nodes Ready with the AL2023 AMI
(`kubectl get nodes -L eks.amazonaws.com/nodegroup -o wide`), CoreDNS /
Karpenter controller / ArgoCD rescheduled and healthy, old MNG gone.

## Step 2 — control plane → 1.33 + MNG rolling upgrade

Uncomment:

```hcl
cluster_version = "1.33"
```

Plan shows: cluster `version` update (in-place, ~10-15 min, API briefly
disruptive but workloads keep running) then the MNG `version` update (in-place
rolling node replacement, `max_unavailable = 1`). The EBS CSI add-on version
data source reconverges on the 1.33-latest build in the same plan.

After apply: Karpenter drift detects the version skew and rolls its nodes onto
1.33 AL2023 AMIs automatically (`al2023@latest` alias) — expect a rolling
replacement of streaming/batch/trino/ondemand nodes; the Wave-2 PDBs bound the
disruption. Watch `kubectl get nodeclaims -w`.

Verify: `aws eks describe-cluster --name brain-prod --query cluster.version` →
`1.33`; all nodes `v1.33.x`; serving (Trino), Kafka Connect landing, and the
Spark crons green.

## Step 3 — pin STANDARD support (fail-fast guard)

Only possible once the running version is inside standard support:

```hcl
eks_support_type = "STANDARD"
```

Plan shows one in-place `upgrade_policy` update. With STANDARD, a future lapse
past end-of-standard-support **blocks** instead of silently billing $12/day.

## Verification of the saving

Cost Explorer, USAGE_TYPE daily: `APS3-AmazonEKS-Hours:extendedSupport` line
disappears (allow ~24-48h); control-plane cost drops to `perCluster` $2.40/day.

## Rollback

- Step 1 is reversible (re-comment → plan recreates the AL2 group) **until**
  step 2 is applied; after 1.33 there is no AL2 AMI to go back to.
- EKS control-plane upgrades are **not** downgradable — rollback for step 2 is
  restore-from-backups only (never needed for a minor bump; hence the staged,
  verify-between-steps sequence).
- Step 3 is an in-place toggle back to `null`/EXTENDED.
