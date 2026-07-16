# DR.md — Disaster Recovery: objectives, backup inventory, restore paths

> **AUD-OPS-013**: no DR runbook existed anywhere; RPO/RTO were
> never defined; the coordinated Aurora-catalog + S3-warehouse restore was undesigned. This file
> is the in-repo source of truth. Restore procedures: [RB-1](RB-1-aurora-pitr.md) (Aurora PITR),
> [RB-2](RB-2-eks-recovery.md) (EKS/GitOps rebuild), `tools/dr/s3-version-restore.sh`
> (S3 point-in-time restore). The coordinated fire drill is **documented but PENDING EXECUTION**
> — see [dr-fire-drill.md](dr-fire-drill.md); until it runs, rows marked HYPOTHESIS are unproven.

## 1. Incident severity ladder

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | System-of-record data loss or at risk; or all ingestion down (events being dropped) | warehouse bucket corruption; Aurora cluster loss; Neo4j volume loss; Kafka+collector down > topic retention | Immediate. Freeze writers first (see §4 step 0), then restore. Owner paged. |
| **SEV-2** | Serving/API down or wrong, data intact and still landing | duckdb-serving down (all dashboards 500); ArgoCD apps degraded; pgbouncer outage | Same day. Bronze keeps landing (Connect is independent of serving) — verify that FIRST, then fix serving. |
| **SEV-3** | Degraded: stale marts, failed crons, elevated latency | v4-silver/gold cron Error; maintenance skipped; Redis cache cold | Next business day. Crons are idempotent — re-run; check freshness monitor. |
| **SEV-4** | Cosmetic / single-brand / non-data | one connector token expired; UI glitch | Backlog. |

Escalation rule of thumb: **anything that can widen data loss while you investigate is SEV-1**
(stop the bleeding: pause writers/maintenance before debugging).

## 2. Per-store RPO/RTO objectives and backup inventory

All stores ap-south-1; DR replica (when applied) ap-south-2 — in-country, ADR-0011.

| Store | What it holds | Backup mechanism (verified in repo) | **RPO** | **RTO** | Restore path | Status |
|---|---|---|---|---|---|---|
| **Aurora PostgreSQL** (`brain-prod-postgres`): app `brain` DB (ops schema, connectors, PII vault refs) **+ `iceberg_catalog`** (the Iceberg REST/JDBC catalog!) | Operational state + THE medallion table pointers | PITR, `backup_retention_period = 35` days (modules/aurora); daily automated snapshots. Cross-region: **manual monthly snapshot copy to ap-south-2** (§5) | ≤ 5 min (PITR) | ~1–2 h (restore-to-new-cluster + repoint) | **RB-1** | MEASURED (PITR is AWS-managed) / restore drill PENDING |
| **Iceberg medallion warehouse** (`brain-bronze-prod-<acct>` S3): Bronze SoR + Silver/Gold + serving-view metadata | The data platform | (a) Iceberg snapshots: **14d** time-travel on the durable collector lane (`DURABLE_SNAPSHOT_TTL_MS`, AUD-OPS-015), 7d on marts/other Bronze; raw PII lanes deliberately `retain_last=1`+7d (D4 privacy window). (b) S3 versioning, 90d noncurrent expiry. (c) CRR → ap-south-2 GLACIER_IR replica, 180d (gated — ADR-0011) | (a) 0 for committed data (append-only); bad-write rollback within snapshot window. (b) ≤ 90d for version undelete. (c) replication lag (minutes) for regional loss | rollback: minutes/table. Version restore: hours (tooling: `tools/dr/s3-version-restore.sh`). Regional: days (replica promote + catalog rebuild) | §4 coordinated restore; `s3-version-restore.sh` | Snapshot windows MEASURED; coordinated restore **HYPOTHESIS — fire drill pending** |
| **Neo4j** (identity SoR, ADR-0004; single pod, one gp3 EBS) | brain_id graph, ALIAS_OF intervals, merge history | (AUD-OPS-012, Wave-1) (a) DLM daily EBS snapshots, 7 retained, 20:30 UTC; (b) nightly `neo4j-admin database dump` 21:30 UTC → `brain-neo4j-backups-prod-<acct>`, 30d expiry (infra/helm/neo4j-backup) | ≤ 24 h | EBS snapshot→new PV: ~1 h. Dump load: ~1 h at current graph size | §6 | Backup machinery MEASURED (deployed); restore drill PENDING |
| — Neo4j fallback | rebuild from lakehouse | `silver_identity_map` (bi-temporal intervals) + PG ops export exist in the warehouse | up to export lag | unknown | §6.3 | **HYPOTHESIS — undesigned/untested; do NOT rely on it as the primary path** |
| **Redis** (ElastiCache) | analytics cache, stampede locks | snapshots retained 7d (modules/elasticache) — but treated as **disposable cache** | n/a (rebuildable) | cache warm-up (minutes–1h of elevated duckdb-serving load) | flush/replace node; nothing to restore | MEASURED |
| **Kafka** (Strimzi, 3-broker, EBS PVCs) | transport buffer collector→Bronze | none needed: Connect commits to Iceberg every flush interval; topics retain 7d for replay. NEVER prune-sync strimzi PVCs (kafka-operations.md) | in-flight only (≤ minutes) if all brokers lost; consumers resume from committed offsets otherwise | broker re-create via GitOps: <1 h | RB-2 §data-plane; replay per adr-0010 runbook | MEASURED |
| **tfstate** (`brain-tfstate-prod-<acct>`) | recovery keystone (RB-2 starts here) | S3 versioning, 90d noncurrent; SSE state CMK; CRR → ap-south-2 STANDARD (gated — ADR-0011) | ≤ last apply | minutes (version restore) | `s3-version-restore.sh`; replica copy-back | MEASURED |
| **Secrets Manager** (`brain/prod/*`) | all runtime secrets | AWS-managed durability; deletion has 30d recovery window (modules/secrets); values re-seedable via `prod-secrets-worksheet.md` | 0 (managed) | restore-secret: minutes; full re-seed: ~1 h | worksheet | MEASURED |
| **Audit bucket** (`brain-audit-prod-<acct>`) | WORM hash-chain anchors | Object Lock COMPLIANCE, 7y — deletion-proof by construction | 0 | n/a | n/a | MEASURED |
| **Images/config** (ECR, helm, values) | deployables | git (this repo) + CI rebuild; digests pinned in values-prod | 0 | CI rebuild ~30 min | RB-2 | MEASURED |

