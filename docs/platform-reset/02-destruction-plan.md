# Brain Platform — Destruction Plan (DOCUMENT ONLY — NOTHING WILL BE DELETED)

- **Account:** 380254378136 (PAID PRODUCTION)
- **Primary region:** ap-south-1 (Mumbai) · **Global-service sweep:** us-east-1 = CLEAN (no CloudFront, no us-east-1 ACM/logs/secrets/EBS)
- **Domain:** brain.pipadacapital.com
- **Authored:** 2026-07-14 · **Source:** synthesis of all `docs/platform-reset/inventory/*.md` (read-only AWS + k8s inventory)
- **Status:** PLAN ONLY. No AWS or Kubernetes mutation has been or will be performed by this document. Execution requires explicit owner GO (see banner at end).

> **Honest architecture note.** The live design is already lean and sound — Karpenter Spot-first, a small on-demand system node group, Aurora Serverless v2 (0.5–2.0 ACU), a `t4g.nano` fck-nat instead of a managed NAT GW, S3 gateway + ECR interface endpoints, a single shared ALB, Valkey single-node cache, tight S3 lifecycle rules, gp3 (not io2) everywhere. This is a *teardown* plan for that lean estate, not a remediation of invented debt.

---

## 1. Consolidated Inventory (all domains)

Cost = estimated steady-state USD/month, ap-south-1 list prices, Spot ≈ 40% of on-demand. "Brain?" = provisioned for the Brain platform.

### 1.1 Compute & Networking
| Resource | Type | Region | ID / ARN (short) | Brain? | Est $/mo |
|---|---|---|---|---|---|
| `brain-prod` | EKS control plane (v1.33) | ap-south-1 | `…:cluster/brain-prod` | Y | 73 |
| `brain-prod-system-al2023` | EKS managed node group (3× t4g.medium OD) | ap-south-1 | ASG `eks-brain-prod-system-al2023-b0cfab4c…` | Y | 74 |
| Karpenter nodes (7) | EC2 (streaming/trino/ondemand pools) | ap-south-1 | i-047834…,i-0c7526…,i-0567…,i-05f0…,i-0d1e…,i-0aa5…,i-0128… | Y | 294 (OD) + 120 (spot) |
| `brain-prod-nat` | EC2 fck-nat (t4g.nano) | ap-south-1 | `i-02c6bfc90eaa4f649` | Y | 3 |
| ALB | elbv2 (internet-facing) | ap-south-1 | `…:loadbalancer/app/k8s-brainprod-09e4b2bc81/4b2a27513e117bf3` | Y | 22 |
| Target groups (3) | elbv2 TG | ap-south-1 | `k8s-collecto…`, `k8s-core…`, `k8s-web…` | Y | 0 |
| ECR interface endpoints (2) | VPC endpoint | ap-south-1 | `vpce-0814e69de440fa22b`, `vpce-05461bba6178431c5` | Y | 14 |
| S3 gateway endpoint | VPC endpoint | ap-south-1 | `vpce-0080885717b122d4c` | Y | 0 |
| VPC `brain-prod` | VPC 10.0.0.0/16 | ap-south-1 | `vpc-06ded56ae87bd2b68` | Y | 0 |
| Subnets (6) / RT (3) / IGW / NACL | networking fabric | ap-south-1 | `igw-04cebac1a6c59dcdb`, `rtb-07dea19e2bc0f8e18`(private) | Y | 0 |
| EIPs (4, all attached) | EIP | ap-south-1 | 3× ALB ENI + `eipalloc-0e91eabfae479a6b4`(NAT) | Y | 0 (attached) |
| Security groups (11) | SG | ap-south-1 | aurora/rds/elasticache/eks/nat/vpce/alb/nodes | Y | 0 |
| SQS `brain-prod` | SQS (Karpenter interruption) | ap-south-1 | `…:sqs:ap-south-1:…:brain-prod` | Y | ~0 |
| Default VPC (unused) | VPC 172.31/16 | ap-south-1 | `vpc-09eccb21d72404ce4` | **N** | 0 |

