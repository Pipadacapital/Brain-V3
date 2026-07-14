# Storage Inventory — S3 / EBS / EFS

**Domain:** Storage (S3 / EBS / EFS)
**AWS Account:** 380254378136 (PAID PRODUCTION)
**Primary region:** ap-south-1
**us-east-1 sweep:** performed — 0 EBS volumes, 0 self-owned snapshots, 0 EFS file systems (no stragglers)
**Inventory mode:** READ-ONLY (describe/list/get/ls only). No mutations performed.
**Captured:** 2026-07-14

---

## 1. Summary Table

### S3 buckets (5, all ap-south-1, all private, all KMS-encrypted, all versioned)

| Bucket | Region | Objects | Size | Versioning | Object Lock | Lifecycle | Est. $/mo |
|---|---|---|---|---|---|---|---|
| `brain-audit-prod-380254378136` | ap-south-1 | 48 | ~16.8 KB | Enabled | **COMPLIANCE, 7 yr** | none | ~$0.01 |
| `brain-bronze-prod-380254378136` | ap-south-1 | 56,828 | ~9.41 GB | Enabled | none | INTELLIGENT_TIERING @0d + noncurrent-90d + abort-MPU-7d | ~$0.30 |
| `brain-metrics-prod-380254378136` | ap-south-1 | 159 | ~3.58 GB | Enabled | none | noncurrent-30d + abort-MPU-7d | ~$0.09 |
| `brain-neo4j-backups-prod-380254378136` | ap-south-1 | 0 | 0 B | Enabled | none | `dumps/` expire-30d + noncurrent-7d + abort-MPU-7d | ~$0.00 |
| `brain-tfstate-prod-380254378136` | ap-south-1 | 1 | ~656 KB | Enabled | none | noncurrent-version-90d | ~$0.00 |

**S3 subtotal: ~13 GB, ~$0.50/mo** (storage only; request/tiering-monitoring costs negligible at this volume).

### EBS volumes (16, all gp3, all `in-use`, ap-south-1)

| Volume ID | Size | Type | AZ | Role (tag / PVC) | DeleteOnTerm | Est. $/mo |
|---|---|---|---|---|---|---|
| `vol-04dd7c60d1427e51c` | 50 | gp3 | ap-south-1a | **Neo4j** PVC `data-neo4j-0` (ns neo4j) — identity SoR | **false** | ~$4.00 |
| `vol-0b97ef1045d37d168` | 50 | gp3 | ap-south-1a | **Kafka** PVC `data-0-brain-prod-kafka-combined-0` | **false** | ~$4.00 |
| `vol-08f28c18f13a03cf4` | 50 | gp3 | ap-south-1a | **Kafka** PVC `...kafka-combined-1` | **false** | ~$4.00 |
| `vol-09b129d84aa096dc9` | 50 | gp3 | ap-south-1a | **Kafka** PVC `...kafka-combined-2` | **false** | ~$4.00 |
| `vol-0a106095368c1682f` | 20 | gp3 | ap-south-1c | **Prometheus** PVC (ns monitoring) | **false** | ~$1.60 |
| `vol-04f8e865e1de49ff0` | 50 | gp3 | ap-south-1a | Karpenter node root (streaming) | true | ~$4.00 |
| `vol-0af454348572dbb2a` | 50 | gp3 | ap-south-1b | Karpenter node root (trino) | true | ~$4.00 |
| `vol-06b01f03acd2f38dc` | 50 | gp3 | ap-south-1a | Karpenter node root (ondemand) | true | ~$4.00 |
| `vol-0940147ba5e5991e6` | 50 | gp3 | ap-south-1a | Karpenter node root (ondemand) | true | ~$4.00 |
| `vol-014ffe604521ac884` | 50 | gp3 | ap-south-1a | Karpenter node root (streaming) | true | ~$4.00 |
| `vol-0a176e41032147d7a` | 50 | gp3 | ap-south-1b | Karpenter node root (streaming) | true | ~$4.00 |
| `vol-0f2b5331b5e3872dc` | 50 | gp3 | ap-south-1a | Karpenter node root (streaming) | true | ~$4.00 |
| `vol-0f9400378af351b74` | 20 | gp3 | ap-south-1b | System-node-group root (no cluster tag) | true | ~$1.60 |
| `vol-051ae3426e9d29618` | 20 | gp3 | ap-south-1c | System/other node root (no cluster tag) | true | ~$1.60 |
| `vol-06d34be6dfd853927` | 20 | gp3 | ap-south-1a | Node root (no cluster tag) | true | ~$1.60 |
| `vol-00c81f9c231754fd8` | 8 | gp3 | ap-south-1a | Small node root (bastion/util) | true | ~$0.64 |