**Platform-level objectives** (deliberately conservative until the fire drill proves better):
- **RPO:** committed Bronze events — 0 in-region; ≤ replication lag for regional loss (once CRR applied). Operational PG — 5 min. Identity graph — 24 h.
- **RTO:** serving restored ≤ 4 h (SEV-2); full platform rebuild from a dead cluster ≤ 1 business day (RB-2); coordinated warehouse point-in-time restore ≤ 1 day (unproven — fire drill).

## 3. The recovery-window matrix (what can still be recovered, when)

Discovered a bad write / delete after…

| Age of the mistake | Collector lane (`collector_events_connect`) | Marts / other Bronze | Raw PII lanes | Mechanism |
|---|---|---|---|---|
| < 7d | Iceberg snapshot rollback | Iceberg snapshot rollback | **not recoverable by design** (D4 privacy window) | `CALL rest.system.rollback_to_snapshot(...)` |
| 7–14d | Iceberg snapshot rollback (AUD-OPS-015 window) | S3 version restore + catalog PITR (§4) | — | rollback / §4 |
| 14–90d | §4 coordinated restore | §4 coordinated restore | — | Aurora PITR (≤35d for the catalog!) + `s3-version-restore.sh` |
| > 90d | gone in-region; CRR replica noncurrent window (180d) if applied | same | — | replica copy-back (manual) |

Note the asymmetry: S3 versions live 90d but the **catalog** (Aurora) only has 35d PITR — beyond
35d you cannot PITR the pointers and must instead restore S3 objects to a point where the CURRENT
catalog's pointers resolve (i.e., undelete files, not time-travel the table definition).

## 4. Coordinated Aurora-catalog + S3-warehouse restore (design)

**The sharpest AUD-OPS-013 gap.** The Iceberg REST catalog is JDBC-backed **on the same Aurora
cluster** (`CATALOG_URI=jdbc:postgresql://…:5432/iceberg_catalog`). An Aurora PITR to T-x
resurrects catalog pointers to metadata files that maintenance may have physically expired since T
(7d/14d snapshot TTL, 3d orphan floor). The two restores MUST be coordinated to the same T:

0. **Freeze writers** (stop the bleeding, prevents divergence during restore):
   `kubectl -n kafka-connect scale deploy --all --replicas=0` (Bronze landing) + suspend the Spark
   CronWorkflows (`kubectl -n argo patch cronworkflow <bronze-maintenance|bronze-raw-retention|v4-silver|v4-gold|v4-maintenance> --type merge -p '{"spec":{"suspend":true}}'`).
   Collector keeps accepting; events buffer in Kafka (7d retention) — no event loss while frozen.
1. **Pick T** — the latest instant known-good. Must be ≤ 35d ago (Aurora PITR limit) and the S3
   noncurrent versions for [T, now] must still exist (≤ 90d).
2. **RB-1** — Aurora PITR to a NEW cluster at T. For a warehouse-only incident, only the
   `iceberg_catalog` database matters: dump it from the restored cluster and load it over the live
   one (`pg_dump -d iceberg_catalog | psql …`) — do NOT repoint the app databases unless they are
   also affected.