### 1.2 Databases, Caches & Backups
| Resource | Type | Region | ID / ARN (short) | Brain? | Est $/mo |
|---|---|---|---|---|---|
| `brain-prod-postgres` | Aurora PostgreSQL Serverless v2 (cluster) | ap-south-1 | `…:cluster:brain-prod-postgres` | Y | 50–95 |
| `brain-prod-postgres-1` | Aurora writer instance (db.serverless) | ap-south-1 | `…:db:brain-prod-postgres-1` | Y | (in cluster) |
| 7× `rds:brain-prod-postgres-*` | Aurora automated snapshots | ap-south-1 | daily 07-08→07-14 | Y | 1–5 |
| `brain-prod-aurora` / `brain-prod-aurora-postgres16` | RDS subnet + cluster param group | ap-south-1 | — | Y | 0 |
| `brain-prod-redis` | ElastiCache Valkey 8.0.1 (cache.t4g.micro) | ap-south-1 | `…:replicationgroup:brain-prod-redis` | Y | 12–14 |
| 7× `automatic.brain-prod-redis-001-*` | ElastiCache auto snapshots | ap-south-1 | daily 07-08→07-14 | Y | ~0 |
| `brain-prod-redis-pre-valkey` | ElastiCache **manual** snapshot | ap-south-1 | pre-Valkey safety copy | Y | ~0 |
| `brain-prod-redis` | ElastiCache subnet group | ap-south-1 | — | Y | 0 |
| `brain-tfstate-lock-prod` | DynamoDB (TF state lock) | ap-south-1 | `…:table/brain-tfstate-lock-prod` | Y | ~0 |
| 2× `snap-0cbf…` / `snap-0920…` | EBS snapshots (Neo4j, DLM) | ap-south-1 | of `vol-04dd7c60…` | Y | ~0.1–0.2 |
| `policy-014e109a7d84d21c3` | DLM lifecycle policy (Neo4j daily 7d) | ap-south-1 | role `brain-prod-neo4j-dlm` | Y | 0 |

### 1.3 Storage (S3 / EBS)
| Resource | Type | Region | Key config | Brain? | Est $/mo |
|---|---|---|---|---|---|
| `brain-audit-prod-380254378136` | S3 | ap-south-1 | **Object Lock COMPLIANCE 7yr — IMMUTABLE**, versioned, KMS `e45360d5…` | Y | ~0.01 |
| `brain-bronze-prod-380254378136` | S3 (Iceberg medallion SoR) | ap-south-1 | 56,828 obj / 9.41 GB, versioned, KMS `2b51c76d…` | Y | ~0.30 |
| `brain-metrics-prod-380254378136` | S3 (Thanos/metrics) | ap-south-1 | 3.58 GB, versioned, KMS `2b51c76d…` | Y | ~0.09 |
| `brain-neo4j-backups-prod-380254378136` | S3 (empty) | ap-south-1 | 0 obj, versioned, KMS `2b51c76d…` | Y | ~0 |
| `brain-tfstate-prod-380254378136` | S3 (TF remote state) | ap-south-1 | 1 obj/656 KB, versioned, KMS `71b76943…` | Y | ~0 |
| 5 persistent EBS gp3 (Neo4j 50 + Kafka 3×50 + Prom 20) | EBS `DeleteOnTerm=false` | ap-south-1 | survives node termination | Y | ~19 |
| 11 node-root EBS gp3 | EBS `DeleteOnTerm=true` | ap-south-1 | auto-deleted with instance | Y | ~32 |

### 1.4 Secrets / KMS / IAM
| Resource | Type | Region | Key config | Brain? | Est $/mo |
|---|---|---|---|---|---|
| `alias/brain-root-prod` | KMS CMK `2b51c76d…` | ap-south-1 | encrypts 15 secrets + RDS secret + bronze/metrics/neo4j S3 + PII DEK | Y | 1 |
| `alias/brain-connector-secrets-prod` | KMS CMK `a7f6d44b…` | ap-south-1 | 5 connector OAuth secrets | Y | 1 |
| `alias/brain-audit-prod` | KMS CMK `e45360d5…` | ap-south-1 | audit S3 + audit log | Y | 1 |
| `alias/brain-tfstate-prod` | KMS CMK `71b76943…` | ap-south-1 | TF state S3 | Y | 1 |
| 21 `brain/prod/*` + `brain/connector/*` secrets | Secrets Manager | ap-south-1 | ESO-synced + connector OAuth | Y | 8.40 |
| `rds!cluster-7ea5a1e7-…` | Secrets Manager (RDS-owned) | ap-south-1 | Aurora managed master, rotation ON | Y* | 0.40 |
| 21 Brain IAM roles (14 IRSA + 3 GH-OIDC + 2 EKS/EC2 + 2 backup) | IAM role | global | — | Y | 0 |
| 16 Brain customer policies (1 orphan: `brain-prod-otel-collector-secrets`) | IAM policy | global | — | Y | 0 |
| 2 instance profiles → `brain-prod-eks-node` | IAM instance profile | global | — | Y | 0 |
| 2 OIDC providers (EKS IRSA + GitHub Actions) | IAM OIDC | global | — | Y | 0 |
| `test-role-olkagc08` + `AWSLambdaBasicExecutionRole-…` | IAM (stray) | global | non-Brain console leftover | **N** | 0 |

