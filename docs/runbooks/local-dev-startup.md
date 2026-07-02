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
infra; Bronze landing is not a compose container — it runs as ONE host-launched
Spark process started in step 5.)

| # | Step | What | Why ordered here |
| --- | --- | --- | --- |
| 1 | preflight | ensure `.env.local-prod` exists (copy from `.env.local-prod.example` if missing) | apps + migrate read it |
| 2 | db | `docker compose ... up -d --wait postgres` (Postgres only) | migrations must run **before** the Bronze sink reads PG |
| 3 | migrate | `( set -a; . .env.local-prod; set +a; APP_ENV=local-prod pnpm migrate )` | sourced in a **subshell** so `NODE_ENV=production` does not leak into `next dev` |
| 4 | infra | bring up the rest (core + ai) and **poll health** (`compose_up_healthy`) | does NOT use `up --wait` — one-shot init containers exit 0 mid-wait and would abort it |
| 5 | bronze | start the host unified Bronze sink (`tools/dev/dev-bronze-streaming.sh` → `bronze_landing.py`), backgrounded → `/tmp/bronze-sink.log` | replaces the two removed `spark-bronze-sink` containers |
| 6 | bootstrap | `pnpm bootstrap` → seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets) | apps need the keyring/DEK to start |
| 7 | refresh | `ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh` → one-shot Silver→Gold→Trino serving views | dashboards render honest-empty, not 500, on a cold DB |
| 8 | apps | `turbo run dev` for `@brain/core`, `@brain/web`, `@brain/collector`, `@brain/stream-worker` | the app tier |

> **Why db→migrate→bronze (not bronze→migrate):** historical + defensive. The
> LEGACY split sinks' collector lane JDBC-read PG (`pixel.pixel_installation`) for
> the R2 install_token→brand lookup, so an un-migrated DB crashed the sink. The
> unified `bronze_landing.py` is PURE RAW and never touches PG (the R2/R3 gate
> moved to Silver), but migrating first is kept — it costs nothing and stays
> correct under a `BRONZE_SOURCE=legacy` rollback.

---

## Compose profiles (run a subset)

| Script | Profiles | Brings up |
| --- | --- | --- |
| `pnpm dev:up` | core + ai | full stack, ordered + host Bronze sink (recommended) |
| `pnpm dev` | core + ai | full stack + host Bronze sink, single `up --wait` (no migrate-ordering safety) |
| `pnpm dev:core` | core | infra (Postgres, Kafka, MinIO, Iceberg-REST, Trino, …) + web/core deps |
| `pnpm dev:ingest` | core | infra + collector + stream-worker apps |
| `pnpm dev:bronze-sink` | — | the host unified Bronze sink only (`dev-bronze-streaming.sh`) |
| `pnpm dev:full` | core + full-obs + debug + ai | all infra incl. tracing/exporters, no apps |

> Profiles: **core** (default infra: kafka, postgres, neo4j, redis, minio,
> iceberg-rest, trino, localstack, apicurio, pgbouncer), **full-obs** (tempo, loki,
> otel-collector), **debug** (kafka-exporter), **ai** (litellm — currently
> commented out in compose, as are prometheus + grafana; re-enable by uncommenting).

---

## Bronze streaming (the unified host Bronze landing)

Spark Structured Streaming is the **sole** Bronze landing compute (Kafka Connect
is retired). The landing is ONE host process
(`tools/dev/dev-bronze-streaming.sh` → `db/iceberg/spark/bronze_landing.py`):
a single `docker run apache/spark` SparkSession sharing the Kafka container's netns
(`--network container:brainv3-kafka-1`, so the `localhost:9092` advertised listener
resolves), subscribing to ALL Bronze topics (collector + backfill + the nine
connector `*.raw.v1` lanes) and landing everything **pure-raw** into ONE Iceberg
table, `brain_bronze.events` (the R2/R3 pixel admission gate moved to Silver).
Idempotency is a per-lane `dedup_key` MERGE: `evt:{brand_id}:{event_id}` for
collector rows, `raw:{topic}:{partition}:{offset}` for raw lanes. The legacy split
sinks (`bronze_materialize.py` → `collector_events`, `bronze_raw_landing.py` →
`{lane}_raw`, fused as `combined_bronze_sinks.py`) remain in-tree only as the
`BRONZE_SOURCE=legacy` rollback until Phase 8 decommission.

It starts automatically as part of `pnpm dev:up` (step 5, backgrounded). To run or
restart just the Bronze landing:

```sh
pnpm dev:bronze-sink            # = bash tools/dev/dev-bronze-streaming.sh
tail -f /tmp/bronze-sink.log    # when started by dev:up
```

> **Memory:** the launcher runs the sink with `--driver-memory 4g` + offHeap 512m
> inside a `--memory 7g` container cap (under `local[*]` the driver JVM is the only
> heap that matters; `--executor-memory` is a no-op). Sized for cold-start backlog
> drain per `docs/ops/local-memory-budget.md` — tune via `SPARK_DRIVER_MEMORY` /
> `SPARK_OFFHEAP_SIZE` / `SPARK_CONTAINER_MEMORY` if a very large backlog lags or
> OOMs. The launcher is a supervisor loop: on ANY exit it auto-restarts the sink
> from the DURABLE checkpoint volume `brain-bronze-checkpoint` (wipe that volume,
> sink stopped, whenever the subscribed topic set / query plan changes). Override
> the broker container via `KAFKA_CONTAINER` and the topics via `COLLECTOR_TOPIC`
> (defaults to the local-prod `prod.`-prefixed topics).

---

## Medallion refresh loop

`pnpm dev:v4-refresh` → `tools/dev/v4-refresh-loop.sh` runs Spark Silver→Gold and
SYNC-refreshes the Trino serving views. `ONESHOT=1` runs it once (used by step 7);
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
  `pnpm bootstrap` (step 6 does this for you).

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