**EBS subtotal: 638 GB provisioned → ~$51/mo** (gp3 @ $0.08/GB-mo storage; all volumes at baseline 3000 IOPS / 125 MB/s = free tier, no extra IOPS/throughput charge).

### EBS snapshots (2, DLM-managed)

| Snapshot | Source Vol | Nominal GB | Policy | Est. $/mo |
|---|---|---|---|---|
| `snap-0cbf1097c46176920` | vol-04dd7c60… (Neo4j) | 50 | `neo4j-daily-7d` (DLM) | incremental |
| `snap-09203a7259196e357` | vol-04dd7c60… (Neo4j) | 50 | `neo4j-daily-7d` (DLM) | incremental |

**Snapshot subtotal: ~$1–3/mo** (incremental at $0.05/GB-mo; first snapshot ~full ≤9.4 GB actual Neo4j data, second delta-only).

### EFS
**None** — 0 file systems in ap-south-1 or us-east-1.

### DLM lifecycle policy (1)

| Policy | ID | Target | Schedule | Retain | State |
|---|---|---|---|---|---|
| Neo4j daily snapshots (AUD-OPS-012) | `policy-014e109a7d84d21c3` | tag `kubernetes.io/created-for/pvc/namespace=neo4j` | daily 20:30 UTC | 7 | ENABLED |

---

## 2. Per-Resource Detail

### S3 — brain-audit-prod-380254378136
- **ARN:** `arn:aws:s3:::brain-audit-prod-380254378136` · region ap-south-1
- **Contents:** 48 objects / ~16.8 KB (audit trail).
- **Versioning:** Enabled (MFADelete disabled).
- **Encryption:** SSE-KMS, CMK `arn:aws:kms:ap-south-1:…:key/e45360d5-1b5f-4a4d-837f-cbc0043dac99`, BucketKey on, SSE-C blocked.
- **Public access:** fully blocked (all 4 flags true).
- **⚠ OBJECT LOCK: COMPLIANCE mode, default retention 7 YEARS.** Objects are **immutable and undeletable** until retention expires — even the account root cannot delete or shorten. Bucket cannot be emptied/deleted while any locked object is under retention.
- **Lifecycle / replication:** none.
- **Brain-related:** yes (name `brain`/`prod`).

### S3 — brain-bronze-prod-380254378136
- **ARN:** `arn:aws:s3:::brain-bronze-prod-380254378136` · region ap-south-1
- **Role:** Iceberg warehouse backing store — top-level prefixes `brain_bronze/`, `brain_silver/`, `brain_gold/`, `brain_serving/`. This is the **system-of-record medallion data lake** (Bronze/Silver/Gold + serving marts).
- **Contents:** 56,828 objects / ~9.41 GB (Parquet + Iceberg metadata/manifests).
- **Versioning:** Enabled.
- **Encryption:** SSE-KMS CMK `…/2b51c76d-7ab5-4dd1-bb3c-84f31becc068`, BucketKey on, SSE-C blocked.
- **Public access:** fully blocked.
- **Lifecycle:** (a) transition to INTELLIGENT_TIERING at day 0; (b) noncurrent versions expire at 90d; (c) abort incomplete MPU at 7d. Object Lock: none.
- **Dependencies:** Iceberg REST catalog, Trino serving, Spark transform jobs, Kafka Connect Bronze sink all read/write here. Highest-value data asset in the domain.
- **Brain-related:** yes.

