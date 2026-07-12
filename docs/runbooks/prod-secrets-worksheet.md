# Prod secret-seeding worksheet (GO-LIVE step 8)

Account `380254378136`, ap-south-1. The 7 `brain/prod/k8s/*` Secrets Manager
shells already exist (terraform). Seeding = `aws secretsmanager put-secret-value`
with a **flat JSON** value; each key becomes an env var.

Legend: **[DERIVED]** I fill from infra (done below) · **[GEN]** I generate a
strong random at seed time · **[YOU]** you supply a real external credential ·
**[LATER]** not needed for first bring-up (connectors are reconnected in the UI
post-launch, GO-LIVE step 13).

**Do NOT commit a filled copy.** Fill a local copy or just tell me the [YOU]
values when we seed; I generate the rest.

---

## Reference values (already known)
- Aurora writer: `brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com:5432`
- Aurora reader: `brain-prod-postgres.cluster-ro-cjy6iicow625.ap-south-1.rds.amazonaws.com:5432`
- Aurora master user `brainadmin`; password in RDS-managed secret
  `arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN`
- Redis: `master.brain-prod-redis.5eykyx.aps1.cache.amazonaws.com:6379` (confirm TLS → `rediss://` if transit-encryption on)
- Kafka (after strimzi sync): `brain-prod-kafka-kafka-bootstrap.kafka.svc.cluster.local:9092`
- Trino (after trino sync): host `brain-prod-trino.trino.svc.cluster.local:8080` — confirm svc name at sync
- iceberg-rest (after sync): `http://brain-prod-iceberg-rest.iceberg-rest.svc.cluster.local:8181` — confirm svc name
- Warehouse: `s3://brain-bronze-prod-380254378136/` · checkpoints `s3a://brain-bronze-prod-380254378136/_checkpoints`
- Audit bucket: `brain-audit-prod-380254378136`
- Neo4j (after sync): `bolt://neo4j.neo4j.svc.cluster.local:7687`, user `neo4j`
- Region: `ap-south-1`

## DB user decision
Recommend a dedicated least-priv app role `brain_app` (generated password),
created from inside the VPC alongside the `iceberg_catalog` role (GO-LIVE step 8),
rather than shipping `brainadmin` to the app. **[GEN]** the password; same value
feeds `DATABASE_URL*` and `pgbouncer-env`.

---

## 1. `brain/prod/k8s/core-env` (→ ns core + argo)
| Key | Source |
|---|---|
| `DATABASE_URL`, `BRAIN_APP_DATABASE_URL` | [DERIVED+GEN] `postgres://brain_app:<pw>@pgbouncer.pgbouncer.svc.cluster.local:6432/brain` |
| `DATABASE_URL_DIRECT` | [DERIVED+GEN] `postgres://brain_app:<pw>@<aurora-writer>:5432/brain` |
| `REDIS_URL` | [DERIVED] `redis://master.brain-prod-redis…:6379` |
| `KAFKA_BROKERS`, `TRINO_HOST`, `ICEBERG_REST_URI` | [DERIVED] in-cluster DNS above |
| `AWS_REGION` | `ap-south-1` |
| `ICEBERG_WAREHOUSE`, `CHECKPOINT_LOCATION`, `AUDIT_CHECKPOINT_BUCKET` | [DERIVED] bucket values above (`S3_ENDPOINT` UNSET) |
| `COLLECTOR_TOPIC`/`BACKFILL_TOPIC`/`TOPIC_ENV_PREFIX` | [DERIVED] chart defaults |
| `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` | [DERIVED]+[GEN] password (shared with neo4j-auth) |
| connector / AI-gateway creds | [LATER] |

## 2. `brain/prod/k8s/web-env` (→ ns web)
| `BFF_BASE_URL` / `CORE_API_URL` | [DERIVED] `https://api.brain.pipadacapital.com` |

## 3. `brain/prod/k8s/collector-env` (→ ns collector)
| `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS` | [DERIVED+GEN] |
| HMAC / pixel signing secret | **[YOU or GEN]** — a signing key for the pixel; I can [GEN] unless you have one to reuse |

## 4. `brain/prod/k8s/stream-worker-env` (→ ns stream-worker)
| `DATABASE_URL` (**direct** Aurora — leader lock, never pgbouncer) | [DERIVED+GEN] |
| `KAFKA_BROKERS`, `TRINO_HOST`, `NEO4J_*` | [DERIVED+GEN] |
| `META_APP_ID`/`META_APP_SECRET`, other connector app creds | [LATER] |

## 5. `brain/prod/k8s/pgbouncer-env` (→ ns pgbouncer)
| `DB_USER` / `DB_PASSWORD` | [DERIVED] `brain_app` / [GEN] (same as app pw) |

## 6. `brain/prod/k8s/iceberg-rest-catalog-db` (→ ns iceberg-rest)
| exactly `jdbc-user` / `jdbc-password` | [DERIVED] `iceberg_catalog` / [GEN] (matches the DB role we create) |

## 7. `brain/prod/k8s/neo4j-auth` (→ ns neo4j)
| exactly `NEO4J_AUTH` = `neo4j/<password>` | [GEN] (same password as NEO4J_PASSWORD above) |

