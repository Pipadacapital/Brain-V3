# Brain — monorepo

AI-native commerce OS for DTC brands (India / UAE / GCC). Single TypeScript monorepo;
**modular monolith first** — 3 deployables + the web app, with future service extraction
when a trigger fires. Canonical specs live in the **Brain-docs** repo (01 BRD → 05 Build Plan);
the structure here matches **doc 05 §2–§3**.

## Layout
- `apps/` — `collector` · `stream-worker` · `core` (13 modules) · `web`
- `packages/` — shared libs: contracts (Zod = source of truth), metric-engine, money,
  feature-flags, tenant-context, identity-core, audit, db, events, observability,
  ai-gateway-client, config, ui
- `db/` — migrations · starrocks · iceberg · dbt   ·   `infra/` — terraform · helm · argocd
- `tools/` — parity-oracle · eval · isolation-fuzz · seed   ·   `docs/` — adr · runbooks · playbooks · architecture

## The two rules that keep it a *modular* monolith
1. `apps/` may import `packages/`, never another `apps/`; `packages/` never import `apps/`.
2. Inside `core/`, modules talk only through each other's `index.ts` (or an event) —
   reaching into another module's `internal/` fails the ESLint boundary rule.

## Getting started
```bash
pnpm install
cp .env.example .env.local
pnpm dev          # control-plane + serving profile + core + web
pnpm dev:ingest   # the strict-SLA event path (collector + stream-worker)
pnpm test:isolation && pnpm test:parity   # the non-negotiable Phase-1a gates
```
Tooling: Turborepo + pnpm + TypeScript (build-tooling choices — doc 05 §16; swappable).

## Cold start from scratch (production-faithful local)

Bring the **whole platform up from zero** — the way a fresh production deploy comes up,
run locally against Docker + LocalStack (`NODE_ENV=production` code paths: AWS Secrets
Manager/KMS, KMS PII-vault DEK). Use this after `docker compose down -v` (disposable dev data).

```bash
cd "/Users/rishabhporwal/Desktop/Brain V3"

# 0. CLEAN SLATE — remove containers + volumes (all infra state)
docker compose --profile core --profile ingest --profile lakehouse --profile observe down -v

# 1. INFRA up (Postgres, Redpanda, StarRocks, Iceberg-REST, MinIO, Spark sink, LocalStack, Redis, litellm)
docker compose --profile core --profile ingest --profile lakehouse up -d
docker compose ps            # wait until postgres/starrocks/localstack/iceberg-rest = healthy

# 2. MIGRATE Postgres schema (0001 → latest), as superuser `brain`
pnpm migrate

# 3. PROVISION brain_app LOGIN  ← REQUIRED, and NOT in migrations by design
#    (0001 creates `brain_app` NOLOGIN; the LOGIN+password step is a provisioning concern.
#     Password MUST match BRAIN_APP_DATABASE_URL in .env.local-prod — default brain_app:brain_app.
#     NOTE: db/init/00_provision_brain_app_role.sql auto-provisions this on a fresh volume; this
#     manual step is only needed if the role somehow lacks LOGIN.)
docker exec -i brainv3-postgres-1 psql -U brain -d brain \
  -c "ALTER ROLE brain_app WITH LOGIN PASSWORD 'brain_app';"

# 4. Secrets/KMS into LocalStack (jwt + cookie + shopify/meta/google secrets, KMS CMK, brand keyring)
pnpm bootstrap

# 5. MATERIALIZE the V4 analytics layer (ONE command). Brain V4 removed dbt: the transform is
#    Spark-on-Iceberg. `pnpm dev:v4-refresh` (ONESHOT=1 for one pass) runs every Spark Silver job
#    (Bronze → Iceberg brain_silver), then every Spark Gold job (Silver → Iceberg brain_gold), then
#    SYNC-refreshes the brain_serving mv_* materialized views the dashboards read. Needs the lakehouse
#    profile up (minio + iceberg-rest) — `pnpm dev:full` brings it up.
ONESHOT=1 pnpm dev:v4-refresh

# 6. START all 4 apps (local-prod = NODE_ENV=production vs LocalStack; loads .env.local-prod)
pnpm dev
```

Then open **http://localhost:3000** → register → onboard a brand → connect Shopify → **Sync now**.
Real events flow **Collector → Redpanda → Spark sink → Iceberg Bronze → Spark Silver/Gold → StarRocks
serving mv_***; re-run step 5 (`ONESHOT=1 pnpm dev:v4-refresh`) to repopulate Gold and the
dashboards/`/insights` light up. Or run `pnpm dev:v4-refresh` (no ONESHOT) to keep it fresh on a loop.

**Plain dev mode** (not prod-faithful): skip steps **4 & 6**, run `pnpm dev` instead — all else identical.

### Gotchas (all expected, not bugs)
- **Marts/dashboards are empty until real data flows** — the honest-empty state by design.
  Data appears only after register → connect → sync → `ONESHOT=1 pnpm dev:v4-refresh`.
- **Dashboards stale after a sync?** The V4 serving mv_* only track Iceberg after the Spark Silver/Gold
  jobs run. Re-run `ONESHOT=1 pnpm dev:v4-refresh` (or leave `pnpm dev:v4-refresh` looping) to
  re-materialize Iceberg + SYNC-refresh the brain_serving mv_*.
- **Customer marts (churn/VIP scores) stay empty without identity resolution** — they need `brain_id`
  on the order ledger; revenue + RTO insights work from order data alone. Historical ledger rows:
  `tools/backfill/backfill-ledger-brain-id.sh <brand>` (after migration 0095).
- **CAC + blended-ROAS insights need ad spend** — connect Meta/Google (OAuth) so the spend-repull jobs
  fill `ad_spend_ledger`, or seed sample spend: `tools/seed/ad-spend-demo-seed.sh <brand>`.
- **Attribution PATHS (`gold_attribution_paths`) need the journey→order stitch** — the storefront pixel
  must write `brain_anon_id` into checkout `note_attributes` (Web-Pixel checkout extension) so the order
  webhook reads it back (`connector_journey_stitch_map`). That ONE instrumentation also bridges identity
  (anon↔customer) and fills the funnel checkout stage. Deterministic historical backfill (identity-graph
  based, NEVER guessed — no-op when no bridge exists): `tools/backfill/backfill-journey-stitch-map.sh <brand>`.
- **Step 5 must be `--full-refresh` the first time** after a wipe or an Iceberg/PG source flip.
- **Skip step 3 → `password authentication failed for brain_app`.** Re-run it after every `down -v`.
- `docker system prune` also drops images → step 1 re-pulls them (slower first boot).
