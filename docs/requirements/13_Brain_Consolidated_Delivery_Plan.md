# Brain — Consolidated Delivery Plan (reconciled 2026-06-20)

> **What this is.** A single, reconciled implementation plan that merges (a) what has actually shipped,
> (b) the original Engineering-OS plan (docs 04/05/10/11), (c) the engineering-audit remediation backlog
> (docs/audit 98/99), and (d) the Engineering-OS process backlog (QUEUED-WORK, pending-stakeholder, the
> 2026-06 OOB reconciliation). It supersedes the milestone *status* in docs 10/11 — those remain the
> source of truth for scope/architecture; THIS doc is the source of truth for **what to build next and in
> what order to reach a high-quality production GA.**

---

## 0. The headline finding (why this plan looks different from doc 10)

**The product is built; the platform is not yet shippable.** The feature milestones from the original
plan are essentially complete and merged to master:

| Original milestone (doc 10 §6) | State |
|---|---|
| **M0** Sprint 0 (repo/CI/IaC/contracts/RLS) | ✅ shipped |
| **M1** Spine — collector/pixel, Shopify, Bronze, identity, realized-revenue ledger, metric engine + parity, Analytics API, web shell | ✅ shipped |
| **M2** Measurement — ad connectors, Razorpay settlement, billing meter + inspectable bill + GST invoice (+ CGST/SGST + credit notes), Customer 360, identity review | ✅ shipped |
| **M3** Attribution + surfaces — journey touchpoints, attribution credit ledger + clawback, dashboards, Morning Brief | ✅ shipped (write-pipeline live) |
| **M4** Decision Engine — deterministic detectors, confidence, Decision Log, learning loop | ✅ shipped (RTO + realization detectors; registry) |
| **M5** Hardening → GA | ⏳ **this is the gap** |

47 migrations, ~29 EOS requirements, observability (OTel/pino/Sentry), Argo scheduling, and a
comprehensive Playwright suite are all merged. **But** the engineering audit (docs/audit) is a unanimous
**NO-GO for production**, and the #1 cross-audit finding was that **runtime tenant isolation was inert**
(R-01/R-02/R-14) — "a green test under RLS bypass is not a pass." So the work that remains is almost
entirely **production-readiness, correctness-hardening, and the isolation cutover** — not new features.

**Therefore this plan is organized as a path to GA**, Tier-1-first, with the original product roadmap
(Phase 2–5) appended as the post-GA expansion.

---

## 1. Quality bar (applies to EVERY phase below — non-negotiable)

The audit's exit criteria are the standing Definition-of-Done for anything touching the data/isolation path:
- **Non-inert proof:** every isolation/parity assertion must FAIL if the protection is removed; isolation
  tests run under the real `brain_app` role (assert `is_superuser=false` first), never a superuser bypass.
- **Reconcile-before-moat:** parity green (M1) before attribution (M3) before decisions (M4) — already true,
  keep it true as these surfaces change.
- **CI gates on real engines:** smoke (Playwright) + isolation negative-control + parity oracle +
  StarRocks cross-tenant negative-control must run on real Postgres/StarRocks, always-on (not `--affected`).
- **Money = bigint-minor**, **no PII in logs**, **idempotent writes**, **traceable** (correlation IDs end-to-end).
- Every change ships its stakeholder-visible surface (no backend-only slices) and commits its EOS run trail.

---

## PHASE A — Tenancy & runtime isolation (P0, IN FLIGHT — finish first)

> The #1 production blocker. Audit Tracks A (R-01/02/14/16). A2/A3/A4 are merged; A1 runtime cutover is
> partway on `feat/tenancy-a1-brain-app-runtime`. **Until the app process runs as `brain_app`, RLS is not
> truly enforced for the rawPgPool control-plane paths.**

