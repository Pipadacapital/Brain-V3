# Runbooks
- **GO-LIVE** — zero → serving traffic: the complete ordered prod bring-up (AUD-COST chain) — see GO-LIVE.md
- **DR** — disaster recovery: per-store RPO/RTO, backup inventory, recovery-window matrix, severity ladder, coordinated Aurora+S3 restore design (AUD-OPS-013) — see DR.md
- RB-1 Aurora PITR restore (restore-to-new-cluster + repoint) — see RB-1-aurora-pitr.md
- RB-2 EKS recovery (terraform + ArgoCD GitOps re-apply) — see RB-2-eks-recovery.md
- RB-6 Connector token read denied (backfill/sync `RECONNECT_REQUIRED` despite Healthy connector; IAM/SCP or missing `KMS_KEY_ID` — reconnect does NOT fix it) — see RB-6-connector-token-read-denied.md
- DR fire drill (coordinated Aurora-PITR + S3-version restore — **pending execution**) — see dr-fire-drill.md
- ~~RB-3 StarRocks rebuild-from-Iceberg~~ — **RETIRED (Brain V4): StarRocks is REMOVED.** Serving is Trino-over-Iceberg (`brain_serving.mv_*` Trino views); rebuild the medallion with `tools/dev/v4-refresh-loop.sh` (Spark Silver→Gold→`mv` SYNC refresh).
- RB-4 Local lakehouse (Iceberg REST catalog + MinIO) — see RB-4-local-lakehouse.md (**note: pre-V4 StarRocks/dbt/Redpanda framing; see that file's banner**)
- Rotate the `iceberg_catalog` DB password (owed ONCE after the AUD-INFRA-023 masking fix deploys) — see rotate-iceberg-catalog-db-password.md
- Kafka operations (prod) — Strimzi sync-safety: NEVER prune-sync strimzi-kafka-prod / NEVER Replace-sync neo4j-prod, PVC prune-guard annotate procedure + AUD-INFRA-002 root cause — see kafka-operations.md
Historical pointer: docs/04 §M.3 (Brain-docs) — SUPERSEDED for DR/RB-1/RB-2 (it predates
Aurora/ADR-0010/Trino; the in-repo files above are authoritative — AUD-OPS-013).

## Full index — every file in this directory, status-tagged (AUD-OPS-026)

Status legend: **CURRENT** = follow it · **SUPERSEDED → X** = do NOT follow, read X instead (banner inside) · **HISTORICAL** = executed/pre-V4 record, context only.

| Runbook | Status | One-liner |
|---|---|---|
| `GO-LIVE.md` | **CURRENT** | Zero → serving traffic: the complete ordered prod bring-up (AUD-COST chain) |
| `DR.md` | **CURRENT** | Disaster recovery: per-store RPO/RTO, backup inventory, recovery-window matrix, severity ladder (AUD-OPS-013) |
| `RB-1-aurora-pitr.md` | **CURRENT** | Aurora PITR restore-to-new-cluster + repoint (AUD-OPS-013) |
| `RB-2-eks-recovery.md` | **CURRENT** | EKS recovery: terraform + ArgoCD GitOps re-apply (AUD-OPS-013) |
| `dr-fire-drill.md` | **CURRENT (pending execution)** | Coordinated Aurora-PITR + S3-version-restore fire drill (AUD-OPS-013) |
| `eks-1-33-upgrade.md` | **CURRENT** | EKS 1.33 upgrade gates + extended-support cost trigger (AUD-INFRA-019 / AUD-OPS-028) |
| `eks-api-access.md` | **CURRENT** | EKS API access paths incl. SSM fallback (AUD-INFRA-008) |
| `secret-rotation.md` | **CURRENT** | Manual rotation runbook for all brain/prod/* secrets (AUD-INFRA-017) |
| `prod-secrets-worksheet.md` | **CURRENT** | GO-LIVE step-8 secret seeding worksheet **+ rotation appendix** (per-credential SM-entry map, ordered coupled rotation — AUD-OPS-024) |
| `adr-0010-kafka-connect-bronze.md` | **CURRENT** | Kafka Connect Bronze landing: ops notes, rollback (git revert), RTBF posture, **connector-registration-lost recovery** (AUD-OPS-018) |
| `kafka-operations.md` | **CURRENT** | Strimzi sync-safety hard rules + PVC prune guard (AUD-INFRA-002) |
| `rerun-medallion.md` | **CURRENT** | Re-run/backfill Silver→Gold + **the FULL_REFRESH watermark rule** (silently-wrong-marts trap — AUD-OPS-020) |
| `restart-services.md` | **CURRENT** | Per-service restart matrix: safety notes (leader lock, Connect commit window, Trino blast radius) + verification (AUD-OPS-021) |
| `investigate-oom.md` | **CURRENT** | Prod OOM chain: BFF-wide 500s→Trino first; symptom table + PromQL + bounded-heap knobs (AUD-OPS-022) |
| `dsar-manual-export.md` | **CURRENT** | Manual `customers/data_request` fulfilment: subject resolution, per-store brand-scoped export queries (AUD-OPS-043) |
| `rotate-iceberg-catalog-db-password.md` | **CURRENT** | Rotate the `iceberg_catalog` DB password (owed once after AUD-INFRA-023) |
| `enable-shopify-checkout-pixel.md` | **CURRENT** | Web Pixel activation for checkout events (verify blocks Trino-ported — AUD-OPS-025) |
| `enable-attribution-unlocks.md` | **CURRENT** | The three externally-gated attribution unlocks checklist |
| `local-dev-startup.md` | **CURRENT** | Fresh clone → full local V4 stack, one command |
| `enable-prod-cron-pipeline.md` | **SUPERSEDED → GO-LIVE.md steps 10–12 + rerun-medallion.md** | Retired dbt/StarRocks cron pipeline (AUD-OPS-019 banner inside) |
| `prod-deploy.md` | **SUPERSEDED → GO-LIVE.md** | Pre-Aurora/pre-un-gating prod turn-on (banner inside) |
| `adr-0006-cutover-and-prod.md` | **SUPERSEDED → adr-0010-kafka-connect-bronze.md** | Spark-SS landing cutover, superseded by ADR-0010 (banner inside) |
| `prod-m4-turn-on.md` | **HISTORICAL (executed)** | Module-level M4 apply detail; its "currently applied: bootstrap-only" baseline is stale — envs/prod is fully applied. GO-LIVE is the live path |
| `RB-4-local-lakehouse.md` | **HISTORICAL** | Local lakehouse bring-up, pre-V4 StarRocks/dbt/Redpanda framing (banner inside) |
| `RB-5-bronze-iceberg-cutover.md` | **HISTORICAL (executed)** | Bronze PG→Iceberg production cut-over (executed 2026-06; later superseded on the landing side by ADR-0010) |

Related, outside this directory: `docs/playbooks/brand-onboarding.md` (the <30-min go-live acceptance gate — AUD-OPS-023) · `docs/ops/rtbf-kafka-transport-policy.md` (Kafka-as-transient-transport RTBF policy — AUD-TP-23) · `docs/ops/batch-scheduling.md` · `tools/deploy/` (migration + Connect-reregister Jobs).
