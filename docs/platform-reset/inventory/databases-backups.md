# Platform Reset Inventory — Databases, Caches & Backups

**Account:** 380254378136 (PAID PRODUCTION) · **Primary region:** ap-south-1 · **Domain:** brain.pipadacapital.com
**Scope:** RDS/Aurora, ElastiCache, DynamoDB, AWS Backup, EBS snapshots (backing k8s stateful workloads: Neo4j / Kafka / Prometheus), DLM policies.
**Method:** Read-only AWS CLI (`describe/list/get`) in ap-south-1 + a us-east-1 straggler sweep. **No mutations performed.**
**Inventory date:** 2026-07-14

> NOTE on scope boundaries: Neo4j, Kafka (Strimzi), Trino/MinIO and Prometheus run **on EKS on EBS-backed PVCs**, not as managed AWS DB services. The pods/PVCs are inventoried by the k8s agent. This document inventories the **AWS-side storage/backup artifacts** for them: the underlying EBS volumes (for context) and the **EBS snapshots + DLM policy** that back up Neo4j (the identity System-of-Record). Iceberg/MinIO object data on S3 is inventoried by the storage/S3 agent.

---

## 1. Summary Table

| # | Resource | Type | Region | Brain? | Key config | Protections | Est. $/mo |
|---|----------|------|--------|--------|-----------|-------------|-----------|
| 1 | `brain-prod-postgres` | Aurora PostgreSQL cluster (Serverless v2) | ap-south-1 | Yes (prod) | engine 16.4, 0.5–2.0 ACU, single-AZ, 1 writer, encrypted, 35-day PITR | **DeletionProtection=ON**; no explicit final-snapshot flag (set at delete time) | ~$50–95 |
| 2 | `brain-prod-postgres-1` | Aurora writer instance (`db.serverless`) | ap-south-1 | Yes (prod) | member of cluster #1, AZ 1a, Perf Insights on (7d) | DeletionProtection=**OFF** (instance-level); cluster protects it | (in #1) |
| 3 | 7× `rds:brain-prod-postgres-*` | Aurora automated cluster snapshots | ap-south-1 | Yes | daily, 2026-07-08 → 07-14, encrypted | Auto-managed by 35d retention; deleted with cluster unless copied | ~$1–5 |
| 4 | `brain-prod-aurora` | RDS DB subnet group | ap-south-1 | Yes | 3 private subnets (1a/1b/1c), vpc-06ded56… | — | $0 |
| 5 | `brain-prod-aurora-postgres16` | RDS cluster parameter group | ap-south-1 | Yes | family aurora-postgresql16 | — | $0 |
| 6 | `brain-prod-redis` | ElastiCache replication group (Valkey) | ap-south-1 | Yes (prod) | Valkey 8.0.1, 1 node, cache.t4g.micro, single-AZ, encrypt at-rest+transit, 7-day snapshots | AutomaticFailover=**OFF**, MultiAZ=**OFF** | ~$12–14 |
| 7 | `brain-prod-redis-001` | ElastiCache cache node/cluster | ap-south-1 | Yes | primary node of RG #6, AZ 1a | — | (in #6) |
| 8 | 7× `automatic.brain-prod-redis-001-*` | ElastiCache automatic snapshots | ap-south-1 | Yes | daily 07-08→07-14, ~6 MB each, 7d retention | Auto-managed | ~$0 (negligible) |
| 9 | `brain-prod-redis-pre-valkey` | ElastiCache **manual** snapshot | ap-south-1 | Yes | pre-Valkey-migration safety snapshot (Redis 7.1.0), 6 MB | **Manual — NOT auto-deleted**; persists until explicitly removed | ~$0 |
| 10 | `brain-prod-redis` | ElastiCache cache subnet group | ap-south-1 | Yes | 3 subnets (1a/1b/1c) | — | $0 |
| 11 | `brain-tfstate-lock-prod` | DynamoDB table | ap-south-1 | Yes (prod) | Terraform state lock, PAY_PER_REQUEST, 1 item/107 B, PITR **disabled** | None (but critical: locks TF state) | ~$0 |
| 12 | 2× `snap-…` (Neo4j) | EBS snapshots (DLM-managed) | ap-south-1 | Yes | 50 GB gp3, of Neo4j PVC `data-neo4j-0` (vol-04dd7c60…), 07-12 & 07-13 | DLM 7-day retain; **identity SoR backup** | ~$0.10–0.20 |
| 13 | `policy-014e109a7d84d21c3` | DLM lifecycle policy | ap-south-1 | Yes | "AUD-OPS-012" daily Neo4j EBS snapshot, retain 7, target tag pvc namespace=neo4j | ENABLED; role `brain-prod-neo4j-dlm` | $0 |
| 14 | 16× EBS volumes (gp3) | EBS (k8s PVC + node root) | ap-south-1 | Yes | see §2.7 — Neo4j 50G, 3× Kafka 50G, Prometheus 20G, node roots, Karpenter ephemeral | in-use (attached) | ~$29 (storage) |

