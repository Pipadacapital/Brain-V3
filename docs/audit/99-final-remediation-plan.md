# 99 — FINAL REMEDIATION PLAN (prioritized path to GO)

**Goal:** clear the unanimous NO-GO via one bounded Tier-1 phase (no re-architecture), then a Tier-2 scale/hardening phase before ~1k brands, then Tier-3 backlog. Each item carries its risk ref (see `98-final-risk-register.md`), rough effort, and dependency order.

Effort: **S** ≤1 day · **M** 2–4 days · **L** 1–2 weeks · **XL** 3+ weeks. Rough, single-senior-engineer units.

---

## TIER 1 — PRODUCTION-BLOCKING (P0). Must all close + be PROVEN before re-gate.

**Exit criteria for the whole tier:** every fix proven under the production `brain_app` role with a negative control; smoke + isolation + parity + StarRocks-negative-control all execute in CI on a real engine; the Compliance Canon reconciled line-by-line to code. A green test under bypass is NOT a pass.

### Track A — Tenancy runtime (the coupled change; do first, ships as ONE PR)
| Item | Risk | Effort | Depends on |
|---|---|---|---|
| A1. Provision `brain_app` (LOGIN NOSUPERUSER NOBYPASSRLS) in Terraform + dev compose + every non-superuser DSN | R-01 | M | — |
| A2. Wrap GUC-set + query in `BEGIN/COMMIT` inside `@brain/db createPool` (backport `withBrandTxn`) | R-02 | S | — |
| A3. Test `createPool().connect()` under real `brain_app` with a negative control (unset GUC → 0 rows; cross-brand → blocked) | R-14 | M | A1, A2 |
| A4. StarRocks analytics password `isProduction` fail-closed guard (mirror KMS pattern) | R-16 | S | — |
> A1+A2 **must land together** — A1 alone causes a full login outage (every read fail-closes to 0 rows). Gate the merge on A3 passing under `brain_app`.

### Track B — Deploy substrate (parallel to A)
| Item | Risk | Effort | Depends on |
|---|---|---|---|
| B1. Write Dockerfiles for collector/core/stream-worker/web | R-03 | M | — |
| B2. One manifest toolchain (pick Helm OR Kustomize) for all services; remove the dead other | R-04 | L | B1 |
| B3. Create the ECR-push IAM role in Terraform | R-32 | S | — |
| B4. Fix OIDC trust to cover PR subjects for the plan gate; stand up prod compute (uncomment net/eks/rds) | R-32 | M | B3 |
| B5. Fix gitops-staging digest bump (per-app outputs + login-ecr step); drop `:latest` to IMMUTABLE ECR | R-32 | S | B2 |
| B6. Test-gate prod promotion (run lint/typecheck/isolation/parity before promote); wire real auto-rollback (Rollout/Argo analysis or alarm→SNS→action) | R-06, R-15 | L | B2, C1 |

### Track C — Observability + back-pressure + durability
| Item | Risk | Effort | Depends on |
|---|---|---|---|
| C1. Wire OTel/prom-client + a structured logger (pino) + Sentry; replace stub | R-05, R-50 | L | B1 |
| C2. Author SLO/burn-rate/freshness/DLQ/consumer-lag alert rules with notification targets | R-07 | M | C1 |
| C3. Reorder dedup AFTER durable Bronze write (claim slot only post-commit) | R-08 | M | — |
| C4. Implement collector `503 SPOOL_FULL`+`Retry-After`; bound the spool | R-09 | M | — |
| C5. Run Playwright smoke + StarRocks cross-tenant negative control in CI on a real engine | R-15 | M | B1 |

### Track D — Attribution correctness (the live-path wiring)
| Item | Risk | Effort | Depends on |
|---|---|---|---|
| D1. Wire the credit writer into the live `LedgerWriter`/consumer path + backfill | R-10 | L | — |
| D2. Add cumulative-clawback clamp (`Σ clawback ≤ saved credit`) in `computeAttributionClawback` + non-negativity in `apportionMinor` | R-11 | M | — |
| D3. Replace the tautological CI parity leg + add a window-boundary fixture; unit-test the reconciliation rate | R-46, R-47 | M | — |

### Track E — Compliance Canon (cheapest high-integrity path)
| Item | Risk | Effort | Depends on |
|---|---|---|---|
| E1. Reconcile `COMPLIANCE.md` line-by-line: mark erasure, DSAR/export, WORM-anchor/chain-walk, region-routing as DEFERRED with tracked Stakeholder waivers; correct the DPA capability statement to "suppression + ad-platform deletion request"; correct the audit-PK claim | R-12, R-13, R-19, R-20, R-51, R-53 | M | — |
| E2. (If any erasure-eligible subject onboards in M1) build the `pii_ciphertext` KMS vault + erasure orchestrator + per-brand audit serialization | R-12, R-19 | XL | A1, E1 |
> E1 is the gate; E2 is required only before the first lawfully-erasure-demanding subject. The CRITICALs (R-12/R-13) are cleared for ship either by building E2 **or** by a Stakeholder-logged waiver against the reconciled E1 Canon — a CTO/Stakeholder decision, not an engineering one.

**Tier-1 total rough effort:** ~7–9 engineer-weeks across 2–3 engineers running A/B/C/D/E in parallel where dependencies allow.

