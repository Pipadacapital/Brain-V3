# Runbooks
- **GO-LIVE** — zero → serving traffic: the complete ordered prod bring-up (AUD-COST chain) — see GO-LIVE.md
- **DR** — disaster recovery: per-store RPO/RTO, backup inventory, recovery-window matrix, severity ladder, coordinated Aurora+S3 restore design (AUD-OPS-013) — see DR.md
- RB-1 Aurora PITR restore (restore-to-new-cluster + repoint) — see RB-1-aurora-pitr.md
- RB-2 EKS recovery (terraform + ArgoCD GitOps re-apply) — see RB-2-eks-recovery.md
- DR fire drill (coordinated Aurora-PITR + S3-version restore — **pending execution**) — see dr-fire-drill.md
- ~~RB-3 StarRocks rebuild-from-Iceberg~~ — **RETIRED (Brain V4): StarRocks is REMOVED.** Serving is Trino-over-Iceberg (`brain_serving.mv_*` Trino views); rebuild the medallion with `tools/dev/v4-refresh-loop.sh` (Spark Silver→Gold→`mv` SYNC refresh).
- RB-4 Local lakehouse (Iceberg REST catalog + MinIO) — see RB-4-local-lakehouse.md (**note: pre-V4 StarRocks/dbt/Redpanda framing; see that file's banner**)
- Rotate the `iceberg_catalog` DB password (owed ONCE after the AUD-INFRA-023 masking fix deploys) — see rotate-iceberg-catalog-db-password.md
- Kafka operations (prod) — Strimzi sync-safety: NEVER prune-sync strimzi-kafka-prod / NEVER Replace-sync neo4j-prod, PVC prune-guard annotate procedure + AUD-INFRA-002 root cause — see kafka-operations.md
Historical pointer: docs/04 §M.3 (Brain-docs) — SUPERSEDED for DR/RB-1/RB-2 (it predates
Aurora/ADR-0010/Trino; the in-repo files above are authoritative — AUD-OPS-013).
