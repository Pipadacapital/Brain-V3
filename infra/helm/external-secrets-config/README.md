# external-secrets-config — Brain secret delivery (AUD-COST-004)

Every workload chart consumes a pre-provisioned k8s Secret via `envSecretName`
(`envFrom.secretRef`). This chart is the **producer** that was missing: a
`ClusterSecretStore` (AWS Secrets Manager, ap-south-1, via the ESO controller's
IRSA role) plus one `ExternalSecret` per consumed Secret.

Installed as two ArgoCD Applications (`infra/argocd/envs/prod/external-secrets.yaml`):

1. `external-secrets-prod` — the upstream External Secrets Operator (CRDs +
   controller, ns `external-secrets`, IRSA), sync-wave −3.
2. `external-secrets-config-prod` — this chart, sync-wave −2 (after the CRDs,
   before every workload app).

## Expected AWS Secrets Manager entries (prod)

Naming follows the terraform secrets module convention
`${project}/${environment}/...`. Each value is a **flat JSON object**; every
key becomes a Secret key (= env var for `envFrom` consumers).

| SM secret name | → k8s Secret (namespace) | Must carry (non-exhaustive) |
| --- | --- | --- |
| `brain/prod/k8s/core-env` | `core-env` (ns `core` **and** ns `argo`) | `DATABASE_URL` + `BRAIN_APP_DATABASE_URL` (host = `pgbouncer.pgbouncer.svc.cluster.local:6432`, **not** Aurora directly), `DATABASE_URL_DIRECT` (direct Aurora — the migration PreSync Job, AUD-COST-011), `REDIS_URL`, `KAFKA_BROKERS`, `DUCKDB_SERVING_HOST`, `ICEBERG_REST_URI`, `AWS_REGION=ap-south-1`, `ICEBERG_WAREHOUSE` (= `s3://<warehouse_bucket_name>/` — the ONE medallion warehouse root, AUD-COST-016), `CHECKPOINT_LOCATION` (durable `s3a://<warehouse bucket>/_checkpoints`; `S3_ENDPOINT` stays UNSET on real S3/IRSA), `COLLECTOR_TOPIC`/`BACKFILL_TOPIC`/`TOPIC_ENV_PREFIX`, `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` (see AUD-COST-006), `AUDIT_CHECKPOINT_BUCKET`, connector/AI-gateway secrets |
| `brain/prod/k8s/web-env` | `web-env` (ns `web`) | `BFF_BASE_URL` / `CORE_API_URL` |
| `brain/prod/k8s/collector-env` | `collector-env` (ns `collector`) | `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, HMAC/pixel config |
| `brain/prod/k8s/stream-worker-env` | `stream-worker-env` (ns `stream-worker`) | `DATABASE_URL` (**direct** Aurora — session advisory leader lock, never pgbouncer), `KAFKA_BROKERS`, `DUCKDB_SERVING_HOST`, `NEO4J_*`, connector app creds (`META_APP_ID`/`META_APP_SECRET`, ...) |
| `brain/prod/k8s/pgbouncer-env` | `pgbouncer-env` (ns `pgbouncer`) | upstream admin credentials (`DB_USER`/`DB_PASSWORD`) |
| `brain/prod/k8s/iceberg-rest-catalog-db` | `iceberg-rest-catalog-db` (ns `iceberg-rest`) | exactly `jdbc-user`, `jdbc-password` (the iceberg-rest chart reads these two keys) |
| `brain/prod/k8s/neo4j-auth` | `neo4j-auth` (ns `neo4j`) | exactly `NEO4J_AUTH` = `neo4j/<password>` (official neo4j chart `passwordFromSecret` contract, AUD-COST-006); the same password backs `NEO4J_PASSWORD` in `core-env` / `stream-worker-env`, with `NEO4J_URI=bolt://neo4j.neo4j.svc.cluster.local:7687`, `NEO4J_USER=neo4j` |

The terraform `secrets` module creates ALL of these as SHELLS (the seven
`brain/prod/k8s/*` entries above plus the four legacy
`brain/prod/{db,kafka,grafana,apicurio}/...` ones) together with the ESO read
policy attached to the controller role `brain-prod-external-secrets`
(AUD-COST-017). Seeding is therefore a VALUE update
(`aws secretsmanager put-secret-value`), never resource creation; values are
filled by the operator and never stored in TF state.

## Rotation

`refreshInterval: 1h` — a rotated SM value lands in the k8s Secret within the
hour; pods consume env at start, so roll the Deployment to pick it up.
Secrets Manager stays the single source of truth (no `kubectl create secret`
stopgap — drift-prone and bypasses rotation).
