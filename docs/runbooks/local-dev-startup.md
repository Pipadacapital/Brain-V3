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
`--profile core --profile ingest --profile lakehouse`.

| # | Step | What | Why ordered here |
| --- | --- | --- | --- |
| 1 | preflight | ensure `.env.local-prod` exists (copy from `.env.local-prod.example` if missing) | apps + migrate read it |
| 2 | db | `docker compose ... up -d --wait postgres` (Postgres only) | migrations must run **before** any Spark sink reads PG |
| 3 | migrate | `( set -a; . .env.local-prod; set +a; APP_ENV=local-prod pnpm migrate )` | sourced in a **subshell** so `NODE_ENV=production` does not leak into `next dev` |
| 4 | infra | bring up the rest (core + ingest + lakehouse) and **poll health** (`compose_up_healthy`) | does NOT use `up --wait` — one-shot init containers exit 0 mid-wait and would abort it |
| 5 | bootstrap | `pnpm bootstrap` → seed LocalStack Secrets Manager + KMS (per-brand keyring/secrets) | apps need the keyring/DEK to start |
| 6 | refresh | `ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh` → one-shot Silver→Gold→Trino serving views | dashboards render honest-empty, not 500, on a cold DB |
| 7 | apps | `turbo run dev` for `@brain/core`, `@brain/web`, `@brain/collector`, `@brain/stream-worker` | the app tier |

> **Why db→migrate→infra (not infra→migrate):** the Spark Bronze materializer
> (`spark-bronze-sink`) JDBC-reads PG tables (e.g. `pixel.pixel_installation`) at
> startup. On a cold, un-migrated DB those relations don't exist, the sink
> crash-loops, and a single whole-stack `up --wait` never converges. Migrating
> first makes the cold start deterministic.

---

## Compose profiles (run a subset)

| Script | Profiles | Brings up |
| --- | --- | --- |
| `pnpm dev:up` | core + ingest + lakehouse | full stack, ordered (recommended) |
| `pnpm dev` | core + ingest + lakehouse | full stack, single `up --wait` (no migrate-ordering safety) |
| `pnpm dev:core` | core | Postgres, MinIO, Trino, web/core deps |
| `pnpm dev:ingest` | ingest | Kafka (`redpanda` service name, KRaft), collector, stream-worker |
| `pnpm dev:lakehouse` | lakehouse | Spark Bronze sinks + Gold/Silver job runners |
| `pnpm dev:full` | core + ingest + lakehouse | infra only, no apps |

> Trino and MinIO are promoted to **always-on default** services (no profile)
> so the serving substrate resolves without an explicit profile.

---

## Bronze streaming (the combined Bronze landing)

Spark Structured Streaming is the **sole** Bronze landing compute (Kafka Connect
is retired). Under the `lakehouse` profile two compose services run the combined
Bronze landing, both sharing the broker's network namespace
(`network_mode: "service:redpanda"`) so the `localhost:9092` advertised listener
resolves:

| Compose service | Job | Lands into |
| --- | --- | --- |
| `spark-bronze-sink` | `bronze_materialize.py` | collector/pixel lane → `brain_bronze.*` (gated, dedup MERGE) |
| `spark-bronze-raw-sink` | `bronze_raw_landing.py` | the 9 connector raw lanes → `brain_bronze.{lane}_raw` (append-only, idempotent on topic/partition/offset) |

These start automatically as part of `pnpm dev:up` (step 4) and
`pnpm dev:lakehouse`. To restart just the Bronze landing:

```sh
docker compose --profile lakehouse up -d spark-bronze-sink spark-bronze-raw-sink
docker compose logs -f spark-bronze-sink spark-bronze-raw-sink
```

> ⚠️ **Naming note / to-be-created:** the deliverable brief refers to a host
> combined-bronze script `tools/dev/dev-bronze-streaming.sh`. **That script does
> not exist in the repo today.** The combined Bronze landing is currently the two
> compose services above, not a host script. If a single host-side wrapper is
> wanted, create `tools/dev/dev-bronze-streaming.sh` that runs the two
> `docker compose ... up -d` lines above (and optionally tails their logs). This
> runbook documents the real mechanism; treat the named script as a future
> convenience wrapper.

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
docker compose --profile core --profile ingest --profile lakehouse ps -a
# expect: running+healthy, or exited 0 for one-shot init containers
```

App URLs: web `http://localhost:3000`, core API `http://localhost:3001`,
collector `http://localhost:8787`, Trino `http://localhost:8080`,
MinIO console `http://localhost:9001`.

> Optional dev data-store UIs (kafka-ui / pgAdmin / CloudBeaver / redis-commander)
> are launched separately via `~/.brain-devui/dev-ui.sh` (not part of `dev:up`).
