# RB-5 — Bronze → Iceberg production cut-over

The go-live procedure for retiring Postgres `bronze_events` as the Bronze system-of-record and
making Spark → Iceberg the sole writer (ADR-0002). The code is complete and dev-verified (Slices
0–7, RB-4); this runbook is the **ordered, gated, reversible** operational sequence to flip it on
per environment. Run it **staging first**, bake, then prod.

> Brain core rule: *Bronze is source of truth.* This cut-over moves that truth between substrates
> without ever losing it — the two sinks run in parallel and a parity oracle gates every step. At no
> point is there a window with no Bronze write.

## Two flags, two independent switches

| Flag | Where | Default | Effect |
|---|---|---|---|
| `sparkBronze.enabled` | helm `cronworkflows` values | `false` | Runs the Spark → Iceberg sink + parity oracle **in parallel** with the live PG write |
| `BRONZE_OPERATIONAL_READ_SOURCE` | core/stream-worker env | `pg` | `iceberg` → operational reads (data-health, orders, recent-events) serve from Iceberg via StarRocks |
| `BRONZE_PG_WRITE_ENABLED` | stream-worker env | `true` | `false` → `ProcessEventUseCase` stops writing PG `bronze_events` (Spark→Iceberg becomes sole SoR) |

The dbt silver build reads the **same flag**: `stg_touchpoint_events` / `stg_order_line_events` resolve
`bronze_source` as `var('bronze_source', env_var('BRONZE_OPERATIONAL_READ_SOURCE', 'pg'))`. So setting
`BRONZE_OPERATIONAL_READ_SOURCE` in the env drives BOTH the core operational reads AND the analytics
ETL source — one flag for the whole Bronze read plane. (A `--vars '{bronze_source: iceberg}'` on the
dbt invocation still overrides it for ad-hoc parity testing during the soak.)

The switches are **ordered and each reversible**: write-in-parallel → read-flip → write-retire. Never
retire the PG write (Phase 4) before the read flip (Phase 3) has baked, and never flip the read before
the parity soak (Phase 2) is green.

## Phase 0 — Preconditions (one-time per env)

- [ ] Spark image built from `db/iceberg/spark/Dockerfile` (jars baked in) → ECR; digest captured.
- [ ] `terraform/s3-iceberg` applied for the env (warehouse bucket + Glue database). Prod is
      bootstrap-only until this runbook runs.
- [ ] `cronworkflows` values for the env set: `sparkBronze.image.digest` (B3 fail-closed — no
      `:latest`), `sparkBronze.env` (`STARTING_OFFSETS=latest`, `PARITY_TOLERANCE=0`), and the env
      secret carries `KAFKA_BROKERS`, `ICEBERG`/Glue, `CHECKPOINT_LOCATION=s3a://…` (durable), `AWS_*`.
- [ ] `brain-jobs` IRSA role grants S3 (per-brand bronze prefix) + Glue catalog access (NN-5).
- [ ] StarRocks external Iceberg catalog created for the env (`db/starrocks/external_iceberg_catalog.sql`
      — underscore props + `aws.s3.region` + `IcebergAwsClientFactory`, see RB-4 Slice 4).

## Phase 1 — Enable the dual-sink (additive, zero reader impact)

Flip `sparkBronze.enabled: true` and deploy the chart. Now both sinks consume the same
`collector.event.v1` topic: the live `stream-worker → PG bronze_events` write (untouched) **and** the
Spark `→ Iceberg` materializer. The `bronze-parity` CronWorkflow begins reconciling.

Verify:
```bash
# materializer is landing rows
kubectl logs -l brain.io/job=bronze-materialize --tail=50
# parity oracle is green (exit 0 = identity sets match per brand)
kubectl logs -l brain.io/job=bronze-parity --tail=50
```
**Rollback:** `sparkBronze.enabled: false` — the Iceberg sink stops instantly; PG remains SoR. No
reader ever moved, so there is nothing else to undo.

## Phase 2 — Parity soak gate (the cautious wait)

Let the dual-sink run until parity is **green and stable** — the `bronze-parity` CronWorkflow exits
0 on every run across the soak window (recommend ≥ several days spanning peak ingest + a connector
backfill). `PARITY_TOLERANCE=0`: any non-zero exit is real drift — **do not proceed**; investigate
(missed events, gating divergence, checkpoint gaps) before flipping any reader. The oracle is
identity-based (`(brand_id, event_id)` sets), not payload-byte (the two writers serialize JSON
differently by design — see RB-4 Slice 3).

