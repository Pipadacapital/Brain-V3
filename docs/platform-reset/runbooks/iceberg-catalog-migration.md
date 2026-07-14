# Runbook — Iceberg REST catalog backend cutover: SQLite → Aurora PostgreSQL

**Scope:** prod EKS `brain-prod`, ap-south-1, account `380254378136`.
**Owner sign-off required.** This is a **STAGED, MANUAL, maintenance-window** apply — it is deliberately
NOT auto-synced (`iceberg-rest-prod` ArgoCD app has no automated sync; see
`infra/argocd/envs/prod/iceberg-rest.yaml`).
**ADR:** `docs/platform-reset/adr/adr-0002-iceberg-catalog-and-trino-topology-rebuild.md` (§Decision #1, §Rollback).
**Related:** ADR-0003 (Aurora sizing / co-located `iceberg_catalog` DB), the historical
`iceberg-catalog-sqlite-lock` learnings (the incident class this retires).

The Iceberg REST catalog is the namespace→table pointer SoR that EVERY writer shares (Kafka-Connect
Bronze landing commits, the Spark/DuckDB Silver→Gold transform commits, and Trino serving DDL/reads).
The pointers are metadata only; the actual Iceberg DATA + manifest files live in S3
(`s3://brain-bronze-prod-380254378136/`) and are **not** touched by this migration — only the
catalog table registrations move.

---

## 0. Why

- SQLite is a single-writer file → the *"database table is locked: iceberg_tables"* incident class,
  mitigated today only by pinning `CATALOG_CLIENTS=1` (a throughput ceiling, not a fix) and a single
  replica (a SPOF).
- Aurora PG gives optimistic compare-and-swap catalog commits (safe with `replicaCount: 2`), plus
  Aurora's 35-day PITR — making catalog DR trivial and consistent with the data snapshots.

> **Prod note:** the chart default backend is `sqlite` (rollback path) but prod EKS has, to date, run
> the postgres path via `values-prod.yaml` (there is no prod SQLite PVC). If this catalog was in fact
> already commissioned on Aurora, this runbook is the **verification + re-registration** procedure and
> the "migrate from SQLite" steps (§3) apply only to a genuine SQLite→PG transition (e.g. an env still
> on the file backend, or a prod recommission). Confirm the live backend first (§2, step 1).

---

## 1. Preconditions (do NOT start the window until all are true)

- [ ] Aurora Serverless v2 prod cluster reachable from the `iceberg-rest` namespace (same VPC/SG).
- [ ] The `iceberg-rest-catalog-db` k8s Secret exists in the `iceberg-rest` namespace with keys
      `jdbc-user` / `jdbc-password` for the **dedicated** catalog role (NOT the app DB owner). Synced
      from AWS Secrets Manager via ESO. Verify:
      `kubectl -n iceberg-rest get secret iceberg-rest-catalog-db -o jsonpath='{.data}' | jq 'keys'`
- [ ] A fresh Aurora snapshot taken (belt-and-braces on top of continuous PITR).
- [ ] A **quiesce plan**: pause all catalog writers for the window — Kafka-Connect Bronze sink,
      the transform cronworkflows (Argo), and any manual Trino DDL. Serving reads may continue read-only
      but expect them to fail during the brief cutover; announce the window.
- [ ] Change ticket + rollback owner assigned.

---

## 2. Create the dedicated catalog database + role (one-time)

Connect to the prod Aurora **writer** endpoint as an admin (via the bastion/SSM tunnel — the API and
DB are private). Create a DEDICATED database + least-privilege role. **Never point at the app DB.**

```sql
-- Dedicated catalog DB, co-located on the prod Aurora cluster (ADR-0003). Separate DB, not schema-in-app-DB.
CREATE DATABASE iceberg_catalog;

-- Dedicated least-privilege role (credentials live in the iceberg-rest-catalog-db Secret / Secrets Manager).
CREATE ROLE iceberg_catalog_rw LOGIN PASSWORD '<from-secrets-manager>';
GRANT ALL PRIVILEGES ON DATABASE iceberg_catalog TO iceberg_catalog_rw;

-- Ensure the role owns objects it will create (Iceberg auto-creates iceberg_tables /
-- iceberg_namespace_properties / iceberg_views on first connect).
\connect iceberg_catalog
GRANT ALL ON SCHEMA public TO iceberg_catalog_rw;
ALTER SCHEMA public OWNER TO iceberg_catalog_rw;
```

Iceberg's `JdbcCatalog` **auto-initializes** its three metadata tables on first connect
(`jdbc.schema-version` handling is built in) — no manual DDL for the catalog tables themselves.

**Step 1 — confirm the current live backend** before anything else:

```bash
kubectl -n iceberg-rest get deploy brain-prod-iceberg-rest -o yaml \
  | grep -A2 'name: CATALOG_URI'
# jdbc:sqlite:...  → genuine SQLite→PG migration, do §3.
# jdbc:postgresql:... → already on Aurora; skip §3, go to §4 verification only.
```

---

## 3. Migrate / re-register existing namespaces + tables (only for a real SQLite→PG move)

The catalog rows are just `(catalog_name, table_namespace, table_name, metadata_location, ...)` pointers
into S3. There are two supported ways to move them; pick ONE.

### 3a. Preferred — re-register from S3 via a transient reader (portable, no row surgery)

For each existing Iceberg table, capture its current `metadata_location` from the **live SQLite catalog**,
then `register_table` into the PG catalog pointing at the SAME S3 metadata file. Nothing is rewritten in S3.

1. Snapshot the SQLite pointer set from the running (or a copied) catalog file:
   ```bash
   # brain-iceberg-catalog.db lives on the SQLite PVC mount (/catalog). Copy it out first.
   sqlite3 brain-iceberg-catalog.db \
     "SELECT table_namespace, table_name, metadata_location FROM iceberg_tables;" \
     > /tmp/catalog-pointers.tsv
   sqlite3 brain-iceberg-catalog.db \
     "SELECT DISTINCT table_namespace FROM iceberg_tables;" \
     > /tmp/catalog-namespaces.tsv
   ```
2. Point a transient engine (Spark/Trino/pyiceberg) at the **PG-backed** REST catalog and, per row,
   create the namespace then register the existing metadata file:
   ```sql
   -- Trino example (per namespace, then per table)
   CREATE SCHEMA IF NOT EXISTS iceberg.brain_bronze;
   CALL iceberg.system.register_table(
     schema_name => 'brain_bronze',
     table_name  => 'collector_events_connect',
     metadata_file_location => 's3://brain-bronze-prod-380254378136/.../metadata/NNNNN.metadata.json'
   );
   ```
   (pyiceberg `catalog.register_table(identifier, metadata_location)` is the scriptable equivalent —
   loop over `/tmp/catalog-pointers.tsv`.) Preserve the exact `metadata_location` so the FULL snapshot
   history + schema/partition evolution carry over untouched.
3. Re-apply any namespace properties captured from `iceberg_namespace_properties`.

### 3b. Alternative — direct row copy (only if 3a is impractical for volume)

Dump `iceberg_tables`, `iceberg_namespace_properties`, `iceberg_views` from SQLite and INSERT into the
PG `iceberg_catalog` tables **after** the REST server has auto-created them once (so schema/types match
the running Iceberg version). Verify `metadata_location` strings are copied verbatim. Higher-risk (schema
drift between SQLite and PG DDL) — prefer 3a.

> Data files are never moved. If a table's pointers are wrong post-migration, re-run `register_table`
> against the correct S3 `metadata.json` — the S3 objects are the source of truth.

---

## 4. Cutover (maintenance window)

1. **Quiesce writers:** suspend Kafka-Connect Bronze sink + the transform cronworkflows; stop manual DDL.
2. **Flip the backend flag.** `values-prod.yaml` already carries `catalog.backend: postgres` on this
   branch — cutover = merging/promoting this change through the normal release→master gate so ArgoCD
   renders the postgres deployment. (Emergency in-window only: `kubectl -n argocd app sync
   iceberg-rest-prod` after the values are on the tracked revision.) Do **NOT** hand-edit the live
   Deployment — it will drift and self-heal.
3. **Verify the pod came up on PG** (see §5). Roll pods if needed:
   `kubectl -n iceberg-rest rollout status deploy/brain-prod-iceberg-rest`.
4. **Un-quiesce writers** once §5 passes: resume the Bronze sink + transform cronworkflows.
5. Sync order matters: catalog FIRST, then `trino`, then the transform cronworkflows (per the ArgoCD
   app comment). Do not sync Trino before the catalog is verified green.

---

## 5. Verify (all must pass before declaring success)

```bash
# Backend is postgres, pods Ready, 2 replicas.
kubectl -n iceberg-rest get deploy brain-prod-iceberg-rest -o yaml | grep 'jdbc:postgresql'
kubectl -n iceberg-rest get pods -l app.kubernetes.io/name=iceberg-rest

# REST config endpoint healthy.
kubectl -n iceberg-rest exec deploy/brain-prod-iceberg-rest -- \
  curl -fsS http://localhost:8181/v1/config

# Namespaces + tables enumerate (counts match the pre-migration SQLite snapshot).
kubectl -n iceberg-rest exec deploy/brain-prod-iceberg-rest -- \
  curl -fsS http://localhost:8181/v1/namespaces
kubectl -n iceberg-rest exec deploy/brain-prod-iceberg-rest -- \
  curl -fsS 'http://localhost:8181/v1/namespaces/brain_bronze/tables'
```

- [ ] Namespace count == pre-migration `catalog-namespaces.tsv` line count.
- [ ] Table count per namespace == pre-migration count (spot-check `brain_bronze`, `brain_silver`, `brain_gold`).
- [ ] A **read** through Trino serving (`SELECT count(*) FROM iceberg.brain_gold.<a known mart>`) returns
      the expected non-zero rows.
- [ ] A **write** commit succeeds: run ONE small transform job (or a manual Trino `CREATE TABLE ... AS
      SELECT` in a scratch namespace) and confirm the new pointer lands in PG, then drop it.
- [ ] No `iceberg_tables ... locked` errors in pod logs (the class this migration retires).
- [ ] `replicaCount: 2` pods both serve concurrently with no CAS-conflict errors.
- [ ] Catalog metadata visible in Aurora:
      `SELECT count(*) FROM iceberg_tables;` on `iceberg_catalog`.

Leave the old SQLite PVC/file **intact and un-retired** for the agreed bake period (recommend ≥ 1 week
of green writes) before deleting it.

---

## 6. Rollback

Rollback is a flag flip; it is safe because the change is additive.

1. **Revert the flag:** drop `catalog.backend: postgres` from `values-prod.yaml` (or `git revert` the
   promotion PR). The chart default is `sqlite`; ArgoCD re-renders the SQLite (PVC-backed) deployment,
   which self-heals.
2. **Caveat (prod-specific):** if prod had NO prior SQLite PVC, a raw revert re-introduces an EMPTY
   SQLite catalog + the SPOF. In that case DO NOT revert to an empty SQLite — instead recover the
   on-Aurora catalog via **Aurora PITR** to just before the incident, and keep the postgres backend.
   The SQLite path is a true rollback ONLY when a populated pre-cutover SQLite file still exists.
3. If §3a was used, rollback to SQLite is loss-free (the SQLite file was never modified — reads came
   from it, writes went to PG). Simply repoint and resume.
4. Re-quiesce/un-quiesce writers around the rollback the same way as the cutover (§4).

## 7. Post-migration cleanup (only after bake period)

- [ ] Delete the SQLite PVC (`brain-prod-iceberg-rest-catalog`) and archive the `.db` file to S3 cold
      storage for audit.
- [ ] Confirm `CATALOG_CLIENTS=1` is NOT set on the postgres path (PG needs no single-connection pin;
      the chart only emits it on the sqlite backend).
- [ ] Update `MEMORY.md` / ADR-0002 status Proposed → Accepted, and record the migration date.
