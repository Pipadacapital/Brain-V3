# Local runbook — run the whole stack manually

This is the manual equivalent of `pnpm dev:up` (which runs `tools/dev/dev-up.sh`). Use it when you want to
bring the system up step-by-step, restart one piece, or understand what the one-command path actually does.

Everything runs as `APP_ENV=local-prod`.

## Prerequisites (once)

- Docker running; Node via nvm; `pnpm` installed; `pnpm install` done.
- `cloudflared` for the pixel tunnel — `brew install cloudflared`.
- `.env.local-prod` present. If missing: `cp .env.local-prod.example .env.local-prod` (review the placeholder OAuth ids/secrets).

## Core bring-up — in this order (order matters)

```bash
cd "$(git rev-parse --show-toplevel)"

# 1. Postgres FIRST — so migrations exist before anything reads PG
docker compose --profile core --profile ai up -d --wait postgres

# 2. Migrate the DB — source env for DATABASE_URL in a SUBSHELL (so NODE_ENV=production
#    does not leak into `next dev`, which crash-loops under NODE_ENV=production)
( set -a; . ./.env.local-prod; set +a; APP_ENV=local-prod pnpm migrate )

# 3. Bring up the rest of the infra (kafka, apicurio, minio, iceberg-rest, trino, neo4j, redis, litellm…)
docker compose --profile core --profile ai up -d
#    wait until healthy:
docker compose --profile core --profile ai ps

# 4. Bronze streaming sink — host Spark process; lands collector + connector events into Iceberg Bronze
nohup bash tools/dev/dev-bronze-streaming.sh > /tmp/bronze-sink.log 2>&1 &

# 5. Bootstrap LocalStack Secrets Manager + KMS (per-brand keyring/secrets)
pnpm bootstrap

# 6. One-shot medallion refresh — builds Silver → Gold + the Trino serving views so dashboards render
ONESHOT=1 APP_ENV=local-prod pnpm dev:v4-refresh

# 7. The apps (core + web + collector + stream-worker) — stays in the foreground
APP_ENV=local-prod turbo run dev \
  --filter=@brain/core --filter=@brain/web --filter=@brain/collector --filter=@brain/stream-worker
```

**Why db → migrate → bronze (not bronze first):** the Bronze sink's collector lane reads PG
(`pixel.pixel_installation`) over JDBC for the `install_token → brand` lookup. On an un-migrated DB that
relation doesn't exist and the sink crash-loops. Migrating before the sink makes cold start deterministic.

## Ongoing / background services

```bash
# Continuous medallion refresh loop — keeps Silver→Gold→serving fresh (leave running in a terminal)
APP_ENV=local-prod pnpm dev:v4-refresh          # no ONESHOT = loops

# Pixel tunnel — pick ONE:
pnpm dev:pixel-tunnel                            # quick tunnel; URL ROTATES on restart → reinstall each time
PIXEL_HOSTNAME=events.yourdomain.com pnpm dev:pixel-named-tunnel   # STABLE URL; needs `cloudflared tunnel login` first
#   after (re)starting a tunnel: restart core (loads new PIXEL_INGEST_BASE_URL), then Brain → Settings → Pixel → Reinstall
```

## Shortcuts (package.json wrappers)

| Command | What it does |
|---|---|
| `pnpm dev:up` | all steps above, one command (`tools/dev/dev-up.sh`) |
| `pnpm dev` | infra (`core`+`ai`) + Bronze sink + all 4 apps |
| `pnpm dev:core` | infra + **core + web** only |
| `pnpm dev:ingest` | infra + **collector + stream-worker** only |
| `pnpm dev:full` | infra with `core` + `full-obs` + `debug` + `ai` profiles |
| `pnpm dev:v4-refresh` | medallion refresh loop (`ONESHOT=1` for a single pass) |
| `pnpm dev:bronze-sink` | just the host Bronze sink |
| `pnpm bootstrap` | LocalStack Secrets Manager + KMS seed |
| `pnpm migrate` / `migrate:down` | apply / roll back DB migrations |
| `pnpm down` | `docker compose down` (stop infra, keep data) |

## Verify it's up

```bash
docker compose --profile core --profile ai ps     # all services healthy?
curl -s localhost:3001/health                       # core
curl -s localhost:8787/healthz                      # collector (pixel ingest)
pgrep -f combined_bronze_sinks.py                   # Bronze sink alive (host process)
pgrep -f v4-refresh                                 # refresh loop alive (host process)
```

Key URLs / ports:

| Service | Port |
|---|---|
| web | 3000 |
| core / BFF | 3001 |
| collector (pixel ingest) | 8787 |
| Trino (serving) | 8080 |
| Postgres | 5432 |
| MinIO (S3) | 9000 / 9001 |
| Kafka | 9092 |
| Neo4j | 7474 (http) / 7687 (bolt) |
| Redis | 6379 |
| Grafana | 3004 |

Dev data-store UIs (kafka-ui / pgAdmin / CloudBeaver / redis-commander): `~/.brain-devui/dev-ui.sh`.

## Restart a single app (without killing the others)

The four apps run under one `turbo run dev`. To restart just one (e.g. after an env change), kill its
subtree — `pnpm run dev` → `tsx watch` → `node` — and relaunch that one filter; the siblings keep running:

```bash
# find the tree:  pgrep -fl "apps/core.*src/main.ts"   (then its parents via `ps -o ppid= -p <pid>`)
kill <pnpm-run-dev-pid> <tsx-watch-pid> <node-pid>
nohup pnpm --filter @brain/core dev > /tmp/brain-core-restart.log 2>&1 &
```

`--env-file` is read at tsx startup, so an env change (e.g. `PIXEL_INGEST_BASE_URL`) needs a real restart of
the `tsx watch` process — a watch-triggered reload alone won't re-read the env file.

## Teardown

```bash
pnpm down                            # stop infra (keeps volumes/data)
docker compose down -v               # full reset — nukes volumes
pkill -f combined_bronze_sinks.py    # stop the host Bronze sink
pkill -f v4-refresh-loop             # stop the refresh loop
pkill -f cloudflared                 # stop the pixel tunnel
```

## Gotchas

- **After `docker compose down -v`:** LocalStack secrets are ephemeral → connectors 500 ("can't find secret")
  until you re-run `pnpm bootstrap` and reconnect each connector once. Also re-run `pnpm migrate`.
- **Quick pixel tunnel dropped:** its `*.trycloudflare.com` URL changes on every restart → restart core +
  reinstall the pixel. Use the **named tunnel** for a stable hostname (no reinstall churn).
- **Host processes ≠ containers:** the Bronze sink and the refresh loop run on the host, not in Docker —
  `docker compose ps` won't show them. Check with `pgrep -f combined_bronze_sinks.py` / `pgrep -f v4-refresh`.
- **`brain_app` login after a fresh DB:** if core/stream-worker report `password auth failed for brain_app`,
  re-run the role grant (`ALTER ROLE brain_app LOGIN`).

## See also

- `tools/dev/dev-up.sh` — the authoritative one-command bring-up this runbook mirrors.
- `docs/ops/local-memory-budget.md` — Spark memory budget for the local medallion refresh.
- `docs/ops/spark-tuning.md`, `docs/ops/batch-scheduling.md`.
