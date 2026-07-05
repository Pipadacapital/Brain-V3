# Runbook — Local dev startup (one command)

Bring a fresh clone to a fully usable Brain V4 stack with **one command**. This
runbook is grounded in `tools/dev/dev-up.sh`, `package.json` scripts, and
`docker-compose.yml` as they exist today.

---

## TL;DR

```sh
pnpm dev:up
```

That runs `tools/dev/dev-up.sh`, which is ordered, idempotent, and re-runnable.

Tear down:

```sh
pnpm down            # docker compose down (keeps volumes)
pnpm down -v         # also wipe volumes for a true cold start
```

---

## What `pnpm dev:up` does (7 ordered steps)

Source of truth: `tools/dev/dev-up.sh`. Compose profiles used:
`--profile core --profile ai`. (`core` folds in the former `ingest` + `lakehouse`
infra AND the `kafka-connect` Bronze landing writer (ADR-0010) — Bronze landing
comes up with the infra step; there is no host-run Spark sink to launch anymore.)

| # | Step | What | Why ordered here |
| --- | --- | --- | --- |
| 1 | preflight | ensure `.env.local-prod` exists (copy from `.env.local-prod.example` if missing) | apps + migrate read it |
| 2 | db | `docker compose ... up -d --wait postgres` (Postgres only) | migrations must run **before** anything reads PG |
| 3 | migrate | `( set -a; . .env.local-prod; set +a; APP_ENV=local-prod pnpm migrate )` | sourced in a **subshell** so `NODE_ENV=production` does not leak into `next dev` |
| 4 | infra | bring up the rest (core + ai, incl. `kafka-connect` + `kafka-connect-init`) and **poll health** (`compose_up_healthy`) | does NOT use `up --wait` — one-shot init containers exit 0 mid-wait and would abort it |
| 5 | bootstrap | `pnpm bootstrap` → seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets) | apps need the keyring/DEK to start |
| 6 | refresh | `ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh` → one-shot Silver→Gold→Trino serving views | dashboards render honest-empty, not 500, on a cold DB |
| 7 | apps | `turbo run dev` for `@brain/core`, `@brain/web`, `@brain/collector`, `@brain/stream-worker` | the app tier |

---

## Compose profiles (run a subset)

| Script | Profiles | Brings up |
| --- | --- | --- |
| `pnpm dev:up` | core + ai | full stack, ordered (incl. the `kafka-connect` Bronze landing) — recommended |
| `pnpm dev` | core + ai | full stack, single `up --wait` (no migrate-ordering safety) |
| `pnpm dev:core` | core | infra (Postgres, Kafka, MinIO, Iceberg-REST, Trino, kafka-connect, …) + web/core deps |
| `pnpm dev:ingest` | core | infra + collector + stream-worker apps |
| `pnpm dev:full` | core + full-obs + debug + ai | all infra incl. tracing/exporters, no apps |

> Profiles: **core** (default infra: kafka, postgres, neo4j, redis, minio,
> iceberg-rest, trino, localstack, apicurio, pgbouncer), **full-obs** (tempo, loki,
> otel-collector), **debug** (kafka-exporter), **ai** (litellm — currently
> commented out in compose, as are prometheus + grafana; re-enable by uncommenting).

---

## Bronze landing (the compose `kafka-connect` service)

The Kafka Connect Iceberg sink is the **sole** Bronze landing writer (ADR-0010,
cutover executed 2026-07-05 — the host Spark-SS sink `bronze_landing.py` /
`dev-bronze-streaming.sh` is removed). It is an ordinary compose service in the
`core` profile (`network_mode: service:kafka`, so the broker's `localhost:9092`
advertised listener resolves): the collector lane lands **verbatim** into
`brain_bronze.collector_events_connect` (operational readers use the Trino lift
view `collector_events_connect_lifted`) and the nine connector `*.raw.v1` lanes
land into `brain_bronze.<lane>_raw_connect` — each auto-created on that lane's
FIRST record (until then the table does not exist, and the Silver raw-normalize
jobs skip it cleanly). Bronze is append-only under this writer; dedup lives in
Silver (the R2/R3 pixel admission gate also lives in Silver). Connector configs
are `infra/kafka-connect/*.json`, registered idempotently by the one-shot
`kafka-connect-init` service.

**Nothing to launch, nothing to wipe:** the service comes up with the infra step
of `pnpm dev:up`, and exactly-once offsets live IN the Iceberg snapshot metadata
(commit coordination over the `control-iceberg` topic) — there is no Spark
checkpoint volume anymore.

```sh
curl -s localhost:8083/connectors | jq .    # 10 connectors registered
docker compose restart kafka-connect        # restart the landing writer
docker logs brainv3-kafka-connect-1 2>&1 | grep "Commit complete"
```

> **Memory:** 1G worker heap (`KAFKA_HEAP_OPTS`) inside a 2g container cap with
> `oom_score_adj: -600` (ingest-critical, protected) — see
> `docs/ops/local-memory-budget.md`. Net swing vs the retired host Spark sink:
> −7g Spark container, +2g here.

---

## Medallion refresh loop

`pnpm dev:v4-refresh` → `tools/dev/v4-refresh-loop.sh` runs Spark Silver→Gold and
SYNC-refreshes the Trino serving views. `ONESHOT=1` runs it once (used by step 6);
omit `ONESHOT` to run it as a continuous loop while developing.

```sh
ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh   # one pass
APP_ENV=local-prod pnpm dev:v4-refresh             # continuous loop
```

> Do NOT `source .env.local-prod` before the refresh: its Spark steps run in
> containers on the compose network and would inherit the host `S3_ENDPOINT=
> http://localhost:9000`, which is unreachable inside containers (MinIO is
> `minio:9000` there). The run scripts fall back to the correct `minio:9000`.

---

## Pixel tunnels (optional, for storefront pixel testing)

| Script | Tool |
| --- | --- |
| `pnpm dev:pixel-named-tunnel` | named cloudflared tunnel (`tools/dev/pixel-named-tunnel.sh`) |
| `pnpm dev:pixel-ngrok-tunnel` | ngrok (`tools/dev/pixel-ngrok-tunnel.sh`) |
| `pnpm dev:tunnels` | combined (`tools/dev/tunnels.sh`) |

> A "pixel: no data" symptom in local dev is almost always a dead cloudflared
> tunnel or a ScriptTag not installed — infra, not pipeline.

---

## Cold-start gotchas (known-good fixes already in the scripts)

- After `pnpm down -v`, if core/stream-worker report `password auth failed for
  brain_app`, re-run `ALTER ROLE brain_app LOGIN;` (dev app runs as least-priv
  `brain_app`).
- `pnpm dev` (not `dev:up`) starts **all** profiles but skips the migrate-ordering
  safety — prefer `pnpm dev:up` for a true cold start.
- LocalStack Secrets Manager/KMS are ephemeral; after a volume wipe you re-run
  `pnpm bootstrap` (step 5 does this for you).

---

## Verify the stack is up

```sh
docker compose --profile core --profile full-obs --profile debug --profile ai ps -a
# expect: running+healthy, or exited 0 for one-shot init containers
```

App URLs: web `http://localhost:3000`, core API `http://localhost:3001`,
collector `http://localhost:8787`, Trino `http://localhost:8080`,
MinIO console `http://localhost:9001`.

> Optional dev data-store UIs (kafka-ui / pgAdmin / CloudBeaver / redis-commander)
> are launched separately via `~/.brain-devui/dev-ui.sh` (not part of `dev:up`).