### S3 — brain-metrics-prod-380254378136
- **ARN:** `arn:aws:s3:::brain-metrics-prod-380254378136` · region ap-south-1
- **Contents:** 159 objects / ~3.58 GB (metrics/observability long-term storage, e.g. Thanos/Prometheus remote blocks or metric exports).
- **Versioning:** Enabled. **Encryption:** SSE-KMS CMK `…/2b51c76d…` (shared with bronze). Public: blocked.
- **Lifecycle:** noncurrent versions expire at 30d; abort MPU 7d. No Object Lock.
- **Brain-related:** yes.

### S3 — brain-neo4j-backups-prod-380254378136
- **ARN:** `arn:aws:s3:::brain-neo4j-backups-prod-380254378136` · region ap-south-1 · created 2026-07-11
- **Contents:** 0 objects (no Neo4j dumps written yet — DB backup lane currently via EBS DLM snapshots, not S3 dumps).
- **Versioning:** Enabled. **Encryption:** SSE-KMS CMK `…/2b51c76d…`. Public: blocked.
- **Lifecycle:** `dumps/` prefix objects expire 30d; noncurrent 7d; abort MPU 7d. No Object Lock.
- **Brain-related:** yes.

### S3 — brain-tfstate-prod-380254378136
- **ARN:** `arn:aws:s3:::brain-tfstate-prod-380254378136` · region ap-south-1 · created 2026-07-07
- **Role:** Terraform remote state backend (`infra/terraform/envs/prod`).
- **Contents:** 1 object / ~656 KB (current state file; older versions retained per lifecycle).
- **Versioning:** Enabled (critical for state rollback). **Encryption:** SSE-KMS dedicated CMK `…/71b76943-7531-46ad-b9e5-aed7f921733c`. Public: blocked.
- **Lifecycle:** noncurrent state versions expire 90d. No Object Lock.
- **Dependencies:** ALL Terraform-managed infra in this account depends on this bucket. **Do not delete while the platform's IaC is still authoritative** — losing state orphans every TF-managed resource.
- **Brain-related:** yes.

### EBS — persistent (StatefulSet PVC) volumes — `DeleteOnTermination=false`
These are the durable data volumes; they **survive node/instance termination** and must be handled explicitly.
- **Neo4j** `vol-04dd7c60d1427e51c` (50 GB, az-1a) — PVC `data-neo4j-0` ns `neo4j`. Identity resolution system-of-record. Only volume covered by DLM snapshots.
- **Kafka (Strimzi combined)** ×3 — `vol-0b97ef1045d37d168`, `vol-08f28c18f13a03cf4`, `vol-09b129d84aa096dc9` (50 GB each, az-1a) — PVCs `data-0-brain-prod-kafka-combined-{0,1,2}` ns `kafka`. Broker log dirs incl. in-flight Bronze landing offsets.
- **Prometheus** `vol-0a106095368c1682f` (20 GB, az-1c) — PVC `prometheus-kube-prometheus-stack-prometheus-db-…-0` ns `monitoring`.

### EBS — ephemeral node-root volumes — `DeleteOnTermination=true`
11 volumes (8–50 GB) that are EC2/Karpenter/system-node root disks. They are **auto-deleted when their instance terminates** — no independent cleanup needed. Tagged Karpenter roots: streaming (4), trino (1), ondemand (2). Untagged (system node group / bastion) roots: 4 (three 20 GB + one 8 GB).

### EBS snapshots (DLM)
`snap-0cbf1097c46176920` (2026-07-12) and `snap-09203a7259196e357` (2026-07-13) — both of the Neo4j data volume, created by DLM policy `neo4j-daily-7d`, retain last 7. `CopyTags=true`, tagged `SnapshotCreator=dlm-neo4j-daily`. Execution role `arn:aws:iam::…:role/brain-prod-neo4j-dlm`.

---

## 3. Destruction Considerations (documentation only — NOTHING deleted)

**Ordering & dependencies for a platform reset of the storage domain:**