**Do not advance past this gate on a hunch.** A green soak is the entire safety basis for Phases 3–4.

## Phase 3 — Flip the reads to Iceberg (bake)

With parity green, set `BRONZE_OPERATIONAL_READ_SOURCE=iceberg` in the env (this one flag drives both
core reads and the dbt silver source — see above). Redeploy core/stream-worker and re-run the dbt
silver build. Operational reads now serve from Iceberg via StarRocks; the analytics marts build from
the Iceberg sources.

Verify (dev-proven in Slices 4b/5 + the local rehearsal below — same checks apply per env):
- data-health / orders-list / order-detail / recent-events render with the SAME counts as before
  the flip (compare to a pre-flip snapshot);
- per-brand isolation holds at the metric-engine Silver read seam (I-ST01) — spot-check two brands;
- DQ freshness/confidence unchanged.

> **Freshness caveat — StarRocks Iceberg metadata cache.** Reads served from the Iceberg external
> catalog do NOT see a newly-written snapshot until StarRocks refreshes its Iceberg metadata cache.
> A fresh write is therefore visible in the live Spark sink immediately but lags in the dashboards by
> the cache interval. For acceptable freshness either lower the catalog's metadata-cache TTL or run a
> periodic `REFRESH EXTERNAL TABLE <catalog>.<db>.collector_events` (the dbt silver CronWorkflow can
> issue it pre-build). Confirmed during the local rehearsal: a just-produced event was invisible to a
> StarRocks `count(*)` until `REFRESH EXTERNAL TABLE`, then appeared. Budget the read path's freshness
> SLO around this interval.

**Bake** for a full business cycle. PG `bronze_events` is still being written — so this is fully
reversible: **rollback** = set `BRONZE_OPERATIONAL_READ_SOURCE=pg` and redeploy (one flag; the dbt
silver build follows it on the next run).

## Phase 4 — Retire the PG Bronze write (Spark→Iceberg becomes sole SoR)

Only after Phase 3 has baked clean: set `BRONZE_PG_WRITE_ENABLED=false` in stream-worker env and
deploy. `ProcessEventUseCase` now skips the PG dedup+write and commits offsets normally; Spark→Iceberg
is the sole Bronze writer. The R2 (install_token→brand) / R3 (consent) tenant-derivation gates are
enforced IN the Spark writer (Slice 6), so isolation is preserved on the Iceberg-only path.

Verify: new events appear in Iceberg (`collector_events`) and NO new rows land in PG `bronze_events`
(row count flat); reads (already on Iceberg) are unaffected.

**Rollback:** set `BRONZE_PG_WRITE_ENABLED=true` and redeploy — the PG write resumes immediately.
Because the read already serves from Iceberg, keep the dual-sink (`sparkBronze.enabled=true`) running
indefinitely after Phase 4 as the durable real-time writer (post-cutover shape: a long-lived
`TRIGGER_MODE=continuous` Deployment rather than the `availableNow` cron — see RB-4 Slice 3).

> Keep PG `bronze_events` **read-intact** (do not drop the table) for at least one full retention/audit
> window after Phase 4, as a break-glass fallback. Decommissioning the table is a separate, later change.

## Ongoing — maintenance (Slice 7)

Once Iceberg is the SoR, the `bronze-maintenance` CronWorkflow (daily 03:00) runs compaction
(`rewrite_data_files`) + 24-month snapshot-expiry TTL. Right-to-erasure (D13) is the on-demand
`MODE=erase ERASE_BRAND_ID=<uuid>` invocation after a brand's DEK is crypto-shredded. See RB-4 Slice 7.

## Order-line note

The order-line read (`stg_order_line_events`) flips with the same `bronze_source` var. Its Iceberg
path assigns `line_index` as a deterministic content-ordered `row_number` (StarRocks has no
`WITH ORDINALITY`) rather than the PG array position — a benign, documented difference (the line
CONTENT is byte-identical). See RB-4 Slice 4b (order-line).

## Per-environment config (how the flag is set)

The cut-over flags live in per-env files, auto-selected by `APP_ENV` and layered over the shared base:
`tsx --env-file=../../.env --env-file-if-exists=../../.env.${APP_ENV:-dev}` (core, stream-worker,
collector). Local/dev → `.env.dev` (APP_ENV unset → `dev`); prod → `.env.prod` (deploy sets
`APP_ENV=prod` + `NODE_ENV=production`). So "going live" is literally setting `BRONZE_OPERATIONAL_READ_SOURCE`
(then `BRONZE_PG_WRITE_ENABLED`) in the environment's override file (or the injected secret) and redeploying —
the same flip rehearsed locally below. See `.env.prod.example`, and the **prod-on-local** section for running
the full production code paths (AWS Secrets Manager + KMS via LocalStack) locally.