**Not found (verified empty):** AWS Backup vaults/plans/jobs (none — backups are via native RDS/ElastiCache auto-snapshots + DLM, not AWS Backup); RDS non-cluster DB snapshots (none); ElastiCache serverless caches (none); us-east-1 RDS/ElastiCache/Backup/EBS-snapshots (none — no global/CloudFront stragglers in this domain).

---

## 2. Per-Resource Detail

### 2.1 Aurora PostgreSQL — `brain-prod-postgres` (cluster) + `brain-prod-postgres-1` (instance)
- **ARN (cluster):** `arn:aws:rds:ap-south-1:380254378136:cluster:brain-prod-postgres`
- **ARN (instance):** `arn:aws:rds:ap-south-1:380254378136:db:brain-prod-postgres-1`
- **Engine:** aurora-postgresql 16.4 (provisioned engine mode, Serverless v2 scaling **0.5–2.0 ACU**).
- **Topology:** single writer instance (`db.serverless`), **MultiAZ=false**, AZ ap-south-1a. DB name `brain`, port 5432, master user `brainadmin` (managed secret in Secrets Manager: `rds!cluster-7ea5a1e7-…`).
- **Purpose (tag):** `oltp` — this is the app's **operational PostgreSQL** (the `ops` schema: identity/journey export, ML inference log, stitch shim, ad_spend/tax/audit/contact_pii). Per CLAUDE.md, PG is operational-only; medallion data is Iceberg, not here.
- **Encryption:** StorageEncrypted=true, KMS key `2b51c76d-7ab5-4dd1-bb3c-84f31becc068` (shared platform CMK). Performance Insights on (7-day, same CMK). CloudWatch `postgresql` log export on.
- **Backup:** BackupRetentionPeriod=**35 days** (continuous PITR); backup window 02:00–03:00 UTC. `CopyTagsToSnapshot=false`.
- **Networking:** private subnet group `brain-prod-aurora`, SG `sg-0c1f0967bcfa07508`, not publicly accessible, IPV4.
- **Protections:** **DeletionProtection=true on the cluster** (must be disabled before any delete). Instance-level DeletionProtection=false (cluster-level is the effective guard). `EngineLifecycleSupport=open-source-rds-extended-support`.
- **Cost assumption:** Serverless v2 billed per ACU-hour (~$0.09/ACU-hr in ap-south-1). At a realistic low-traffic average ~0.5–1.0 ACU that's ~$33–66/mo compute + Aurora storage (~$0.11/GB-mo, tiny here) + backup storage beyond 100% + I/O. Estimate **~$50–95/mo**; if it idles near 0.5 ACU most of the time, closer to the low end.

### 2.2 Aurora automated cluster snapshots (7)
- IDs `rds:brain-prod-postgres-2026-07-08-02-01` … `rds:brain-prod-postgres-2026-07-14-02-06`, all `available`, encrypted with the platform CMK, `SnapshotType=automated`.
- Lifecycle-bound to the cluster's 35-day retention; not independently deletable in the normal sense (aged out automatically). **These are deleted when the cluster is deleted unless a final/manual copy is taken.**
- **Cost:** Aurora backup storage is free up to 100% of cluster volume; overage ~$0.021/GB-mo. Data volume is tiny → **~$1–5/mo**.