---

## Net: what I actually need from YOU
1. **Route53 zone** for `brain.pipadacapital.com` (for ACM cert) — *sharing later*.
2. **Pixel HMAC key** — reuse an existing one? Otherwise I [GEN].
3. **Nothing else** for first bring-up: all connector OAuth/app creds are [LATER]
   (reconnected in the UI post-launch). Everything else is [DERIVED]/[GEN].

## Also (not secrets) — GitHub repo settings for CI/CD
Settings → Secrets and variables → Actions:
- var `AWS_PROD_APPLY_ROLE_ARN` = `arn:aws:iam::380254378136:role/brain-prod-github-apply`
- var `AWS_ECR_PUSH_ROLE_ARN` = `arn:aws:iam::380254378136:role/brain-prod-github-ecr-push`
- var `ENVIRONMENT` = `prod`
- secret `GITOPS_TOKEN` = PAT with `contents:write`
- Settings → Environments → `production` → add required reviewers

---

## Appendix — Rotation (per-credential consumer map + ordered procedure) — AUD-OPS-024

Mechanism recap (`infra/helm/external-secrets-config/README.md`): SM is the single source of
truth; ESO copies a rotated value into the k8s Secret within **1h** (`refreshInterval`); pods
consume env **at start**, so every rotation ends with a Deployment roll
(`docs/runbooks/restart-services.md`). Force an immediate ESO refresh instead of waiting:
`kubectl annotate externalsecret <name> -n <ns> force-sync=$(date +%s) --overwrite`.

The risk this appendix closes: several credentials live in **multiple** SM entries — a partial
rotation (update one entry, miss another) is a self-inflicted auth outage.

### Credential → SM entries → deployments to roll

| Credential | SM entries carrying it (keys) | Roll (in this order) |
|---|---|---|
| **`brain_app` PG password** (ONE value, 4 entries) | `core-env` (`DATABASE_URL`, `BRAIN_APP_DATABASE_URL`, `DATABASE_URL_DIRECT`) · `collector-env` (`DATABASE_URL`) · `stream-worker-env` (`DATABASE_URL`) · `pgbouncer-env` (`DB_PASSWORD`) | pgbouncer → core → collector → stream-worker. **core-env is ALSO consumed by the argo cron pods** (`envSecretName: core-env`) — running workflows finish on the old value; the next scheduled run picks up the new one. |
| **Neo4j password** (ONE value, 3 entries) | `core-env` (`NEO4J_PASSWORD`) · `stream-worker-env` (`NEO4J_*`) · `neo4j-auth` (`NEO4J_AUTH=neo4j/<pw>`) | neo4j (StatefulSet) → core → stream-worker (+ next argo cron run) |
| **`iceberg_catalog` PG password** | `iceberg-rest-catalog-db` (`jdbc-user`/`jdbc-password`) — single entry | Dedicated runbook: `rotate-iceberg-catalog-db-password.md` |
| **Aurora master (`brainadmin`)** | RDS-managed secret (`rds!cluster-…`) — NOT in any `brain/prod/k8s/*` entry | Nothing to roll: only `tools/deploy/run-migrations.sh` consumes it, reading the RDS-managed secret at run time. Rotate via RDS; just don't rotate mid-migration. |
| **Pixel HMAC / signing key** | `collector-env` only | collector. **No dual-key acceptance window exists** — payloads signed with the old key are rejected the moment the new value is live; also update whatever holds the key on the storefront side (pixel install) in the same window. |
| **Redis** (currently no AUTH token derived) / **Kafka** (in-cluster, no SASL) | endpoint strings only — rotation N/A | — |
| **Connector OAuth tokens** | per-connector SM entries minted by the UI | Never hand-rotated: Reconnect in the UI re-mints; token-refresh crons (`meta-token-refresh`, `shopify-token-refresh`) handle expiry. |

### Ordered procedure — coupled DB rotation (the dangerous one: `brain_app`)

1. **Generate** the new password; do NOT alter the role yet.
2. **Write ALL FOUR SM entries** (`put-secret-value` with the full flat JSON — a put replaces
   the whole value, so re-serialize every key, not just the password).
3. **`ALTER ROLE brain_app PASSWORD '<new>'`** on Aurora (from inside the VPC, as brainadmin).
   Existing pooled connections survive an ALTER; only NEW connections need the new password —
   this is the gap window, keep steps 3–5 tight.
4. **Force-sync the four ExternalSecrets** (annotate, above) and confirm
   `kubectl get externalsecrets -A` → all `SecretSynced`.
5. **Roll in order:** pgbouncer first (it authenticates upstream to Aurora), then core,
   collector, stream-worker.
6. **Verify:** every `rollout status` clean; core `/health` 200; collector accepts a test
   event 2xx; stream-worker logs show the leader lock re-acquired; no PG `28P01`
   (password auth failed) in any log; next argo cron run (`v4-silver`) completes.

Same shape for Neo4j (change the password in Neo4j first — it is the server — then SM ×3,
force-sync, roll). **Rollback for any rotation:** write the OLD value back to every affected
SM entry, force-sync, re-roll — which is why step 1 of any rotation is "keep the old value
until verification passes".