3. **S3 point-in-time restore** of the affected table prefixes to the SAME T:
   `tools/dr/s3-version-restore.sh --bucket brain-bronze-prod-<acct> --prefix brain_bronze/<table>/ --timestamp <T> [--execute]`
   (dry-run first; the script only writes new versions/markers — itself reversible).
4. **Restart iceberg-rest** (drop pooled catalog connections): `kubectl -n iceberg-rest rollout restart deploy`.
5. **Verify** — via duckdb-serving (`POST /v1/query`): `SELECT count(*) FROM iceberg.brain_bronze.<table>` + `SELECT * FROM iceberg_snapshots('iceberg.brain_bronze.<table>') ORDER BY timestamp_ms DESC LIMIT 5`; snapshot ids must match the catalog's current pointer; a few `mv_*` serving reads 200. Restart duckdb-serving too (fresh epoch over the restored catalog): `kubectl -n duckdb-serving rollout restart deploy`.
6. **Unfreeze** — re-enable Connect (it resumes from its committed offsets; events buffered in
   Kafka land now — dedup for any overlap lives in Silver, by design), un-suspend crons, run one
   v4-silver + v4-gold cycle, reconcile row counts.

**Status: HYPOTHESIS.** Believed viable within 90d (audit AUD-OPS-013); **never executed**.
The fire drill ([dr-fire-drill.md](dr-fire-drill.md), pending) proves or refutes it against a
test cluster + one Bronze table. Until then treat step 2's dump-over-live as owner-approved-only.

## 5. Aurora cross-region snapshot copy (manual, monthly — ADR-0011)

Until automated cross-region backup replication is justified, copy the newest automated snapshot
to ap-south-2 monthly (first business day; ~minutes, storage-only cost):

```bash
SNAP=$(aws rds describe-db-cluster-snapshots --db-cluster-identifier brain-prod-postgres \
  --snapshot-type automated --query 'reverse(sort_by(DBClusterSnapshots,&SnapshotCreateTime))[0].DBClusterSnapshotIdentifier' --output text)
aws rds copy-db-cluster-snapshot --region ap-south-2 \
  --source-db-cluster-snapshot-identifier "arn:aws:rds:ap-south-1:<acct>:cluster-snapshot:${SNAP}" \
  --target-db-cluster-snapshot-identifier "brain-prod-monthly-$(date +%Y%m)" \
  --kms-key-id <ap-south-2 CMK for RDS copies>
# prune copies older than 3 months in ap-south-2
```

## 6. Neo4j restore paths (backups are Wave-1 machinery, AUD-OPS-012)

1. **EBS snapshot (block-level, crash-consistent)** — volume/AZ loss: create a volume from the
   latest DLM snapshot (tagged from PVC `data-neo4j-0`, ns `neo4j`), pre-bind a PV/PVC to it,
   delete/rescale the StatefulSet so `neo4j-0` mounts the restored volume.
2. **Dump (logical, application-consistent)** — corruption / bad upgrade / move: scale
   `neo4j` to 0, run a pod mounting the data PVC with image `neo4j:5.26.0-community` (must match
   the chart), `aws s3 cp s3://brain-neo4j-backups-prod-<acct>/dumps/<latest>.dump …` then
   `neo4j-admin database load neo4j --from-path=…`, scale back up. Mirrors the backup CronJob's
   stop/dump/start choreography in reverse (infra/helm/neo4j-backup/templates/cronjob.yaml).
3. **Rebuild from the lakehouse** — **HYPOTHESIS, untested**: `silver_identity_map` holds the
   bi-temporal ALIAS_OF intervals and the ops export holds hash→brain_id links; a rebuild job
   would re-create nodes/edges from them. No such job exists. Do not count this as a backup;
   it is why the graph loss RPO is 24h (dump cadence), not "infinite".

After ANY Neo4j restore: run the identity-export cron once (`argo submit --from cronworkflow/identity-export -n argo`)
and verify `silver_identity_link` counts before trusting attribution.

## 7. What is deliberately NOT backed up

- **Raw PII lanes** (`*_raw_connect`): 7d row-TTL + `retain_last=1` is a privacy contract
  (ADR-0006 D4) — recovery windows must NOT be widened. Erasure (RTBF) must survive every restore:
  re-run the erasure orchestrator for any subject erased between T and now after a §4 restore.
- **Redis** contents, **Spark checkpoints** (`_checkpoints/` — retired path), **Kafka** topic data
  beyond retention, **ECR** images (CI rebuilds from git).

## 8. Standing hygiene

- The maintenance crons ARE the retention machinery — if `bronze-maintenance`/`v4-maintenance`
  are failing (audit noted every prod Argo workflow Error at measurement time), the *actual*
  snapshot window silently grows (cost) or the D4 window silently widens (privacy). Alert on
  cron failure, not just on data staleness.
- Quarterly: re-run the fire drill checklist; after ANY change to bucket lifecycle, snapshot
  TTLs, or the catalog deployment, update §2/§3 in the same PR (this file is the contract).