### 2.3 ElastiCache — `brain-prod-redis` (Valkey)
- **ARN:** `arn:aws:elasticache:ap-south-1:380254378136:replicationgroup:brain-prod-redis`; node `brain-prod-redis-001`.
- **Engine:** **Valkey 8.0.1** (migrated from Redis 7.1.0 — see manual snapshot #9), 1 node, **cache.t4g.micro**, cluster-mode disabled.
- **Role in platform:** the **analytics/serving Redis cache** fronting Trino-over-Iceberg (BFF/metric-engine read path) + connector OAuth token cache. Endpoints: primary `master.brain-prod-redis.5eykyx.aps1.cache.amazonaws.com:6379`.
- **HA:** **AutomaticFailover=disabled, MultiAZ=disabled** (single node — acceptable for a cache; a node loss = cold cache, not data loss of record).
- **Encryption:** at-rest + in-transit both ON (TransitEncryptionMode=required), KMS CMK `2b51c76d-…`. AuthToken **disabled** (relies on SG + transit TLS + private subnets).
- **Backup:** SnapshotRetentionLimit=7 days, window 03:00–04:00 UTC.
- **Networking:** subnet group `brain-prod-redis` (3 AZs), SG `sg-0b7dbe1cb6c2eaa10`.
- **Cost assumption:** cache.t4g.micro on-demand ≈ **$12–14/mo** in ap-south-1 (single node, no reserved).

### 2.4 ElastiCache snapshots
- **7 automatic** (`automatic.brain-prod-redis-001-2026-07-08…14`), ~6 MB each, 7-day retention, auto-aged.
- **1 manual: `brain-prod-redis-pre-valkey`** — taken 2026-07-14 as a pre-migration safety copy of the old Redis 7.1.0 engine. **This is a manual snapshot: it does NOT auto-expire** and will linger (and bill) until explicitly deleted. Flag for cleanup post-reset once Valkey is confirmed stable.
- **Cost:** ~6 MB total → effectively **$0** (ElastiCache backup ~$0.085/GB-mo; sub-cent here).

### 2.5 DynamoDB — `brain-tfstate-lock-prod`
- **ARN:** `arn:aws:dynamodb:ap-south-1:380254378136:table/brain-tfstate-lock-prod`.
- **Purpose:** Terraform **state lock** table (S3 backend lock). PAY_PER_REQUEST, 1 item / 107 bytes. **PITR disabled.**
- **Criticality:** low data value, but **operationally load-bearing** — deleting it breaks Terraform's ability to lock/apply prod IaC. Should be one of the **last** resources removed in any reset, and only after IaC operations are complete.
- **Cost:** on-demand with ~zero traffic → **~$0/mo** (a few cents at most).

### 2.6 EBS snapshots + DLM (Neo4j identity SoR)
- **Snapshots:** `snap-0cbf1097c46176920` (2026-07-12) and `snap-09203a7259196e357` (2026-07-13) — both 50 GB, of Neo4j PVC volume `vol-04dd7c60d1427e51c` (`data-neo4j-0`, namespace `neo4j`), `completed`, DLM-managed.
- **DLM policy `policy-014e109a7d84d21c3`** ("AUD-OPS-012"): ENABLED, daily at 20:30, **retain 7**, targets volumes tagged `kubernetes.io/created-for/pvc/namespace=neo4j`, execution role `brain-prod-neo4j-dlm`, managed by Terraform. This is the **only** app-data backup mechanism for Neo4j (the identity System-of-Record per ADR-0004) since Neo4j is self-hosted on EKS, not a managed service.
- **Cost:** EBS snapshot storage ~$0.05/GB-mo, incremental. 2 snapshots of a mostly-static 50 GB vol → **~$0.10–0.20/mo** (well under $1; grows toward ~7×incremental as retention fills).
- **Gap note (honest):** Kafka (Strimzi) and Prometheus PVCs are **not** covered by any DLM policy or AWS Backup — only Neo4j is. Kafka is a replayable transport (3 combined brokers, replication) and Prometheus is disposable metrics, so this is a defensible design choice, not necessarily debt.

### 2.7 EBS volumes (context, backing k8s stateful workloads)
16 gp3 volumes, all `in-use`. Grouped:
- **Neo4j (identity SoR):** `vol-04dd7c60d1427e51c` 50G (1a) — backed up by DLM.
- **Kafka/Strimzi (combined brokers):** `vol-09b129d84aa096dc9`, `vol-08f28c18f13a03cf4`, `vol-0b97ef1045d37d168` — 3× 50G — **no snapshot backup** (replayable).
- **Prometheus:** `vol-0a106095368c1682f` 20G (1c) — **no backup** (disposable metrics).
- **EKS system node-group roots:** `vol-0f9400378af351b74`, `vol-051ae3426e9d29618`, `vol-06d34be6dfd853927` — 20G each.
- **Karpenter-managed node roots (ephemeral):** ~7× 50G — recreated with nodes, no data value.
- **Platform/other:** `vol-00c81f9c231754fd8` 8G (terraform-tagged).
- **Cost:** ~16 vols totaling ~640 GB gp3 at ~$0.0912/GB-mo ≈ **~$58/mo total**, but node-root and Karpenter-ephemeral volumes belong to the **compute/EKS** domain. The DB-domain-attributable slice (Neo4j 50G + Kafka 3×50G + Prometheus 20G = 220 GB) ≈ **~$20/mo**; the Neo4j-only piece (the actual "database" here) ≈ **~$4.6/mo**. Volumes are counted here for completeness but their bulk cost rolls up under the compute/EKS agent.

---

## 3. Destruction Considerations (documentation only — nothing deleted)

**Recommended teardown order for this domain (safe → last):**
1. **Manual ElastiCache snapshot `brain-prod-redis-pre-valkey`** — safe to delete first once Valkey is confirmed healthy; it is the only backup artifact that lingers/bills indefinitely and has no dependents.
2. **Aged automatic snapshots** (RDS cluster snaps, ElastiCache auto snaps, Neo4j EBS snaps) — leave to auto-expire, or delete only after confirming no restore is needed. Deleting the parent resource typically removes automated snapshots (RDS may prompt for a final snapshot).
3. **ElastiCache `brain-prod-redis`** — cache only, no system-of-record data; can be dropped early. No deletion protection to clear. Its subnet/param groups go after the RG.
4. **Aurora `brain-prod-postgres`** — **BLOCKED by DeletionProtection=true on the cluster.** Must `modify-db-cluster --no-deletion-protection` **first**. Decide final-snapshot vs skip at delete time (no standing final-snapshot flag exists). Delete the writer instance, then the cluster, then the subnet group + cluster parameter group. Also the managed master-user secret in Secrets Manager (`rds!cluster-7ea5a1e7-…`) — belongs to the secrets domain but is coupled.
5. **Neo4j EBS volume + DLM policy** — Neo4j pod/PVC teardown is the k8s agent's job; the AWS-side residue (the DLM policy `policy-014e109a7d84d21c3` + its IAM role `brain-prod-neo4j-dlm` + orphaned snapshots) must be cleaned in TF. **Take a final manual snapshot of the identity SoR before destroying** — this is the one truly irreplaceable dataset in the domain.
6. **DynamoDB `brain-tfstate-lock-prod`** — **DELETE LAST.** It backs Terraform's own state lock; removing it mid-reset breaks the ability to `terraform apply`/`destroy` the rest of the stack. Only remove after all IaC operations for the reset are finished (or destroy it out-of-band by hand).

**Key dependencies / protections / risks:**
- **DeletionProtection=true** on the Aurora cluster is the single hard gate in this domain — nothing else has a standing protection flag.
- **Shared KMS CMK `2b51c76d-…`** encrypts Aurora, ElastiCache, their snapshots, and Perf Insights. **Do not schedule this CMK for deletion until every resource above is gone**, or restores/reads become impossible. It is cross-domain (also likely used by S3/secrets).
- **Neo4j is the identity System-of-Record** and its only backup is the DLM EBS snapshot chain (7-day). Any reset must snapshot it explicitly first; the 7-day window means a reset paused >7 days loses recoverability.
- **No AWS Backup vault/plan exists** — there is no centralized backup layer to purge; backups are decentralized (native RDS/EC auto-snapshots + one DLM policy). Reduces teardown surface but means restore/retention is per-service.
- **Snapshots survive their parent** if manual or copied — audit for lingering manual/copied snapshots after resource deletion to stop residual storage charges.

---

## 4. Total Estimated Monthly Cost — Databases, Caches & Backups Domain

| Component | Est. $/mo |
|-----------|-----------|
| Aurora PostgreSQL Serverless v2 (compute+storage+backup) | ~$50–95 |
| Aurora automated snapshots | ~$1–5 |
| ElastiCache Valkey (cache.t4g.micro, single node) | ~$12–14 |
| ElastiCache snapshots (auto + manual) | ~$0 |
| DynamoDB tfstate lock (on-demand) | ~$0 |
| Neo4j EBS snapshots (DLM) | ~$0.10–0.20 |
| Neo4j EBS volume (50G, the "database" disk) | ~$4.60 |
| **Domain total (excl. non-DB EBS node/Kafka/Prometheus volumes)** | **≈ $68–119 / mo (midpoint ~$90)** |

*Excludes node-root and Karpenter-ephemeral EBS volumes (~$35/mo, roll up under compute/EKS domain) and Kafka/Prometheus PVC storage (~$16/mo, roll up under the streaming/observability domains). Cost assumptions: ap-south-1 on-demand list pricing, Serverless v2 ~$0.09/ACU-hr averaged 0.5–1.0 ACU, gp3 ~$0.0912/GB-mo, snapshot ~$0.05/GB-mo; actuals depend on real ACU utilization and data growth.*
