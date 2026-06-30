# Brain – Aurora Serverless v2 (PostgreSQL) Module

Amazon Aurora **PostgreSQL**, Serverless v2 (`engine_mode = provisioned` +
`serverlessv2_scaling_configuration`). Auto-scales between `min_capacity` and
`max_capacity` ACU. Private subnets only, never publicly accessible, storage +
master-user-secret + Performance Insights encrypted with the shared KMS CMK.

This module is a drop-in alternative to `modules/rds` and intentionally mirrors
its conventions (naming `brain-{env}-postgres`, managed master-user secret,
35-day backups, prod deletion protection). It creates its **own** security group
(unlike `modules/rds`, which consumes `network.rds_sg_id`) and exposes it as the
`security_group_id` output.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `environment` | — | `dev` / `staging` / `prod` |
| `project` | `brain` | |
| `vpc_id` | — | VPC for the cluster + its SG |
| `subnet_ids` | — | **private** subnet ids only |
| `ingress_security_group_ids` | `[]` | source SGs allowed on 5432 (e.g. EKS nodes SG). Empty = locked down |
| `kms_key_arn` | — | existing KMS CMK ARN |
| `create` | `true` | EC10: set `false` for staging/prod to declare without creating |
| `engine_version` | `16.4` | **must** be an Aurora-supported PostgreSQL version |
| `min_capacity` | `0.5` | Serverless v2 min ACU |
| `max_capacity` | `2` | Serverless v2 max ACU |
| `instance_count` | `1` | number of `db.serverless` instances |

## Outputs

`endpoint` (writer), `reader_endpoint`, `port`, `security_group_id`.

## Operator usage block — paste into `envs/prod/*.tf`

> This module is **authoring-only** and is NOT wired into any env. To adopt it,
> paste the block below into the prod root (e.g. a new `envs/prod/main.tf`).
> It assumes `module.network`, `module.kms`, and `local.{project,environment}`
> already exist in that root (same as the dev root).

```hcl
###############################################################################
# Aurora Serverless v2 (PostgreSQL)
# EC10: declared for prod; flip create=true when migrating off modules/rds.
###############################################################################
module "aurora" {
  source      = "../../modules/aurora"
  environment = local.environment
  project     = local.project

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids

  # Allow the EKS node group to reach Postgres on 5432
  ingress_security_group_ids = [module.network.eks_nodes_sg_id]

  kms_key_arn = module.kms.root_kms_key_arn

  # Serverless v2 ACU band (cost vs headroom)
  min_capacity = 0.5
  max_capacity = 2

  create = true
}

output "aurora_endpoint" { value = module.aurora.endpoint }
output "aurora_reader_endpoint" { value = module.aurora.reader_endpoint }
```

## Cost note

Aurora Serverless v2 bills per **ACU-hour** (1 ACU ≈ 2 GiB RAM + matching CPU).
In `ap-south-1` an ACU-hour is ~$0.12. A single instance held at the **0.5 ACU
floor** 24×7 ≈ 0.5 × $0.12 × 730 h ≈ **~$45/mo**; scaled to the **2 ACU ceiling**
continuously ≈ **~$175/mo**. Real cost lands between those two bounds based on
load, plus storage (~$0.10/GB-mo), I/O, and backup storage beyond the cluster
size. The 0.5 floor means it never scales to zero — for true scale-to-zero you
must adopt Serverless v2 auto-pause (`min_capacity = 0`, newer engine versions)
which this module does not enable by default.

## RDS → Aurora migration implication

`modules/rds` (single `aws_db_instance`, `engine = postgres`) and this module
(`aws_rds_cluster` + `aws_rds_cluster_instance`, `engine = aurora-postgresql`)
are **different engines** — there is no in-place Terraform conversion. Both use
identifier `brain-{env}-postgres`, so they **cannot coexist** in the same env;
adopting Aurora means retiring the `module.rds` block.

Migration path:
1. **Snapshot + restore is NOT cross-engine.** A standard RDS-for-PostgreSQL
   snapshot cannot be restored directly into an Aurora cluster via this engine
   pair without the Aurora "restore-from-RDS-snapshot" flow (AWS migrates the
   snapshot into a new Aurora cluster). Plan for that one-way migration, or use
   `pg_dump`/`pg_restore`, or DMS for near-zero-downtime cutover.
2. **Endpoint change:** apps move from the single RDS endpoint to the Aurora
   **writer** endpoint (writes) and **reader** endpoint (read replicas). Update
   the connection secret/`DATABASE_URL` accordingly.
3. **Sequencing:** stand Aurora up alongside RDS first (temporarily change one
   `cluster_identifier`/`identifier` to avoid the name clash, or run in a
   migration window), cut traffic over, verify, then remove `module.rds`.
4. **Rollback:** keep the final RDS snapshot (`skip_final_snapshot = false` is
   set on both) so you can restore the previous engine if cutover fails.
