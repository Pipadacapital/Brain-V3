# Brain — monorepo

AI-native commerce OS for DTC brands (India / UAE / GCC). Single TypeScript monorepo;
**modular monolith first** — 3 deployables + the web app, with future service extraction
when a trigger fires. Canonical specs live in the **Brain-docs** repo (01 BRD → 05 Build Plan);
the structure here matches **doc 05 §2–§3**.

## Layout
- `apps/` — `collector` · `stream-worker` · `core` (13 modules) · `web`
- `packages/` — shared libs: contracts (Zod = source of truth), metric-engine, money,
  tenant-context, identity-core, audit, db, events, observability,
  ai-gateway-client, config
- `db/` — migrations · trino/views (serving views) · iceberg (Spark medallion) · starrocks/teardown (retired-DB drops)   ·   `infra/` — terraform · helm · argocd  _(Brain V4: dbt + StarRocks removed — Spark is sole compute, Trino is sole serving)_
- `tools/` — parity-oracle · eval · isolation-fuzz · seed · lint (v4-naming-guard)   ·   `docs/` — adr · runbooks · playbooks · architecture

## The two rules that keep it a *modular* monolith
1. `apps/` may import `packages/`, never another `apps/`; `packages/` never import `apps/`.
2. Inside `core/`, modules talk only through each other's `index.ts` (or an event) —
   reaching into another module's `internal/` fails the ESLint boundary rule.

## Getting started — one command
```bash
pnpm install
cp .env.local-prod.example .env.local-prod   # then fill in OAuth app IDs/secrets (placeholders)
pnpm dev:up                                   # infra (--wait) → migrate → bootstrap → refresh → all 4 apps
```
`pnpm dev:up` is the single from-zero command: it brings the full Docker substrate up *healthy*,
applies migrations, seeds LocalStack Secrets Manager + KMS, runs a one-shot Silver→Gold→Trino-view
refresh, then starts core + web + collector + stream-worker. Re-runnable and idempotent.

```bash
pnpm test:isolation && pnpm test:parity        # the non-negotiable Phase-1a gates
```
Tooling: Turborepo + pnpm + TypeScript (build-tooling choices — doc 05 §16; swappable).

## Cold start from scratch (production-faithful local)

Bring the **whole platform up from zero** — the way a fresh production deploy comes up,
run locally against Docker + LocalStack (`NODE_ENV=production` code paths: AWS Secrets
Manager/KMS, KMS PII-vault DEK). Use this after `docker compose down -v` (disposable dev data).

```bash
# 0. CLEAN SLATE — remove containers + volumes (all infra state, disposable dev data)
docker compose --profile core --profile ingest --profile lakehouse --profile observe down -v

# 1. ONE COMMAND — infra (up --wait → HEALTHY) → migrate → bootstrap (LocalStack SM/KMS)
#    → one-shot Spark Silver→Gold + Trino serving views → start all 4 apps.
pnpm dev:up
```
`pnpm dev:up` runs the production-faithful sequence end to end (`NODE_ENV=production` against Docker +
LocalStack: AWS Secrets Manager/KMS, KMS PII-vault DEK). `brain_app` LOGIN is auto-provisioned on a
fresh volume (`db/init/00_provision_brain_app_role.sql`) — no manual `ALTER ROLE`. The medallion
transform is Spark-on-Iceberg (dbt removed); serving is Trino views over Iceberg (StarRocks removed).

Then open **http://localhost:3000** → register → onboard a brand → connect Shopify → **Sync now**.
Real events flow **Collector → Kafka (KRaft) → Spark sink → Iceberg Bronze → Spark Silver/Gold → Trino
`brain_serving.mv_*`**; re-run `ONESHOT=1 pnpm dev:v4-refresh` to repopulate Gold and the
dashboards/`/insights` light up, or run `pnpm dev:v4-refresh` (no ONESHOT) to keep it fresh on a loop.

**Already up?** Skip the bring-up and just (re)materialize analytics with `ONESHOT=1 pnpm dev:v4-refresh`.

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