### 1.5 Observability & DNS
| Resource | Type | Region | Key config | Brain? | Est $/mo |
|---|---|---|---|---|---|
| `/aws/eks/brain-prod/cluster` | CloudWatch Log Group | ap-south-1 | 30d, ~2.32 GB | Y | 5–30 |
| `/aws/rds/cluster/brain-prod-postgres/postgresql` | CloudWatch Log Group | ap-south-1 | 30d, ~16 MB | Y | ~0.01 |
| `/aws/lambda/test` | CloudWatch Log Group (stray) | ap-south-1 | NEVER_EXPIRE, 0 B | **N** | 0 |
| 5 alarms (aurora-acu, 2× nat, 2× redis) | CloudWatch Alarm | ap-south-1 | nat ones = ec2 reboot/recover | Y | 0.50 |
| 4 Karpenter EventBridge rules | EventBridge Rule | ap-south-1 | → SQS `brain-prod` | Y | 0 |
| `brain-ses-notifications` | SNS Topic (1 email sub) | ap-south-1 | SES bounce/complaint | Y | ~0 |
| `brain.pipadacapital.com` | Route 53 Public Hosted Zone | global | 20 records, external-dns-managed | Y | 0.55 |
| cert #17 (`brain.pipadacapital.com` +SANs) | ACM | ap-south-1 | **InUse=true** (bound to ALB) | Y | 0 |
| cert #18 (`px.brain…` +SANs) | ACM | ap-south-1 | InUse=false (orphan) | Y | 0 |

---

## 2. Total Estimated Current Monthly Spend

| Domain | Est $/mo (steady-state midpoint) |
|---|---|
| Compute & Networking (EKS + Karpenter + system NG + fck-nat + ALB + ECR endpoints + EBS roots) | ~$517 |
| Databases & Backups (Aurora + Valkey + snapshots + DynamoDB + Neo4j snaps) | ~$90 |
| Storage — S3 (~13 GB) + persistent PVC EBS (already partly counted under compute EBS) | ~$1 S3 (EBS folded into compute) |
| Secrets / KMS / IAM (4 CMK + 22 secrets; IAM free) | ~$13 |
| Observability & DNS (CloudWatch Logs dominant + alarms + zone) | ~$8–12 |

> **Consolidated total: ≈ $600–640 / month steady-state** (midpoint **~$620/mo**). The dominant lever is Karpenter on-demand EC2 (~$294 of it, transient) + the flat EKS control plane ($73) + Aurora ($50–95). EBS (~$51) is split across the compute and storage tables — counted **once** in the total under compute. This aligns with the platform's prior ~$510–580/mo estimate; the higher figure here reflects a point-in-time capture with 3 on-demand Karpenter t4g.xlarge nodes running.

---

## 3. Ordered, Dependency-Safe Destruction Sequence

> **Golden rule:** in-cluster controllers own real AWS resources (ALB + target groups via AWS Load Balancer Controller; PVC EBS via EBS CSI; Route 53 records via external-dns; Karpenter EC2 via Karpenter). **Stop GitOps reconciliation first**, then let each controller cleanly release its AWS resources *before* you delete the controller or the cluster. Deleting infra out from under a live controller either orphans a billed resource or hangs on finalizers.

