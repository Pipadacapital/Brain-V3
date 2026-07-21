# Runbook — Promote GOLD_INCREMENTAL to default-on in prod (ADR-0016 P1.1)

Flipping `GOLD_INCREMENTAL="1"` makes the Gold transform tier read its Silver/Gold upstreams through
watermark-windowed slices (`incremental_window(enabled=GOLD_INCREMENTAL)`) instead of full-scanning every
tick. That is the lever that takes the `*/5` medallion run from 55–90 min (full-scan Gold each tick) down to
single-digit minutes. But an incremental Gold mart that silently drops or invents a row — or gets a money
column wrong — is a **truth regression**, so the flip is gated: an incremental build MUST be provably equal
to its full recompute, money byte-exact, before it goes default-on in prod.

This runbook is the promotion criteria + the exact steps. **prod stays `"0"` until every gate below is
green.** The 22 incremental-safe Gold marts are enumerated in `db/iceberg/duckdb/parity_check.py`
(`GOLD_INCREMENTAL_MARTS`); the three full-recompute money marts (`gold_revenue_ledger`, `gold_cac`,
`gold_contribution_margin`) never window regardless of the flag (delete_orphans / multi-source money-safety),
so this flip never touches their orphan-shed path.

## The two-stage gate (both MUST pass before the prod flip)

### Stage A — comparator + window arithmetic (runs on EVERY promotion PR, automatic)

`integration.yml` step **"Gold-incremental parity gate machinery"** runs, on the DuckDB transform venv:

- `db/iceberg/duckdb/test_incremental_window.py` — the `incremental_window()` window arithmetic contract
  (default-off full scan, first-run bootstrap, trailing lookback, FULL_REFRESH escape, slice cap).
- `db/iceberg/duckdb/test_parity_gold_incremental.py` — the SHIPPED `parity_check.parity(..., strict=True)`
  comparator over an in-memory DuckDB (identical→PASS, dropped row→FAIL, invented row→strict FAIL, money
  diff→FAIL, manifest shape + the three money marts stay exempt).

Both are pure/in-memory (no engines, no Bronze) and carry a `__main__` assert-runner, so they gate with
plain `python` — no pytest in the transform venv. This proves the gate **machinery** on every release→master
promotion. It does NOT, by itself, prove the live medallion — that is Stage B.

### Stage B — live incremental↔full parity harness (one-off, run before the flip)

`parity_check.py --gold-manifest` is only the comparator; it presumes a harness has already produced, on the
SAME frozen snapshot, both a `<mart>_full` (FULL_REFRESH=1) and a `<mart>_incr` (GOLD_INCREMENTAL=1, windowed)
build of every mart. **`tools/ops/gold-parity-check.job.yaml` IS that harness.** On the live prod catalog it
builds each mart `_incr` (bootstrap → windowed) then `_full` (recompute, LAST), then runs the STRICT manifest
comparator. Exit 0 = money byte-exact, zero orphan drift, all 22 marts — the merge precondition for the flip.

Run it against a **FROZEN** prod catalog (Silver/Bronze must not move mid-harness):

```bash
CTX=brain-prod-ssm

# 0. FREEZE the writers. If the resident transform-worker is enabled, scale it to 0 INSTEAD of
#    suspending the cron (it is the CORE writer then). Let any in-flight run finish before step 1.
kubectl --context "$CTX" -n argo patch cronworkflow v4-medallion --type merge -p '{"spec":{"suspend":true}}'
kubectl --context "$CTX" -n argo patch cronworkflow v4-identity  --type merge -p '{"spec":{"suspend":true}}'

# 1. Run the live harness (builds _incr ×2 + _full, then the STRICT manifest comparator).
kubectl --context "$CTX" apply -f tools/ops/gold-parity-check.job.yaml
kubectl --context "$CTX" -n argo logs -f job/gold-parity-check

# 2. GATE: the Job exits 0 IFF every incremental-safe Gold mart is byte-exact. On a non-zero exit,
#    read the per-mart "PARITY: REVIEW ❌" lines to see which mart drifted — do NOT flip prod.

# 3. UN-FREEZE (whether the gate passed or failed).
kubectl --context "$CTX" -n argo patch cronworkflow v4-medallion --type merge -p '{"spec":{"suspend":false}}'
kubectl --context "$CTX" -n argo patch cronworkflow v4-identity  --type merge -p '{"spec":{"suspend":false}}'
```

The `_incr` / `_full` suffixed tables the harness writes are throwaway parity scratch — drop them after
review (they are not read by serving; data is disposable).

## Staging soak (already on — the pre-prod exercise)

`infra/helm/transform-worker/values-staging.yaml` sets `transform.goldIncremental: "1"`. In staging the
resident transform-worker is the active CORE writer (`enabled: true`; the v4-medallion cron is suppressed),
so this exercises the real Gold windowed-read path under live churn. Watch staging for a soak window
(freshness + no mart drift vs a `--gold-manifest` run there) before promoting prod. FULL_REFRESH=1 recovers a
diverged staging Gold build.

## The prod flip (only after Stage A green + Stage B exit 0 + staging soak clean)

The prod CORE writer today is the **v4-medallion cron** (the resident worker is REVERTED/pruned in prod per
the 2026-07-20 "simple cron" decision). Flip it in `infra/helm/cronworkflows/values-prod.yaml`:

1. Uncomment the `env:` block under the `GOLD_INCREMENTAL default-on gate` comment. **Footgun:** Argo CD /
   Helm REPLACES the base env list, so the block MUST re-declare `ICEBERG_CATALOG`, `SILVER_INCREMENTAL`,
   `WATERMARK_LOOKBACK_SECONDS`, AND `WATERMARK_MAX_SLICE_SECONDS=3600` (base `values.yaml` sets all of
   these) — the template already lists them; do not trim.
2. If/when the resident transform-worker is re-enabled in prod, flip
   `infra/helm/transform-worker/values-prod.yaml` `transform.goldIncremental: "1"` IN LOCKSTEP (whichever is
   the active CORE writer must carry the flag; they never both write).
3. PR release→master (the promotion PR re-runs Stage A). After the owner merges, ArgoCD rolls the change.

Verify post-flip: medallion run time drops (single-digit minutes vs 55–90 min); freshness stays green; spot
a `--gold-manifest` run stays byte-exact. **Rollback** = re-comment the prod env block (revert to base `"0"`)
and, once, run the affected marts with `FULL_REFRESH=1` to re-fold from a clean full scan.

## Promotion checklist

- [ ] Stage A (integration.yml "Gold-incremental parity gate machinery") is GREEN on the promotion PR.
- [ ] Stage B (`tools/ops/gold-parity-check.job.yaml`) exited 0 against a frozen prod catalog — all 22 marts.
- [ ] Staging soak clean (freshness + `--gold-manifest` byte-exact in staging).
- [ ] prod `env:` block uncommented WITH `WATERMARK_MAX_SLICE_SECONDS=3600` re-declared (list-replace footgun).
- [ ] Active CORE writer carries the flag (cron today; resident too if re-enabled — lockstep).
- [ ] Post-flip: run time down, freshness green, rollback (`FULL_REFRESH=1`) understood.
