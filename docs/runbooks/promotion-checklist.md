# Release → Master Promotion Checklist (DR-007 PC1/PC2)

Born from the 2026-07-19 resident-cutover incident: four environment gaps discovered serially in
prod, plus a merged-but-never-applied Terraform fix. These steps are the operator gate the CI
chain deliberately does not automate.

## Before merging the promotion PR
1. **Terraform is settled** (PC1). For every prod module the delta touches:
   `terraform -chdir=infra/terraform/envs/prod plan` must be **empty**, or the operator applies
   BEFORE merging (targeted `-target=` applies are fine and preferred while the Cost-Explorer
   anomaly monitor remains un-imported — a FULL apply would duplicate it; clear that import debt
   to make full applies safe again). The CI infra lane is PLAN-ONLY by design — a green infra
   check means "the plan parsed", not "the change is live".
2. **New deployment surfaces have soaked in staging** (PC2). Any new chart/Deployment (not a
   routine digest bump) must show N clean cycles in staging — for the resident worker: clean
   ticks in the pod log, not merely Running. Staging carrying the same broken pin as prod
   validates nothing; check the log, not the dashboard.

## After the deploy chain completes
3. Confirm ArgoCD convergence for every touched app (`Synced`/`Healthy` AND the live spec matches
   — an unpruned orphan can report Synced while stale copies keep running; prune is now on for
   cronworkflows, DR-007).
4. Run any data-platform runbook steps the delta shipped (catalog drops/renames are always
   images-first, drops-after).