### Phase 0 — Pre-flight (BACKUP + FREEZE) — REVERSIBLE
- Take a **final manual Neo4j snapshot** (identity System-of-Record — only durable copy) and/or run the `neo4j-backup` CronJob to dump to `brain-neo4j-backups-prod` S3. The DLM chain is only 7 days.
- Take a **manual EBS snapshot** of each persistent PVC volume you may need (`vol-04dd7c60…` Neo4j, 3× Kafka, Prometheus) if any data must be preserved.
- Decide Aurora final-snapshot vs skip (see Phase 5). If preserving, take a **manual cluster snapshot** now.
- Export any S3 data you need to keep (bronze medallion) **before** any KMS teardown.
- Confirm no in-flight Argo CronWorkflow / neo4j-backup job is running.
- Record current state (this doc + a fresh `terraform plan`).

### Phase 1 — Stop GitOps reconciliation — REVERSIBLE
- Disable ArgoCD auto-sync (App-of-Apps first) or set every Application `syncPolicy` to manual, OR delete the Application CRs in ns `argocd`. **Prereq:** must be first, else ArgoCD re-creates everything you delete below.
- Risk: none if done first. Reversible (re-enable sync). Access requires the **SSM tunnel** (`tools/ops/eks-ssm-tunnel.sh`, context `brain-prod-ssm`) — the EKS API is private-only; direct kubectl times out.

### Phase 2 — k8s Ingress → release ALB + Target Groups + live ACM cert binding — PARTIALLY REVERSIBLE
- Delete the `collector` / `core` / `web` **Ingress** objects (class `alb`, shared `group.name`) **while the AWS Load Balancer Controller still runs in kube-system**. The controller deprovisions the shared ALB `k8s-brainprod-09e4b2bc81`, its 3 target groups, and both listeners. Cert #17 becomes `InUse=false`.
- Risk: if you delete the controller before its Ingresses, the **ALB leaks** (billed, no owner). Reversible (re-apply Ingress recreates a new ALB with a new DNS name).

### Phase 3 — external-dns + cert-manager → release Route 53 records — PARTIALLY REVERSIBLE
- Remove `external-dns-prod` (or scale to 0) so it stops reconciling. Then the apex/app/api/px A-ALIAS + owner TXT records can be deleted without recreation.
- Remove `cert-manager-prod` after DNS/ALB are gone.
- The 3 ACM-validation CNAMEs + 3 SES DKIM CNAMEs are **not** external-dns-managed — delete them by hand later (Phase 15), and only if the zone is going too.
- Risk: deleting records while external-dns runs → recreation loop. Reversible.

### Phase 4 — Application-tier workloads + batch — REVERSIBLE (redeployable)
- Delete Deployments: `web`, `core`, `collector`, `stream-worker`, `pgbouncer`, `kafka-connect`, Trino coordinator + workers.
- Delete Argo CronWorkflows + `neo4j-backup` CronJob (ensure none in flight).

### Phase 5 — Stateful services + Strimzi Kafka — DESTRUCTIVE to in-cluster data
- Neo4j (final backup already taken in Phase 0), Trino, iceberg-rest.
- Delete the **Strimzi Kafka CR** (brokers). NOTE: `deleteClaim: false` → the 3 Kafka PVCs **persist** and must be deleted explicitly in Phase 8.
- Risk: Kafka is replayable transport; Neo4j is SoR (guarded by Phase 0 backup).

