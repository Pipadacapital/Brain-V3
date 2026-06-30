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

## What `pnpm dev:up` does (8 ordered steps)

Source of truth: `tools/dev/dev-up.sh`. Compose profiles used:
`--profile core --profile ai`. (`core` folds in the former `ingest` + `lakehouse`
infra; the two Bronze Spark sinks are no longer containers — they run as one host
process started in step 5.)

| # | Step | What | Why ordered here |
| --- | --- | --- | --- |
| 1 | preflight | ensure `.env.local-prod` exists (copy from `.env.local-prod.example` if missing) | apps + migrate read it |
| 2 | db | `docker compose ... up -d --wait postgres` (Postgres only) | migrations must run **before** the Bronze sink reads PG |
| 3 | migrate | `( set -a; . .env.local-prod; set +a; APP_ENV=local-prod pnpm migrate )` | sourced in a **subshell** so `NODE_ENV=production` does not leak into `next dev` |
| 4 | infra | bring up the rest (core + ai) and **poll health** (`compose_up_healthy`) | does NOT use `up --wait` — one-shot init containers exit 0 mid-wait and would abort it |
| 5 | bronze | start the host combined Bronze sink (`tools/dev/dev-bronze-streaming.sh`), backgrounded → `/tmp/bronze-sink.log` | replaces the two removed `spark-bronze-sink` containers |
| 6 | bootstrap | `pnpm bootstrap` → seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets) | apps need the keyring/DEK to start |
| 7 | refresh | `ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh` → one-shot Silver→Gold→Trino serving views | dashboards render honest-empty, not 500, on a cold DB |
| 8 | apps | `turbo run dev` for `@brain/core`, `@brain/web`, `@brain/collector`, `@brain/stream-worker` | the app tier |

> **Why db→migrate→bronze (not bronze→migrate):** the combined Bronze sink's
> collector lane JDBC-reads PG (e.g. `pixel.pixel_installation`) for the R2
> install_token→brand lookup. On a cold, un-migrated DB that relation doesn't exist
> and the lane errors. Migrating first makes the cold start deterministic.

---

## Compose profiles (run a subset)

| Script | Profiles | Brings up |
| --- | --- | --- |
| `pnpm dev:up` | core + ai | full stack, ordered + host Bronze sink (recommended) |
| `pnpm dev` | core + ai | full stack + host Bronze sink, single `up --wait` (no migrate-ordering safety) |
| `pnpm dev:core` | core | infra (Postgres, Kafka, MinIO, Iceberg-REST, Trino, …) + web/core deps |
| `pnpm dev:ingest` | core | infra + collector + stream-worker apps |
| `pnpm dev:bronze-sink` | — | the host combined Bronze sink only (`dev-bronze-streaming.sh`) |
| `pnpm dev:full` | core + full-obs + debug + ai | all infra incl. tracing/exporters, no apps |

> Profiles: **core** (default infra: kafka, postgres, neo4j, redis, minio,
> iceberg-rest, trino, prometheus, grafana, localstack, apicurio, pgbouncer),
> **full-obs** (tempo, loki, otel-collector), **debug** (kafka-exporter), **ai** (litellm).

---

## Bronze streaming (the combined host Bronze landing)

Spark Structured Streaming is the **sole** Bronze landing compute (Kafka Connect
is retired). The two previously-separate compose sinks were **fused into one host
process** (`tools/dev/dev-bronze-streaming.sh` → `db/iceberg/spark/combined_bronze_sinks.py`):
ONE `docker run apache/spark` SparkSession sharing the Kafka container's netns
(`--network container:brainv3-kafka-1`, so the `localhost:9092` advertised listener
resolves), running BOTH streaming queries via `spark.streams.awaitAnyTermination()`.

| Lane (in `combined_bronze_sinks.py`) | Job module | Lands into |
| --- | --- | --- |
| collector/pixel | `bronze_materialize.py` | `brain_bronze.collector_events` (gated, dedup MERGE on `(brand_id,event_id)`) |
| 9 connector raw lanes | `bronze_raw_landing.py` | `brain_bronze.{lane}_raw` (append-only, idempotent on topic/partition/offset) |

It starts automatically as part of `pnpm dev:up` (step 5, backgrounded). To run or
restart just the Bronze landing:

```sh
pnpm dev:bronze-sink            # = bash tools/dev/dev-bronze-streaming.sh
tail -f /tmp/bronze-sink.log    # when started by dev:up
```

> **Memory:** the launcher's heap defaults (driver 1g + executor 1g + offHeap 256m
> ≈ ~2 GB; live-verified peak ~2.1 GiB on a backlog drain) are a STARTING POINT —
> raise `SPARK_DRIVER_MEMORY` / `SPARK_EXECUTOR_MEMORY` if it OOMs or lags under a
> large cold-start backlog. Override the broker container via `KAFKA_CONTAINER` and
> the topics via `COLLECTOR_TOPIC` (defaults to the local-prod `prod.`-prefixed topic).

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