---

## TIER 2 — SCALE / HARDENING (P1/P2). Before ~1k brands; not launch-gating for a <100-brand pilot.

| Item | Risk | Effort | Notes |
|---|---|---|---|
| T2-1. Ingest work-queue with claim/lease/shard + inject shared pool/producer | R-18, R-55 | XL | the ~100-brand ceiling fix; unblocks horizontal scaling |
| T2-2. Bronze monthly range-partition + retention (interim before Iceberg) | R-22 | M | first cost wall |
| T2-3. Connection pooler (PgBouncer/RDS Proxy) + env-tuned pools + `statement_timeout` | R-34 | M | noisy-neighbor |
| T2-4. Per-tenant LLM budget (gateway virtual-key) + cheaper default resolver tier + checked-in gateway config | R-29 | M | cost-routing paradigm fix |
| T2-5. Brand-scoped rate limiting + `X-RateLimit-*` + echo `X-Correlation-Id` + throttle `/api/v1/ask` | R-30 | M | wire-contract |
| T2-6. Shared error-envelope helper (replace 395 sites) + wire-format CI gate | R-21 | L | enforcement mechanism |
| T2-7. Enforce Idempotency-Key on connector-connect + consent writes | R-17 | S | active corruption fix |
| T2-8. Durable (Redis/PG) retry counters across the 9 consumers → DLQ survives restart | R-24 | M | |
| T2-9. Connector HTTP request timeouts (AbortController) | R-23 | S | |
| T2-10. Liveness/readiness probes; stream-worker HTTP health port; real core `/readyz` | R-25 | M | escalates to P0 once deployed |
| T2-11. Audit hash-chain serialization (advisory lock or `(brand_id,seq)` PK + UNIQUE) | R-19 | M | tamper-evidence |
| T2-12. JSON→Avro on the wire + schema-id framing + decode-failure alert | R-27 | L | |
| T2-13. dbt-Silver build + StarRocks↔Bronze reconciliation + replay-stability in CI | R-28 | L | parity already gated |
| T2-14. Webhook security-pipeline HOF extraction (3×→1) | R-40 | M | drift hazard |
| T2-15. Mutation testing (stryker) on critical paths + coverage thresholds | R-31, R-57 | M | |
| T2-16. Always-run (not `--affected`) isolation + parity gates | R-48 | S | security/money invariant |
| T2-17. `UNIQUE(provider,account_id)` on connector account ids (anti-misroute) | R-36 | S | |
| T2-18. `runScoped` throws if `BRAND_PREDICATE` absent (no silent no-op) | R-38 | S | |
| T2-19. Rate-limiter + StarRocks fail-open emit metric/alert | R-33 | S | |
| T2-20. Identity-graph fan-in on stitch read (cross-device) + merged-id read-back test | R-37 | L | |
| T2-21. Order Silver mart re-derive from Bronze (replay rebuildability) | R-26 | L | |
| T2-22. Resolve duplicate `0033` migration + add CI uniqueness lint | R-35 | S | |
| T2-23. Per-consumer-group topic split or filtered subscription (~6× CPU) | R-56 | M | ~1k brands |
| T2-24. `uncaughtException`/`unhandledRejection` handlers | R-49 | S | |
| T2-25. RBAC: revoke sessions on role downgrade | R-45 | S | |

---

## TIER 3 — BACKLOG (P3). Track, fix opportunistically or before GCC expansion.

| Item | Risk | Effort |
|---|---|---|
| T3-1. Implement reversibility OR delete `migrate:down` + document forward-only runbook | R-59 | S |
| T3-2. DR/restore-drill runbook (after R-04/R-06 make RB-2 executable) | R-60 | M |
| T3-3. position_based remainder + windowing-semantics consistency + `ratePct` sign + 5× `ratePct` dedup | R-61, R-62, R-66 | M |
| T3-4. `dev_secret` prod migration guard (omit/REVOKE table in prod) | R-44, R-63 | S |
| T3-5. Promote shared idempotency util (kill cross-context import) | R-64 | S |
| T3-6. `crypto.timingSafeEqual` in JWT verify (or adopt vetted lib at Authentik cutover) | R-65 | S |
| T3-7. SBOM/provenance + admission-side signature verification | R-67 | M |
| T3-8. Region-tag Checkov/OPA gate + `region_code` thread into can_contact hash (pre-GCC) | R-51, R-67 | M |
| T3-9. Bronze TTL/retention job; backfill-lane graduation path; static EKS system node group | R-58, R-67 | M |

---

## Dependency-ordered critical path to re-gate

```
A1+A2 ──► A3 (prove under brain_app)
B1 ──► B2 ──► B6        C1 ──► C2
B3 ──► B4               C3, C4 (independent)
                        C5 (needs B1)
D1, D2, D3 (independent)
E1 (gate) ──► [E2 OR Stakeholder waiver]
```

**Re-gate when:** all Tier-1 items closed AND the tier exit criteria met (brain_app-proven negative controls, CI smoke/isolation/parity/StarRocks-negative-control green on real engines, Canon reconciled). On that exit, the verdict flips to **GO** for a bounded (<100-brand) pilot; Tier-2 closes before scaling past ~1k brands.
