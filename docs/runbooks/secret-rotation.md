# Secret rotation — brain/prod/* (AUD-INFRA-017)

**Finding:** every `brain/prod/*` Secrets Manager entry has
`RotationEnabled=null` — only the RDS-managed master secret
(`rds!cluster-…`, managed rotation) ever rotates. Static DB-app / JWT-signing /
cookie / Kafka / Grafana credentials never change. Risk is contained today
(KMS CMK at rest + IRSA-scoped reads), but a leaked `jwt-signing-secret` or
`cookie-secret` is full session forgery.

**Decision (ratified by the finding's own remediation ordering):** manual
rotation runbooks FIRST (this file — cheap, auditable); a rotation Lambda for
`db/app-credentials` and a dual-key JWT scheme in core are **deferred follow-ups**,
not built here. Revisit when there is real tenant traffic or a compliance
requirement for automated rotation.

## How secret delivery works (read before rotating anything)

There are TWO layers, and several values are **duplicated across them**:

1. **Source-of-truth secrets** — `brain/prod/{db,app,kafka,grafana,apicurio}/…`
   (e.g. `brain/prod/app/jwt-signing-secret`, `brain/prod/db/app-credentials`).
2. **k8s env bundles** — `brain/prod/k8s/{core,collector,stream-worker,web,pgbouncer}-env`,
   `brain/prod/k8s/neo4j-auth`, `brain/prod/k8s/iceberg-rest-catalog-db`:
   flat JSON objects ESO (`infra/helm/external-secrets-config`) extracts into
   the k8s Secrets the pods `envFrom`. The seed scripts
   (`tools/deploy/seed-core-env.sh`, `seed-app-boot-secrets.sh`) **copy**
   source values into these bundles — rotating a source secret does NOT
   propagate on its own.

So every rotation is the same 5-step shape:

```
[1] generate new value  →  [2] put-secret-value on the SOURCE secret
→  [3] update every k8s/*-env bundle that embeds it
→  [4] force ESO refresh (or wait refreshInterval: 1h), THEN remove the annotation
→  [5] rollout-restart the consuming pods (env is read-at-start) + verify
```

Step 4 command (per bundle; AUD-INFRA-003 — always remove the annotation after
the sync lands, stale ones pollute out-of-band state):

```sh
kubectl -n <ns> annotate externalsecret <bundle> force-sync="$(date +%s)" --overwrite
# after `kubectl -n <ns> get secret <bundle>` shows a new resourceVersion:
kubectl -n <ns> annotate externalsecret <bundle> force-sync-
```

## Inventory → who consumes what

| Secret | Consumed via | Consumers to restart | Notes |
|---|---|---|---|
| `rds!cluster-…` (master) | direct (operators/one-shot jobs only) | none | AWS-managed rotation ON — nothing to do |
| `brain/prod/db/app-credentials` (`brain_app`) | embedded in `k8s/core-env`, `k8s/stream-worker-env`, `k8s/pgbouncer-env` (`DATABASE_URL`/userlist) | core, stream-worker, pgbouncer | `ALTER ROLE brain_app WITH PASSWORD …` on Aurora AFTER SM update; pooled conns keep working, new conns need the new value |
| `brain/prod/app/jwt-signing-secret` | embedded in `k8s/core-env` | core | **Rotating INVALIDATES every live session token** — do it in a maintenance window; users re-login. Dual-key (verify old+new) is the deferred core follow-up |
| `brain/prod/app/cookie-secret` | embedded in `k8s/core-env` | core | Same blast radius as JWT: live cookies stop validating |
| `brain/prod/kafka/credentials` | embedded in `k8s/*-env` bundles that carry `KAFKA_*` | collector, stream-worker, core, kafka-connect | Update the Strimzi KafkaUser/secret side in ns `kafka` first (see `docs/runbooks/kafka-operations.md`) |
| `brain/prod/k8s/neo4j-auth` (`NEO4J_AUTH`) | ESO → ns `neo4j` + password copied into `core-env`/`stream-worker-env` (`NEO4J_PASSWORD`) | neo4j STS, core, stream-worker | Change the password in Neo4j itself (`ALTER CURRENT USER …`) in the same window |
| `brain/prod/k8s/iceberg-rest-catalog-db` | ESO → ns `iceberg-rest` | iceberg-rest | Full dedicated runbook: `docs/runbooks/rotate-iceberg-catalog-db-password.md` |
| `brain/prod/grafana/credentials` | kube-prometheus-stack values | grafana pod | UI login only; no app coupling |
| `brain/prod/apicurio/credentials` | apicurio config | apicurio | Registry auth |
| `brain/prod/app/meta-app-secret`, `brain/prod/app/google-ads-client-secret` | embedded in `k8s/core-env` | core | Rotated at the PROVIDER (Meta/Google consoles), then mirrored here |
| `brain/connector/*` (runtime OAuth) | core connector-secret manager | none | Rotated by the product's reconnect flow — NOT hand-edited |

## Verification (every rotation)

- Consumer pods Ready after restart; no CrashLoop (`kubectl -n <ns> get pods`).
- One authenticated read against the rotated dependency (login for JWT/cookie;
  `SELECT 1` through pgbouncer for db-app; consumer-group describe for Kafka).
- The OLD value authenticates nothing (spot-check where cheap, e.g. psql with
  the old password must fail).
- No plaintext value in shell history / terminal scrollback — generate with
  `openssl rand -base64 32 | tr -d '/+='` piped straight into
  `aws secretsmanager put-secret-value`.

## Cadence

No timed cadence is mandated at this stage (cost-first posture). Rotate
IMMEDIATELY on: operator offboarding, any suspected leak (logs, screen-share,
committed value), or a provider-side breach notice. Reassess automated
rotation (Lambda + dual-key JWT) when tenant revenue depends on prod.