| # | Item | Status | Notes |
|---|---|---|---|
| A2 | Transaction-wrap GUC + query in `@brain/db` (`beginRlsTxn`/`executeInRlsTxn`) | ✅ merged | — |
| A3 | Keystone non-inert proof under real `brain_app` (own rows / cross-brand 0 / no-GUC 0 / write blocked) | ✅ merged | `tools/isolation-fuzz/brain-app-runtime.test.ts` |
| A4 | StarRocks analytics password prod fail-closed | ✅ merged | `requireEnvInProd` |
| **A1.1** | Provisioning under FORCE RLS via `provision_workspace_and_brand()` SECURITY DEFINER fn (0047) | ✅ done (branch) | removed dead rawPgPool dep |
| **A1.2** | suspend/reactivate enforce RLS via `beginRlsTxn` (workspace + target-user GUC) | ✅ done (branch) | harness-verified |
| **A1.3** | `rotateRefreshToken` — SECURITY DEFINER `find_session_by_refresh_token()` (token-before-user auth primitive) | 🔜 next | gates the DSN flip |
| **A1.4** | invite.service control-plane txns → `beginRlsTxn` (org/brand GUC) | 🔜 | |
| **A1.5** | connector connect/disconnect writes (`connector_instance`) → brand GUC | 🔜 | Razorpay/Shopflo/GoKwik in main.ts |
| **A1.6** | vault/secrets (`contact_pii`, `dev_secret`) — confirm RLS posture, wrap if needed | 🔜 | dev_secret is non-RLS |
| **A1.7** | **The DSN flip** — core/worker runtime → `BRAIN_APP_DATABASE_URL`; migrations keep superuser `DATABASE_URL` (split a `MIGRATION_DATABASE_URL`); update `.env`/compose/Terraform | 🔜 last | atomic, after A1.3–A1.6 |
| **A1.8** | Full live re-verification under `brain_app`: register→login→onboard→invite→accept→suspend→connector→brand-read; all live suites green | 🔜 | the gate |

**Pattern (already proven):** SECURITY DEFINER for auth/provisioning primitives (no tenant context yet) +
`beginRlsTxn` for tenant-scoped control-plane (context known). No app-WHERE-only isolation; no patches.
Plan detail: `.engineering-os/runs/…feat-tenancy-runtime-brain-app…/A1-PLAN.md`.

---

## PHASE B — Production-blocking remediation (Tier-1 audit; the GA gate)

> The rest of the audit's Tier-1. Everything here is **P0/CRITICAL** and structurally gates GA. Mostly OPEN.