## Local cut-over rehearsal (executed against Docker)

The full sequence was run end-to-end against the local stack (Postgres + StarRocks + Redpanda + MinIO +
iceberg-rest) as a production simulation — every gate verified:

- **Phase 1 (dual-sink):** `TRIGGER_MODE=continuous` Spark materializer started as the live Iceberg
  writer alongside the PG write. A freshly-produced `order.live.v1` auto-appeared in BOTH PG bronze
  (via the live-order-bronze-bridge) and Iceberg (via Spark) — dual-sink confirmed.
- **Phase 2 (parity):** identity reconciliation — real tenant brand `124e6af5` exact (940 = 940);
  the only delta was the `b9f10030` D13-erasure *test* brand (Iceberg-only). Gate green.
- **Phase 3 (read flip):** `BRONZE_OPERATIONAL_READ_SOURCE=iceberg` in `.env.dev`; silver rebuilt from
  Iceberg (env-driven, no `--vars`); core restarted healthy on the Iceberg read path.
- **Phase 4 (write retire):** `BRONZE_PG_WRITE_ENABLED=false`; stream-worker restarted. A post-retire
  `order.live.v1` landed in Iceberg (1) but NOT in PG bronze (0); PG bronze total held flat (940) —
  Spark→Iceberg is the sole Bronze writer. The same event, sourced env-driven, flowed through dbt into
  `silver_order_line` from Iceberg only (the differential proof).

Operational note for restarts: `tsx watch` parents ignore SIGTERM under turbo — `kill -9` the
`--env-file-if-exists` watch processes to fully stop the tier before relaunching `pnpm dev`.

## Running production-faithful locally (prod-on-local)

Beyond the dev-mode rollout above, the FULL production code paths run locally against Docker —
exercising the real prod branches, not just the Bronze flags. What `NODE_ENV=production` flips:
`AwsSecretsProvider` (JWT/cookie from Secrets Manager), `AwsSecretsManager` + KMS (connector
secrets), `KmsVaultKeyProvider` (per-brand PII-vault DEK unwrapped via KMS from `brand_keyring`),
`RedisOAuthStateStore`, secure cookies, dev routes OFF, and the collector topic → `prod.collector.event.v1`.

LocalStack (compose `core` profile) stands in for AWS Secrets Manager + KMS. One-time seed:

```bash
pnpm bootstrap:prodlocal     # tools/seed/prod-local-aws-bootstrap.sh — idempotent:
                             #  • KMS CMK + alias/brain-connector-secrets
                             #  • SM secrets brain/{jwt-signing,cookie,shopify-client}-secret (from dev .env)
                             #  • brand_keyring: dev DEK KMS-wrapped (prod unwraps the SAME 32-byte DEK)
pnpm dev:prodlocal           # APP_ENV=prod turbo run dev … → loads .env.prod (NODE_ENV=production)
```

`.env.prod` (gitignored; template `.env.prod.example`) points the AWS SDK at LocalStack via
`AWS_ENDPOINT_URL=http://localhost:4566` and carries the secret *references* (names, not values),
the KMS key id, `COLLECTOR_TOPIC=prod.collector.event.v1`, and the go-live Bronze flags.

**Naming (important):** `NODE_ENV=production` (the `@brain/config` enum) flips the code paths;
`APP_ENV=prod` (short) is the topic prefix — both required, and `APP_ENV` MUST be `prod` so the
core live lane + stream-worker + collector all agree on `prod.collector.event.v1`. `turbo.json`
`globalPassThroughEnv` must include `APP_ENV` (and the AWS/Bronze/StarRocks vars) or turbo strips
them and the `.env.${APP_ENV}` selection silently falls back to `dev`.

VERIFIED (prod-on-local rehearsal): all three services boot in `NODE_ENV=production` with secrets
resolved from LocalStack (no fail-closed abort), dev routes absent, PII vault wired to the KMS DEK
provider (DEK KMS-decrypt round-trips to 32 bytes), and a `prod.collector.event.v1` event flows to
Iceberg (sole SoR) with PG bronze NOT written — the same go-live end-state, on the real prod code paths.

## Related

- ADR-0002 — `docs/adr/0002-iceberg-bronze-spark-streaming.md`
- RB-4 — `docs/runbooks/RB-4-local-lakehouse.md` (local verification of every slice)
- RB-3 — StarRocks rebuild-from-Iceberg
