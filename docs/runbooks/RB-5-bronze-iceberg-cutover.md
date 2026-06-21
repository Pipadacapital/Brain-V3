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

The dbt Bronze sources flip via the `bronze_source` dbt var (`pg`|`iceberg`) — set it in the dbt
job invocation for the analytics build, in lockstep with the read flag.

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

With parity green, set `BRONZE_OPERATIONAL_READ_SOURCE=iceberg` in core (+ stream-worker) env and
set the analytics dbt build to `--vars '{bronze_source: iceberg}'`. Deploy. Operational reads now
serve from Iceberg via StarRocks; the analytics marts build from the Iceberg sources.

Verify (dev-proven in Slices 4b/5 — same checks apply per env):
- data-health / orders-list / order-detail / recent-events render with the SAME counts as before
  the flip (compare to a pre-flip snapshot);
- per-brand isolation holds at the metric-engine Silver read seam (I-ST01) — spot-check two brands;
- DQ freshness/confidence unchanged.

**Bake** for a full business cycle. PG `bronze_events` is still being written — so this is fully
reversible: **rollback** = set `BRONZE_OPERATIONAL_READ_SOURCE=pg` (+ drop the dbt var) and redeploy.

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

## Related

- ADR-0002 — `docs/adr/0002-iceberg-bronze-spark-streaming.md`
- RB-4 — `docs/runbooks/RB-4-local-lakehouse.md` (local verification of every slice)
- RB-3 — StarRocks rebuild-from-Iceberg