### B-Deploy (Track B — substrate) — R-03/04/32/06/15
- **B1** Dockerfiles for all 4 deployables — ✅ done.
- **B2** One manifest toolchain (Helm) — consolidate; delete the dead alternative. *(in-progress)*
- **B3** ECR-push IAM role in Terraform; **immutable** ECR tags (drop `:latest`). *(open)*
- **B4** Fix OIDC trust for PR subjects on the plan gate; stand up prod compute (network/EKS/RDS). *(open)*
- **B5** Fix gitops-staging digest bump (no `:latest`). *(open)*
- **B6** Test-gate prod promotion + real auto-rollback (Argo Rollouts analysis OR alarm→SNS→action).
  Container/dependency scans already fail-closed (PR #82). *(partial)*

### B-Reliability (Track C — observability / back-pressure / durability) — R-05/07/08/09/15/50
- **C1** Finish wiring OTel + pino + Sentry; replace any remaining stub spans. *(deps merged; verify wiring)*
- **C2** SLO/burn-rate + freshness + DLQ-depth + consumer-lag **alert rules with notification targets**. *(open)*
- **C3** **Reorder dedup AFTER the durable Bronze write** (claim the dedup slot post-commit). *(open — correctness)*
- **C4** Collector **`503 SPOOL_FULL` + `Retry-After`**; bound the spool (back-pressure, the 99.95% guarantee). *(open)*
- **C5** Playwright smoke + StarRocks cross-tenant negative-control **in CI on real engines**. *(open)*

### B-Correctness (Track D — attribution) — R-10/11/46/47
- **D1** Wire the credit writer into the live `LedgerWriter`/consumer path + backfill historical. *(open — note: a
  write-pipeline shipped this cycle; confirm it is the live consumer path, not a parallel one, and close the dual-writer debt)*
- **D2** **Cumulative-clawback clamp** (Σ clawback ≤ saved credit) + non-negativity in `apportionMinor`. *(open — money correctness)*
- **D3** Replace the tautological CI parity leg + add a window-boundary fixture; unit-test the reconciliation rate. *(open)*

### B-Compliance (Track E — Canon) — R-12/13/19/20/51/53
- **E1** Reconcile `COMPLIANCE.md` line-by-line: mark erasure/DSAR/export/WORM/region **DEFERRED with logged
  waivers**; correct the DPA + audit-PK claims. **This is the ship gate — a Stakeholder/CTO business decision.** *(open)*
- **E2** Build the `pii_ciphertext` KMS vault + erasure orchestrator + per-brand audit serialization —
  **required only before the first lawfully-erasure-demanding subject onboards** (much of the vault already
  exists via `@brain/pii-vault`; close the orchestrator + serialization gap). *(open, conditional)*
- **Audit hash-chain (R-19 / L-02 waiver):** replace djb2 with real **sha256** in `packages/audit` + deploy the
  hourly S3 Object-Lock checkpoint job. **Must close before the first production audit write.** *(open — HIGH)*

**Phase-B exit = the GA gate** (doc 11 §11): isolation 0-leaks under `brain_app` + parity green + bill
reproducible + attribution reconciles within tolerance + SLO alerts live + auto-rollback proven + COMPLIANCE
reconciled. Sign-off: CTO.

---

## PHASE C — Pilot / Beta hardening (selective Tier-2 P1 + reconciliation debt)

> Needed for a real design-partner / small-beta load (≤ ~100 brands), not for the first internal demo.
> Pull these forward from Tier-2 because they bite at pilot scale or are latent correctness/cost issues.

**Reconciliation debt (from the 2026-06 OOB review — do these early; they're small and real):**
- **#68 CAPI currency-exponent** — replace hardcoded `/100` with a per-currency exponent table. ✅ *(done this cycle — `fix/capi-currency-exponent`)*
- **#74 NLQ `@effort`** — machine-readable cost annotation on the model call. ✅ *(done this cycle)*
- **#65 StarRocks password prod injection** — confirm Terraform/Helm inject it; fail-loud. ✅ *(guard done; verify infra wiring)*
- **#75 prod Shopify secrets path** — verify `AwsSecretsManager` path end-to-end on the deployed bundle; replace the fragile cross-package `require()` with a shared export. *(open — HIGH)*
- **#67/#63 web↔core contract drift** — extend the shared-contract gate to the remaining analytics DTOs (`JourneyTouchpointRow.event_type`, `currency_code` nullability). *(partial — gate exists; widen coverage)*
- **#69 brand-resolution non-DB test** ✅ *(done this cycle)*; **MA-13 last-used-brand memory** *(deferred/LOW)*.
- **#72/#73 dev-only:** fix stale `docker-compose.yml` header + re-pin Nessie image so `dev:lakehouse` works; add a CI guard that the dev-salt constant is unreachable when `NODE_ENV=production`. *(LOW)*
- **Process:** reconstruct the lost run artifacts for PRs #68/#71/#73/#74 + adopt a **squash-merge guard** that fails when a feature branch's `runs/` artifacts are absent. *(process — dominant OOB finding)*

**Tier-2 items to pull into Phase C (pilot-scale):**
- **T2-7 (R-17)** Enforce `Idempotency-Key` on connector-connect + consent writes.
- **T2-8 (R-24)** Durable (Redis/PG) retry counters across the 9 consumers → DLQ survives restart.
- **T2-9 (R-23)** Connector HTTP request timeouts (AbortController).
- **T2-10 (R-25)** Liveness/readiness probes; stream-worker health port; real core `/readyz`. *(→ P0 once deployed)*
- **T2-5 (R-30)** Brand-scoped rate limiting + `X-RateLimit-*` + echo `X-Correlation-Id` + throttle `/api/v1/ask`.
- **T2-4 (R-29)** Per-tenant LLM budget (gateway virtual-key) + cheaper default resolver tier + checked-in gateway config.
- **T2-19/T2-33 (R-33/R-38)** Rate-limiter + StarRocks fail-open emit metric/alert; `runScoped` throws if `BRAND_PREDICATE` absent (no silent no-op).
- **T2-25 (R-45)** RBAC: revoke sessions on role downgrade.
- **Residual connector/backfill debt:** SEC-BF-M2 (dual LedgerWriter), SEC-BF-L1 (dual repo), DEV-TOKEN-REACH; SEC-LV-M1 (re-pull lock-window double API calls), SEC-LV-L1 (NaN-date guard).
- **Silver prod row-policy graduation** — apply `db/starrocks/row_policy_template.sql` on managed StarRocks (M1 enforcement is currently the app-seam predicate).

**Also complete the parked/stalled commits:** `feat-silver-tier-order-state` + `feat-shopify-live-connector`
Stage-7 commits (if not already merged); and the **PARKED Shopify validate-sync spike** — now unblockable
(store connected this cycle); run `GET /api/v1/dev/shopify/validate-sync` and fold findings into M1 ingestion docs.

---

## PHASE D — Scale hardening (Tier-2 remainder; before ~1k brands)

> Not pilot-gating. These are the documented ceilings the architecture must cross before high scale.

- **T2-1 (R-18/55)** Ingest **work-queue with claim/lease/shard** + shared pool/producer — the ~100-brand
  scheduler ceiling fix (the single biggest scale bottleneck per doc 04 §347).
- **T2-3 (R-34)** **Connection pooler** (PgBouncer/RDS Proxy) + tuned pools + `statement_timeout`.
- **T2-2 (R-22)** Bronze monthly range-partition + retention (interim before the Iceberg migration).
- **T2-12 (R-27)** JSON→Avro on the wire + schema-id framing + decode-failure alert.
- **T2-13/T2-21 (R-28/26)** dbt-Silver build + StarRocks↔Bronze reconciliation + **replay-rebuildability** in CI.
- **T2-23 (R-56)** Per-consumer-group topic split or filtered subscription (~6× CPU reduction).
- **T2-6 (R-21)** Shared error-envelope helper (replace ~395 ad-hoc sites) + wire-format CI gate.
- **T2-11 (R-19)** Audit hash-chain serialization (advisory lock or `(brand_id,seq)` PK + UNIQUE).
- **T2-15 (R-31/57)** Mutation testing (stryker) + coverage thresholds; **T2-16 (R-48)** always-run isolation + parity gates.
- **T2-20 (R-37)** Identity-graph fan-in on stitch read (cross-device) + merged-id read-back test.
- **T2-17/T2-22 (R-36/35)** `UNIQUE(provider,account_id)`; resolve the duplicate `0033` migration + CI uniqueness lint.
- God-file/Single-Primitive cleanups (R-39/41/42), circuit breakers (R-54), `uncaughtException` handlers (R-49),
  single-partition backfill lane (R-58).

---

## PHASE E — Product roadmap (the original Phase 2–5; post-GA expansion)

> From doc 04 §18. **Hard rule: nothing in a later phase becomes a dependency of an earlier one (explicitly
> including MMM).** Build only after the GA foundation reconciles.

- **Phase 2 — Honest profit & attribution intelligence:** full CM waterfall + complete cost setup; acquisition
  module (MER/aMER/CAC/payback/LTV:CAC); executive lenses; RTO/COD/pincode intelligence; RFM; **probabilistic
  identity** (never alone); autocapture install fallback; creative analytics; attribution extras (model-switch
  UI, per-channel windows, harvested-demand haircuts, cross-device); **holdout/exposure evidence CAPTURE only**;
  full Decision Log experience. Optionally extract the Identity service (behind its versioned contract).
- **Phase 3 — Predictions, lifecycle & data-driven attribution:** MTA + **MMM + incrementality/holdout ANALYSIS**
  of the Phase-2 evidence → unlocks the reserved `Calibrated` confidence + lift-based contribution (a pure writer
  swap); first prediction layer (forecast, churn, predicted LTV, stockout, cash timing); Shared Audience Builder;
  WhatsApp lifecycle (single consent chokepoint goes live); AI ticket management. **Infra step-up:** migrate
  Silver/Gold to **Iceberg-SoR** + Athena/Trino + Spark + Lake Formation + the **Python ML service (Feast)**;
  StarRocks flips to the external Iceberg catalog.
- **Phase 4 — Agentic execution:** owner-configured auto-execute (low-risk classes), conjunctive guardrails,
  **60-second kill switch + auto-revert** (canary/progressive-delivery infra lands here, not before). Recommend-only
  stays the default forever.
- **Phase 5 — Scale, enterprise & retail:** portfolio/multi-brand rollups; enterprise data controls + residency;
  custom-integration framework; privacy-thresholded cross-brand benchmarking; **GCC coverage + Arabic/RTL** (the
  RegionAdapter seam is built early); retail/POS extensions; multi-region.

**Explicitly deferred / never-in-Phase-1 (don't pull forward):** probabilistic identity, Markov/Shapley/MMM/
view-through, ML decision engine & predictions, assisted/auto-execute, generic CDP reverse-ETL, session replay,
audience product, native mobile apps (responsive web + PWA push instead).

---

## PHASE F — Tier-3 backlog (P3; opportunistic)

`migrate:down` reversibility OR forward-only runbook (R-59); DR/restore-drill runbook (R-60); position_based
remainder + windowing-consistency + `ratePct` sign (R-61/62/66); `dev_secret` prod-omit/REVOKE guard (R-44/63);
shared idempotency util promotion (R-64); `crypto.timingSafeEqual` in JWT verify (R-65); SBOM/provenance +
admission signature verification (R-67); region-tag Checkov/OPA gate + `region_code` in the can_contact hash
(pre-GCC); Bronze TTL/retention job + backfill-lane graduation + static EKS system node group.

---

## 2. Sequencing & gates (the critical path to GA)

```
PHASE A (tenancy A1 cutover, in-flight)
   └─> PHASE B (Tier-1: deploy substrate ∥ reliability ∥ correctness ∥ compliance Canon)   ── GA GATE
          └─> PHASE C (pilot/beta hardening + reconciliation debt)                          ── BETA GATE
                 └─> PHASE D (scale hardening, < 1k brands)
                        └─> PHASE E (product Phase 2 → 3 → 4 → 5)
PHASE F runs opportunistically alongside C/D.
```

- **A is strictly first** — it's the #1 audit blocker and everything else assumes real isolation.
- **B's four tracks (deploy ∥ reliability ∥ correctness ∥ compliance) parallelize** across owners; all four
  must close for the **GA gate** (CTO sign-off).
- **Compliance E1 is a business decision**, not engineering — surface it to the Stakeholder now so it isn't the
  thing that blocks launch at the end.
- **Reconcile-before-moat stays enforced:** any change to ledger/metric/attribution re-runs parity + isolation.

## 3. Go/No-Go gates (carried from doc 11 §11)

| Gate | Evidence | Sign-off |
|---|---|---|
| **Phase-A exit** | App runs as `brain_app` (is_superuser=false); all flows green; isolation non-inert | CTO + Prin Arch |
| **GA (Phase-B exit)** | Tier-1 closed: isolation/parity/bill/attribution + SLO alerts + auto-rollback + COMPLIANCE reconciled | CTO (final) |
| **Beta (Phase-C exit)** | ~10–100 brands; SLOs (99.9% product / 99.95% collector); DR drill; security review | CTO + VP Eng |
| **Scale (Phase-D)** | Work-queue + pooler + partitioning proven at load; replay-rebuild green | CTO + Platform |

## 4. Open process / stakeholder actions (surface now, don't let them block at the end)
- **E1 COMPLIANCE.md reconciliation + waivers** (the ship gate) — Stakeholder/CTO decision.
- **9–9 IST advertising send-window** compliance sign-off (decision was made inside an uncommitted run).
- **Shopify `.env` secret rotation** (`shpss_***`) — user action.
- **Squash-merge run-artifact guard** + reconstruct the lost run records.
- **"Wired-to-nothing" rule** — at occurrence #3, `/adopt-rule` the end-to-end wiring test.

---
*Sources reconciled: docs/requirements/{04,05,10,11}, docs/audit/{96,97,98,99}, docs/eos-reconciliation-2026-06.md,
.engineering-os/{QUEUED-WORK, pending-stakeholder-attention, pending-stakeholder-commit, lessons-learned}, git
history (master @ bd3484e), and the in-flight A1-PLAN. Feature milestones M1–M4 verified merged; the remaining
work is production-readiness (M5 + audit Tier-1) and the documented post-GA roadmap.*
