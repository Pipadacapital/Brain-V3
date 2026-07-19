# Design Review 007 — Resident Cutover Hardening (post-incident, permanent fix)

**Status:** APPROVED 2026-07-19 (owner: "go DR-007") — EXECUTED as ONE consolidated PR
**Author:** Data Platform Architect session, 2026-07-19
**Trigger:** owner directive after the resident-worker incident consumed 4 serial hotfix PRs

---

## 1. Problem — the incident, honestly

The CORE↔IDENTITY re-split shipped the resident transform worker (new namespace, new chart, new Deployment) to prod on 2026-07-19. It then CrashLooped/no-op'd for ~6 hours through **four serially-discovered environment gaps**, each fixed by its own PR/apply:

| Act | Gap | Fix | How long it hid the next act |
|---|---|---|---|
| 1 | `core-env` secret absent in the new namespace | #285 (ExternalSecret) | Container couldn't even start → masked 2–4 |
| 2 | Chart image digest hand-pinned to a pre-`resident` build; deploy.yml never bumped this chart | #294 (+ lockstep auto-bump) | `unknown tier 'resident'` → masked 3–4 |
| 3 | No `derive-pg-env` in the Deployment command → leader lock + PG-read jobs dialed localhost | #296 | Lock never acquired → masked 4 |
| 4 | IRSA trust policy admitted only `argo:brain-jobs`, not the new SA; the TF fix was merged but **never applied** (infra lane is plan-only) | targeted `terraform apply` of `module.irsa_spark_jobs` (1 change, 0 add/destroy) | S3 403 on every Bronze read |

Prod stayed *functionally* safe throughout only by accident: the old `v4-medallion` cron survived as an **unpruned orphan** (cronworkflows app has no `prune`) and kept producing core marts on the old image.

**The systemic root cause is one sentence:** a new deployment surface was hand-assembled from pieces of the cron lane's environment contract, with no written contract, no boot-time verification, no staging validation (staging carried the same broken digest, so it CrashLooped identically and proved nothing), and a plan-only infra lane whose pending applies nobody gates on. Each gap could only be discovered by fixing the previous one in production.

## 2. Analysis — the full environment-contract audit (done now, not serially)

Everything `run_all.py resident` needs, diffed chart-vs-cron-lane against live prod:

| Contract item | Cron lane | Resident chart | Status |
|---|---|---|---|
| `core-env` secret in namespace | ✓ (argo) | ✓ after #285 | FIXED |
| Correct duckdb image, auto-bumped | ✓ (sparkV4 bump) | ✓ after #294 | FIXED |
| `SILVER/GOLD/BRONZE_PG_*` derivation | ✓ (inlined script) | ✓ after #296 (byte-copy) | FIXED |
| IRSA: SA can assume `brain-prod-jobs` | ✓ | ✓ after targeted TF apply | FIXED (verified in IAM) |
| Resources / OOM budget (2CPU/6Gi req, 8Gi lim) | ✓ | ✓ (parity, verified) | OK |
| Nodepool (streaming) + scheduling | ✓ | ✓ (pod placed, running) | OK |
| Watermark/incremental env (`WATERMARK_MAX_SLICE_SECONDS` etc.) | ✓ | ✓ (chart env, verified in template) | OK |
| **Serving cache-bust after gold rewrites** | ✓ (final cron step, stream-worker image) | **✗ — resident has none; Redis serves stale until TTL** | **GAP 5 (open)** |
| **NetworkPolicy coverage (AUD-INFRA-021 default-deny)** | ✓ (argo ns covered) | **✗ — `transform-worker` ns absent from the network-policies chart** | **GAP 6 (open)** |
| **derive-pg-env.sh single-source doctrine** | one copy | two byte-copies, **no CI drift-check** (the #296 comment claims one; it does not exist) | **GAP 7 (open)** |
| **Staging validates the resident before prod promote** | n/a | **✗ — staging had the same broken digest; no soak gate exists** | **GAP 8 (process)** |
| Boot-time dependency verification | n/a (short-lived jobs fail loudly per-step) | **✗ — failures surface one-per-tick, serially** | **GAP 9 (the meta-gap)** |

Current live state: resident pod is **mid-tick running the silver tier** (lock acquired, S3 reads working) — acts 1–4 are confirmed closed. The orphan `v4-medallion` still exists and must go once the first clean tick lands (two core writers otherwise contend on the advisory lock; correct but wasteful and confusing).

## 3. The permanent fix — ONE implementation PR + ONE ops sequence + TWO process changes

### PR (single, consolidated — all code/chart/CI together)

**P1 — fail-fast preflight (kills the serial-discovery failure mode forever).** `run_all.py resident` gains a boot-time preflight that checks EVERY contract item at once and prints one complete diagnosis before the loop starts: PG connect (lock DSN), Iceberg REST `GET /v1/config`, S3 read probe on the warehouse, required env presence. All failures reported together, exit non-zero → one CrashLoop log = the whole picture. Acts 1–4 would have been **one log line each in a single boot report** instead of a 6-hour serial hunt.

**P2 — cache-bust parity decision (GAP 5).** Recommendation: accept TTL-only staleness short-term (the per-dataset TTL tiers are the designed safety net) and record it in the chart values as an explicit, commented decision — the alternative (a sidecar/CronJob bust runner on the stream-worker image) adds a moving part for a staleness window the TTLs already bound. Owner may override; both paths are in this PR's description, only the decision ships.

**P3 — NetworkPolicy coverage (GAP 6).** Add `transform-worker` to the network-policies chart: default-deny-ingress + the standard probe/metrics allows, matching every other covered namespace.

**P4 — drift-check CI (GAP 7).** `tools/lint/derive-pg-env-drift.sh` (byte-diff of the two copies, blocking in pr.yml) — makes the "keep in sync" comment enforceable instead of aspirational.

**P5 — orphan hygiene.** Delete the `v4-medallion` CronWorkflow in the same ops sequence (below); add a `prune: true` decision item for the cronworkflows app to the PR description (recommend: enable — the orphan class is exactly what prune exists for; risk is bounded because everything the chart renders is declaratively owned).

### Ops sequence (once, after the PR promotes — no further PRs)
1. Confirm resident's clean tick (in flight now) → delete orphan `v4-medallion`.
2. Execute the deferred DR catalog drops + `journey_events` rename + bake-watch (the original runbook's final step, unchanged).

### Process changes (documented in `docs/runbooks/`, no code)
**PC1 — infra applies are part of promotion (GAP 4's real lesson).** The promotion checklist gains a hard step: `terraform plan` for touched prod modules must be **empty or applied by the operator before merge**. Pre-requisite debt called out: the un-imported Cost-Explorer anomaly monitor must be `terraform import`ed so full applies become safe again (currently only targeted applies are).
**PC2 — staging soak gate (GAP 8).** A new chart/deployment surface requires N clean staging ticks (checked via the staging pod log, manually is fine) before its prod values flip. Staging validating nothing is how a broken digest reached prod twice.

## 4. Risks / Alternatives
- Preflight false-negatives blocking a healthy boot → probes are read-only and each individually skippable via env (documented); the loop's per-tick error handling is unchanged as the fallback.
- Prune enablement deleting something unexpected → gated as an explicit decision item; alternative is documented manual orphan deletion in the promotion checklist (weaker, human-dependent).
- Doing nothing further (resident now works) → leaves GAPs 5–9 latent; the next new deployment surface replays this incident. Rejected.

## 5. Validation
Preflight: unit tests + a staging boot with each dependency deliberately broken (secret unset, bad DSN) asserting the full multi-line diagnosis. Netpol: staging apply + probe/scrape still green. Drift-check: CI red on a 1-byte divergence. End-state: resident sole core writer, orphan gone, DR drops executed, bake-watch green.

## 6. Rollback
Chart/CI changes: git revert. Preflight: env-skippable per probe. Prune (if enabled): revert the app spec; orphan-class objects recreate on next sync.

## 7. Monitoring
Resident: existing liveness + tick-error log alert (now meaningful — a preflight-passing worker that errors mid-tick is a real anomaly). Add the transform-worker namespace to the standard dashboards (it inherits the JMX-less duckdb metrics story — the /healthz thread only; noted as a future observability item, not silently skipped).
