# Runbooks
- **GO-LIVE** — zero → serving traffic: the complete ordered prod bring-up (AUD-COST chain) — see GO-LIVE.md
- RB-1 RDS PITR restore
- RB-2 EKS recovery (GitOps re-apply)
- ~~RB-3 StarRocks rebuild-from-Iceberg~~ — **RETIRED (Brain V4): StarRocks is REMOVED.** Serving is Trino-over-Iceberg (`brain_serving.mv_*` Trino views); rebuild the medallion with `tools/dev/v4-refresh-loop.sh` (Spark Silver→Gold→`mv` SYNC refresh).
- RB-4 Local lakehouse (Iceberg REST catalog + MinIO) — see RB-4-local-lakehouse.md (**note: pre-V4 StarRocks/dbt/Redpanda framing; see that file's banner**)
Full text: docs/04 §M.3 (Brain-docs).