1. **`brain-audit-prod` is BLOCKED by Object Lock (COMPLIANCE, 7 yr).** This is a hard AWS-enforced immutability — the bucket **cannot be emptied or deleted** while any object is under its 7-year retention, and retention cannot be shortened or bypassed by anyone (not even account root). Any "delete all storage" plan must carve this bucket out as a known, expected residual, OR accept that the entire AWS account must be closed to escape it. Do NOT design a reset that assumes this bucket can be removed on demand.

2. **Terraform state (`brain-tfstate-prod`) must be destroyed LAST — after everything it manages.** Deleting it first orphans every TF-managed resource (EKS, Aurora, Redis, S3 CMKs, DLM, EBS via Karpenter/EKS, IRSA). Correct order: `terraform destroy` the stack (which removes the buckets/volumes/policies it owns) → then remove the state bucket. If reset is manual (console/CLI) rather than `terraform destroy`, drift will result and the state bucket becomes the audit record of what existed.

3. **Persistent PVC EBS volumes (`DeleteOnTermination=false`) will NOT self-clean.** The 5 durable volumes (Neo4j ×1, Kafka ×3, Prometheus ×1 = 240 GB) survive node/instance termination by design. Order: delete the k8s StatefulSets/PVCs (or the EKS cluster) → then reclaim the released EBS volumes → then delete DLM snapshots. The 11 node-root volumes (`DeleteOnTermination=true`) require no separate step — they vanish with their instances.

**Additional caveats:**
- **KMS-first ordering.** Every bucket is SSE-KMS with CMKs (`e45360d5…` audit, `2b51c76d…` bronze/metrics/neo4j-backups, `71b76943…` tfstate). Scheduling those CMKs for deletion **before** reading/copying bucket data renders the data permanently unrecoverable — sequence any needed data export ahead of KMS teardown (KMS is a separate domain).
- **Versioning is enabled on all 5 buckets.** `s3 rm --recursive` alone leaves noncurrent versions + delete markers; a true empty requires deleting all versions (or `aws s3api delete-objects` over `list-object-versions`, or lifecycle expiration). Budget for this before any `rm-bucket`.
- **DLM policy vs snapshots.** Disabling/deleting DLM policy `policy-014e109a7d84d21c3` stops new snapshots but does NOT delete existing ones; the 2 Neo4j snapshots must be deleted explicitly. Its exec role `brain-prod-neo4j-dlm` is an IAM/DLM-domain dependency.
- **Neo4j backup gap (informational, not debt to invent):** `brain-neo4j-backups` S3 bucket is empty; Neo4j durability currently rests on the EBS DLM snapshots. If a reset deletes both the Neo4j EBS volume and its DLM snapshots, there is no S3-dump fallback. This is the current honest state, not a design flaw to remediate here.

---

## 4. Total Estimated Monthly Cost — Storage Domain

| Sub-domain | Basis | Est. $/mo |
|---|---|---|
| S3 (5 buckets, ~13 GB total, SSE-KMS bucket-key) | ~13 GB @ ~$0.025/GB (S3 Std + INT-tiering) + negligible requests/monitoring | **~$0.50** |
| EBS gp3 volumes (16, 638 GB, baseline IOPS/throughput) | 638 GB @ $0.08/GB-mo; 3000 IOPS + 125 MB/s all within free baseline | **~$51.00** |
| EBS snapshots (2, Neo4j daily) | incremental @ $0.05/GB-mo, ≤~10 GB actual delta | **~$1–3** |
| EFS | none | **$0.00** |
| DLM policy | no charge for the policy itself | **$0.00** |
| **DOMAIN TOTAL** | | **≈ $52–55 / month** |

**Cost assumptions:** ap-south-1 (Mumbai) list prices — gp3 $0.08/GB-mo storage, gp3 baseline 3000 IOPS & 125 MB/s free; S3 Standard ~$0.025/GB-mo; EBS snapshot $0.05/GB-mo (incremental). Costs are STORAGE-provisioned; excludes data-transfer, API requests, KMS key/request charges (separate domains). EBS dominates the domain at ~$51/mo, ~92% driven by node-root and StatefulSet gp3 volumes — the design is already lean (gp3 not io2, no over-provisioned IOPS, no EFS, tight 7–30–90d lifecycle rules). No obvious storage waste identified.
