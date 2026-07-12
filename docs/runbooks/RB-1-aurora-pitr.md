# RB-1 — Aurora PITR restore (restore-to-new-cluster + repoint)

> AUD-OPS-013: this runbook existed only as an out-of-repo pointer (pre-Aurora "Brain-docs" §M.3).
> This is the real, current procedure. Context and objectives: [DR.md](DR.md).
> **PENDING EXECUTION:** never fire-drilled — see [dr-fire-drill.md](dr-fire-drill.md).

**Cluster:** `brain-prod-postgres` (Aurora Serverless v2, ap-south-1; PITR window 35 days).
**Databases on it:** `brain` (app + `ops` schema), **`iceberg_catalog`** (the Iceberg REST/JDBC
catalog — if THIS is why you're here, follow DR.md §4, which wraps this runbook).
**Consumers to repoint:** pgbouncer (`infra/helm/pgbouncer/values-prod.yaml` `upstream.host`) →
core/web via `DATABASE_URL`/`BRAIN_APP_DATABASE_URL`; DIRECT consumers: stream-worker
(session advisory locks — never pgbouncer), core migrate job (`DATABASE_URL_DIRECT`),
iceberg-rest (`CATALOG_URI`), Spark jobs (PG env), cron jobs.

## 0. Decide scope before touching anything

- **Whole-cluster incident** (deleted DB, failed migration, corruption): full procedure below.
- **`iceberg_catalog` only:** restore a new cluster (steps 1–3), then `pg_dump` that ONE database
  from the restored cluster and load it over the live one (DR.md §4 step 2) — skip the repoint,
  delete the restored cluster after.
- Aurora PITR restores **the whole cluster**; you cannot PITR one database. Restore-to-new is the
  only mode — never restore over the live cluster.

## 1. Freeze writers (SEV-1 discipline: nothing may widen the divergence)

```bash
kubectl -n kafka-connect scale deploy --all --replicas=0        # Bronze landing off (events buffer in Kafka, 7d)
for cw in bronze-maintenance bronze-raw-retention v4-silver v4-gold v4-maintenance; do
  kubectl -n argo patch cronworkflow "$cw" --type merge -p '{"spec":{"suspend":true}}'; done
kubectl -n core scale deploy core --replicas=0                  # optional for app-DB incidents; collector can stay up
kubectl -n stream-worker scale deploy stream-worker --replicas=0
```

## 2. Restore to a NEW cluster at T

```bash
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier brain-prod-postgres \
  --db-cluster-identifier brain-prod-postgres-restore-$(date +%Y%m%d%H%M) \
  --restore-to-time "<T, e.g. 2026-07-10T02:00:00Z>" \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=2 \
  --vpc-security-group-ids <same SGs as source> \
  --db-subnet-group-name <same subnet group as source>
# then create the instance in the restored cluster:
aws rds create-db-instance --db-cluster-identifier brain-prod-postgres-restore-... \
  --db-instance-identifier brain-prod-postgres-restore-...-1 \
  --db-instance-class db.serverless --engine aurora-postgresql
```

Wait for `available`; note the new **writer endpoint**.

## 3. Verify the restored data BEFORE repointing

```bash
psql "postgres://brain:<pw>@<restored-writer>:5432/brain" -c "select max(created_at) from connectors.connector_instance;"
psql "postgres://brain:<pw>@<restored-writer>:5432/iceberg_catalog" -c "select count(*) from iceberg_tables;"
```

Sanity: timestamps ≤ T; row counts plausible. If restoring for the catalog, STOP here and go to
DR.md §4 (dump/load `iceberg_catalog` only).

## 4. Repoint (full-cluster incident only)

Same credentials work (users/passwords restore with the cluster).

1. **pgbouncer:** edit `infra/helm/pgbouncer/values-prod.yaml` `upstream.host:` → restored writer
   endpoint; commit via the release flow; `argocd app sync pgbouncer-prod`. Core/web need no env
   change (they point at `pgbouncer.pgbouncer.svc.cluster.local:6432`).
2. **Direct consumers — Secrets Manager** (keys per `prod-secrets-worksheet.md`): update the host in
   - `brain/prod/k8s/core-env` → `DATABASE_URL_DIRECT`
   - `brain/prod/k8s/stream-worker-env` → `DATABASE_URL` (direct by design)
   - `brain/prod/k8s/iceberg-rest-env` → `CATALOG_URI`
   - any Spark/cron env carrying a PG host
   ESO re-syncs within its refresh interval; force with
   `kubectl annotate externalsecret -A --all force-sync=$(date +%s) --overwrite`.
3. **Roll deployments** so pods pick up the refreshed Secrets:
   `kubectl -n core rollout restart deploy core; kubectl -n stream-worker rollout restart deploy; kubectl -n iceberg-rest rollout restart deploy`.

## 5. Unfreeze + verify

```bash
kubectl -n kafka-connect scale deploy --all --replicas=1
for cw in bronze-maintenance bronze-raw-retention v4-silver v4-gold v4-maintenance; do
  kubectl -n argo patch cronworkflow "$cw" --type merge -p '{"spec":{"suspend":false}}'; done
kubectl -n core scale deploy core --replicas=<previous>; kubectl -n stream-worker scale deploy stream-worker --replicas=<previous>
```

- core `/health` 200; a collector event lands in `brain_bronze.collector_events_connect` within ~1 min.
- One v4-silver + v4-gold cycle green; `mv_*` reads 200.
- **RTBF invariant:** re-run erasure for any subject erased in (T, now] — a PITR resurrects
  erased PG rows (DR.md §7).

## 6. Decommission

Keep the OLD cluster (renamed, stopped if possible) for 7 days as evidence/fallback, then delete.
Delete the restore cluster immediately if you only harvested `iceberg_catalog`.
Update the Route53/console notes if any endpoint name is referenced elsewhere
(grep `cluster-cjy6iicow625` — the pgbouncer values file carries the literal host).