### Phase 6 — Karpenter + operators — DESTRUCTIVE to nodes
- Delete Karpenter NodePools / uninstall Karpenter → drains and **terminates all 7 Karpenter Spot/OD nodes**. **Prereq:** do this before the system node group (Karpenter's controller runs on the system NG). Karpenter continuously re-provisions terminated nodes — terminating instances in the console *without* stopping Karpenter is a whack-a-mole loop.
- Then: Strimzi operator, KEDA, metrics-server, external-secrets (+config).
- The 4 Karpenter EventBridge rules + SQS `brain-prod` become inert — remove them with/after Karpenter (before the SQS queue, to avoid DLQ noise).

### Phase 7 — System managed node group — DESTRUCTIVE
- Delete `brain-prod-system-al2023` (backing ASG `eks-brain-prod-system-al2023-b0cfab4c…`) after Karpenter is gone. No termination protection observed → nothing blocks it, but confirm Karpenter is fully off first.

### Phase 8 — Reclaim persistent PVC EBS volumes — IRREVERSIBLE DATA LOSS
- Delete the surviving PVCs (`deleteClaim:false` Kafka ×3, Neo4j, Prometheus) so the EBS CSI driver releases the volumes, then confirm the underlying gp3 volumes are actually deleted (reclaim policy). The 11 node-root volumes (`DeleteOnTermination=true`) vanished with their instances in Phases 6–7 — no separate step.
- Then delete kube-prometheus-stack / observability (monitoring) + network-policies (default), then **ArgoCD itself**.

### Phase 9 — EKS control plane — IRREVERSIBLE
- Delete cluster `brain-prod` after all node groups + Karpenter EC2 are gone. This also stops emitting control-plane audit logs (log group handled in Phase 14).
- Then delete the **EKS IRSA OIDC provider** — but only AFTER the 14 IRSA roles are deleted (Phase 13). The provider must outlive its dependent roles or they strand.

### Phase 10 — Aurora + ElastiCache — IRREVERSIBLE DATA LOSS (see §5)
- **Aurora is BLOCKED by `DeletionProtection=true` on the cluster.** Prereqs: `modify-db-cluster --no-deletion-protection` first; then decide `--skip-final-snapshot` (fast, no recovery) vs `--final-db-snapshot-identifier <id>` (keep). Delete the writer instance → the cluster → subnet group `brain-prod-aurora` → cluster param group `brain-prod-aurora-postgres16`.
- Delete automated cluster snapshots (7) + any manual final snapshot only if truly not needed. AWS Backup: **none exists** — no vault/recovery-points to purge.
- The RDS-managed secret `rds!cluster-7ea5a1e7-…` is removed automatically by Aurora on cluster delete — **do NOT delete it out-of-band**.
- **ElastiCache** `brain-prod-redis`: no deletion protection. Delete replication group (cache only, no SoR data). Delete the **manual** snapshot `brain-prod-redis-pre-valkey` (it never auto-expires) + 7 auto snapshots + subnet group.

### Phase 11 — fck-nat instance + EIPs — DESTRUCTIVE (breaks egress)
- Terminate `i-02c6bfc90eaa4f649` (fck-nat) — this is the single egress path for private subnets (private RT `rtb-07dea19e2bc0f8e18` default route → its ENI). Safe only once no workload needs outbound.
- Release the 4 EIPs **after** the ALB (Phase 2) and NAT instance are gone. Prereq: an attached EIP cannot be released; a detached one starts incurring idle charges — release promptly.

### Phase 12 — VPC endpoints → route tables → subnets → IGW → SGs → VPC — DESTRUCTIVE
- Delete the 2 ECR interface endpoints + S3 gateway endpoint first (they hold ENIs).
- Then route tables, the 6 subnets, detach + delete IGW `igw-04cebac1a6c59dcdb`, delete the 11 security groups, then the VPC `vpc-06ded56ae87bd2b68`. **Prereq:** VPC delete fails while any ENI/endpoint/subnet/SG dependency remains — order strictly last in networking.
- Leave the default VPC alone (out of scope; account-hygiene item).

### Phase 13 — S3 buckets (versioned empty-then-delete) — IRREVERSIBLE DATA LOSS
- For each bucket: **suspend versioning is not required, but you MUST delete ALL versions + delete-markers** (versioning is enabled on all 5). Use `list-object-versions` → `delete-objects`, or lifecycle expiration, then `delete-bucket`. A plain `s3 rm --recursive` leaves noncurrent versions and will block bucket delete.
- `brain-bronze` (medallion SoR, 9.41 GB), `brain-metrics`, `brain-neo4j-backups` (empty), `brain-tfstate` (**delete LAST — after all TF ops**; see §6).
- **`brain-audit-prod` CANNOT be deleted** — Object Lock COMPLIANCE, 7-year retention, immutable to everyone incl. account root. Carve it out as a known residual (see §5/§6).

### Phase 14 — Secrets Manager → SSM → CloudWatch logs/alarms/EventBridge/SNS — MOSTLY REVERSIBLE within recovery window
- **Secrets Manager:** delete the 21 `brain/prod/*` + `brain/connector/*` secrets. Default 7–30 day recovery window (or `--force-delete-without-recovery` to purge immediately, irreversible). Do **not** delete `rds!cluster-…` (Aurora removed it in Phase 10).
- **SSM Parameters:** none exist — no action.
- **CloudWatch Logs:** disable EKS control-plane log export + RDS PG log export at the source **before** deleting `/aws/eks/brain-prod/cluster` and `/aws/rds/.../postgresql`, else they auto-recreate. (Cluster is already gone by Phase 9, so EKS log group won't regenerate.) Delete the stray `/aws/lambda/test` anytime.
- **CloudWatch Alarms:** delete the 5 alarms (2 NAT alarms drive `ec2:reboot`/`recover` self-healing — moot post-teardown). **Dashboards:** none.
- **EventBridge:** delete the 4 Karpenter rules (if not already in Phase 6) + the SQS `brain-prod` queue. `AutoScalingManagedRule` is AWS-managed (regenerates; ignore).
- **SNS:** delete `brain-ses-notifications` (stops SES bounce/complaint delivery to the owner email).

### Phase 15 — KMS keys — IRREVERSIBLE (7-day scheduled deletion) — LAST
- Only after **every ciphertext consumer is gone** (all secrets, RDS secret, S3 objects, EBS, tfstate): `schedule-key-deletion --pending-window-in-days 7` on the 4 CMKs (`brain-root-prod`, `brain-connector-secrets-prod`, `brain-audit-prod`, `brain-tfstate-prod`).
- **Caveat:** `brain-audit-prod` CMK is still needed to *read* the immutable audit bucket that survives (Phase 13). If that bucket must remain readable, **do NOT schedule its CMK for deletion.** `brain-tfstate-prod` CMK only after the tfstate bucket is handled.
- AWS-managed keys (`aws/ebs`, `aws/rds`, `aws/secretsmanager`, `aws/acm`, …) need no action — not deletable, not billed.

### Phase 16 — IAM (detach-before-delete) — REVERSIBLE (recreatable from TF)
- Order per role: detach managed/inline policies → remove from instance profiles → delete role.
- Delete the 14 IRSA roles **before** detaching/deleting the EKS OIDC provider (Phase 9 sequencing). Delete the 3 GitHub-OIDC roles + the GitHub OIDC provider (only if CI to this account is being retired). Delete `brain-prod-eks-cluster`, `brain-prod-eks-node` (after both instance profiles disassociated), `brain-prod-neo4j-backup`, `brain-prod-neo4j-dlm`.
- Delete the 16 customer-managed policies once unattached; the orphan `brain-prod-otel-collector-secrets` (Attach=0) can go immediately. Leave the 12 `AWSServiceRoleFor*` (AWS clears them). Stray `test-role-olkagc08` + its Lambda policy = account hygiene, out of Brain scope.

### Phase 17 — ACM certs + Route 53 zone — DESTRUCTIVE
- Delete cert #18 (`px.brain…`, InUse=false) anytime. Delete cert #17 only after the ALB/listener is gone (Phase 2) — ACM blocks deleting an in-use cert.
- Delete the remaining ACM-validation + SES DKIM CNAMEs, then the hosted zone. **See §6 — recommend KEEPING the hosted zone** if the domain will be reused (deleting it means new NS delegation + revalidation later).

### Phase 18 — DynamoDB TF-lock + tfstate bucket — LAST, out-of-band
- Delete DynamoDB `brain-tfstate-lock-prod` and empty+delete `brain-tfstate-prod` S3 bucket **only after all IaC operations are complete** — they back Terraform's own lock+state; removing them mid-reset breaks the ability to `terraform apply/destroy` the remainder.

---

## 4. Per-Phase Flags / Risks / Reversibility Matrix

| Phase | Required prereq flags / actions | Reversible? | Primary risk |
|---|---|---|---|
| 0 backup/freeze | manual snapshots (Neo4j, Aurora, EBS), S3 export | Yes | 7-day DLM window; missing a needed export |
| 1 stop GitOps | disable ArgoCD auto-sync FIRST | Yes | forget → controllers re-create deletions |
| 2 Ingress→ALB | delete Ingress **while LB-controller runs** | Partial | delete controller first → ALB leaks (billed orphan) |
| 3 external-dns/certmgr | scale/remove external-dns before deleting records | Partial | record recreation loop |
| 4 app workloads | — | Yes | none material |
| 5 stateful/Kafka | Neo4j final backup done; `deleteClaim:false` awareness | No (data) | broker/Neo4j data loss if backup skipped |
| 6 Karpenter/ops | delete Karpenter BEFORE system NG | No (nodes) | whack-a-mole re-provision if Karpenter left up |
| 7 system NG | Karpenter fully off | No (nodes) | hosts Karpenter controller |
| 8 PVC EBS | delete PVC → confirm gp3 released | **No** | orphaned billed volumes; **data loss** |
| 9 EKS control plane | nodes gone; IRSA roles gone before OIDC delete | **No** | OIDC deleted early strands 14 roles |
| 10 Aurora/Redis | `--no-deletion-protection` THEN delete; `--skip-final-snapshot` OR `--final-db-snapshot-identifier`; delete manual redis snap | **No** | **customer/ops data loss**; DeletionProtection gate |
| 11 fck-nat/EIP | release EIP only after ALB+NAT gone | No | kills all private egress; idle-EIP charge if detached-not-released |
| 12 VPC teardown | endpoints→RT→subnets→IGW→SG→VPC order | No | VPC delete fails on lingering ENI/dep |
| 13 S3 | **delete ALL versions + delete-markers** then bucket; tfstate LAST | **No** | versioned residue blocks delete; **medallion data loss**; audit bucket UN-deletable |
| 14 secrets/logs/alarms/SNS | disable log export at source first; recovery-window vs force-delete | Partial | force-delete = immediate irreversible; log auto-recreate |
| 15 KMS | schedule-key-deletion **only after all consumers gone**, 7-day window | **No** (after window) | early delete → permanent ciphertext loss; audit CMK still needed |
| 16 IAM | detach → deprofile → delete; IRSA before OIDC | Yes (recreatable) | can't delete while attached / in-use profile |
| 17 ACM/Route53 | in-use cert only after ALB gone; **keep zone?** | Partial | deleting zone loses delegation |
| 18 DynamoDB/tfstate | **only after all TF ops done** | **No** | breaks TF lock/state mid-reset |

---

## 5. Items Requiring EXTRA CONFIRMATION — Irreversible / Destroys Customer or Revenue Data

These are the hard, unrecoverable, business-data-destroying actions. **Each needs explicit, itemized owner sign-off before execution.**

1. **Aurora `brain-prod-postgres` (operational PostgreSQL — `ops` schema: identity/journey export, ML inference log, ad_spend/tax/audit/contact_pii).** Requires disabling `DeletionProtection` and choosing `--skip-final-snapshot`. **Deleting with skip-final-snapshot = permanent loss of all operational/PII state.** CONFIRM: skip vs keep a final snapshot.
2. **`brain-bronze-prod` S3 (Iceberg medallion — Bronze/Silver/Gold + serving marts, the system-of-record data lake, 56,828 objects).** Emptying all versions + deleting = **permanent loss of the entire revenue/attribution/journey data platform**. CONFIRM export first.
3. **Neo4j EBS volume `vol-04dd7c60…` + its 2 DLM snapshots (identity System-of-Record, ADR-0004).** Its only durable copy is the 7-day DLM chain; deleting volume + snapshots + the empty S3 backup bucket = **irrecoverable identity graph**. CONFIRM Phase-0 final backup exists.
4. **The 4 KMS CMKs (`brain-root-prod`, `brain-connector-secrets-prod`, `brain-audit-prod`, `brain-tfstate-prod`).** Scheduling deletion is irreversible after the 7-day window and renders every dependent ciphertext (secrets, PII vault DEK, S3 objects, tfstate) **permanently undecryptable**. `brain-root-prod` has the widest blast radius in the whole account. CONFIRM all consumers gone.
5. **Kafka broker EBS volumes ×3 (`deleteClaim:false`, in-flight Bronze landing offsets) + the 21 Secrets Manager secrets (connector OAuth tokens, JWT/cookie signing, app credentials).** Force-deleting secrets skips the recovery window; deleting Kafka PVCs loses un-landed events. CONFIRM replay/re-issue is acceptable.

**Also flag (immutable / cannot be deleted, not lost but permanent):** `brain-audit-prod` S3 — Object Lock COMPLIANCE 7-year retention. It **cannot be emptied or deleted** by anyone (including account root) until retention expires. Any "wipe everything" expectation must account for this bucket (and its `brain-audit-prod` CMK, needed to read it) surviving — the only way to remove it before 2033-ish is closing the AWS account.

---

## 6. `terraform destroy` vs Targeted CLI + Residual Out-of-Band Resources

**Recommendation: hybrid — orchestrate the k8s/controller drain by hand (Phases 1–8), then `terraform destroy` of `infra/terraform/envs/prod` for the AWS-native estate, then targeted CLI for the residue TF never owned.**

- **Prefer `terraform destroy envs/prod`** for everything TF provisioned (EKS, node group, Aurora, ElastiCache, VPC/subnets/RT/IGW/endpoints, KMS CMKs, Secrets shells, IAM roles/policies/OIDC, DLM policy, S3 buckets it created, Route 53 zone, ACM, alarms, EventBridge, SNS, SQS, DynamoDB lock). It respects dependency ordering and avoids drift/orphans.
- **But `terraform destroy` will FAIL or misbehave on these without manual pre-work — do the CLI/k8s steps first:**
  - **Controller-owned AWS resources** TF does not manage: the **ALB + target groups + listeners** (AWS Load Balancer Controller), **Route 53 A-ALIAS/TXT records** (external-dns), **Karpenter-provisioned EC2 nodes + their launch templates + root EBS**, **ESO-materialized k8s Secrets**. TF will try to delete the VPC/subnets/zone underneath these and hang on ENIs / non-empty zone. → Run Phases 1–8 first.
  - **Aurora `DeletionProtection=true`** — TF destroy fails until protection is cleared (`prevent_destroy`/lifecycle or a manual `modify-db-cluster`).
  - **Versioned S3 buckets** — TF `force_destroy` may not be set; buckets with versions/delete-markers block destroy. Empty all versions via CLI first (Phase 13).
  - **`brain-audit-prod` Object Lock (COMPLIANCE)** — **TF can NEVER destroy this bucket** while objects are under 7-year retention. It will be a permanent residual; remove it from state (`terraform state rm`) or accept the destroy error.
  - **KMS CMKs** — TF schedules deletion (7-day window); the keys linger pending until the window elapses. Expect a delay, not an instant removal.
  - **RDS-managed secret `rds!cluster-…`** — owned by Aurora, not TF; removed on cluster delete. Don't target it.
  - **The TF backend itself** — `brain-tfstate-prod` S3 bucket + `brain-tfstate-lock-prod` DynamoDB + `brain-tfstate-prod` KMS CMK are the **backend**, not in the managed graph. `terraform destroy` cannot remove its own state store. These are **out-of-band, deleted LAST by hand** (Phase 18) after all TF ops complete.
- **Truly out-of-band residuals TF won't own (delete/keep by hand):**
  - `brain-audit-prod` bucket (immutable, keep until retention expires) + `brain-audit-prod` CMK (keep to read it).
  - `/aws/eks/brain-prod/cluster` + `/aws/rds/...` CloudWatch log groups may be auto-recreated by the service; delete after source log export is off.
  - Stray non-Brain: `/aws/lambda/test` log group, `test-role-olkagc08` + `AWSLambdaBasicExecutionRole-…` policy, the unused default VPC — account hygiene, outside the Brain graph.
  - Any **manual** snapshots (Aurora final, `brain-prod-redis-pre-valkey`, ad-hoc EBS) — TF never created them; delete explicitly or they bill forever.
- **Route 53 hosted zone — CALL-OUT / RECOMMENDATION: KEEP the hosted zone `brain.pipadacapital.com` (Z00011362R9ERGL7EC2J9)** if the domain will be reused. Deleting it forces re-delegation (new AWS NS records at the registrar) and full ACM/SES revalidation on any rebuild. It costs only ~$0.50/mo. Empty the app records (external-dns) but retain the zone unless the domain is being fully retired.

---

## AWAITING EXPLICIT OWNER APPROVAL — NO RESOURCE WILL BE DELETED UNTIL GO IS GIVEN

**This is a documentation-only plan. No AWS or Kubernetes resource has been or will be created, modified, or deleted on the basis of this file. Execution of any phase above requires explicit, itemized owner approval — and the §5 irreversible-data-loss items require separate, individual sign-off.**
