# Master Risk Register

All risks ranked. Raw board findings (198) are de-duplicated into **canonical risks** where multiple boards observed the same root cause. Each canonical risk lists every board that corroborated it.

**Legend** — Likelihood: Certain / High / Med / Low (Certain = the defect is unconditional in the committed code). Blast radius: Platform (all tenants) / Multi-tenant (cross-brand) / Single-tenant / Operational.

---

## P0 — Production blockers (canonical Critical)

| ID | Title | Sev | Category | Likelihood | Impact | Blast radius | Owner domain | Evidence |
|---|---|---|---|---|---|---|---|---|
| RISK-001 | No deploy substrate: zero Dockerfiles; every ArgoCD app → non-existent Helm/Kustomize manifests; prod Terraform (net/EKS/RDS/S3) commented out | Critical | Deploy / GitOps | Certain | Nothing builds or runs in any cluster | Platform | DevOps | `main.yml:74`, `argocd/envs/*/*.yaml`, `infra/helm/` (only authentik), `envs/prod/bootstrap.tf:62-99` — boards 13/14/15 |
| RISK-002 | App connects as table-owning superuser (dev `brain:brain`, prod RDS `brainadmin` only) → FORCE RLS bypassed unconditionally | Critical | Tenant isolation | Certain | Every brand-scoped RLS policy is a no-op for the running app; isolation = app WHERE only | Multi-tenant | Database | `docker-compose.yml:20`, `.env.example:2`, `main.ts:350-371`, `rds/main.tf:127`, `0001_init.sql:38` — boards 04/08/15 |
| RISK-003 | `@brain/db` RLS GUC uses `SET LOCAL` outside a txn → GUC never in scope for the query; primary isolation control inoperative & unproven under `brain_app` | Critical | RLS correctness | Certain | Under `brain_app` all BFF reads return 0 rows (outage); masked today only by RISK-002 | Multi-tenant | Database / Security | `packages/db/src/index.ts:194-211`; contrast `metric-engine/src/deps.ts:39-60` — boards 04/08 |
| RISK-004 | Observability is a stub: metrics→`console.info`, spans no-op, no OTel/Prom/Sentry dep, collector traces→`debug`, Prom scrapes dead ports, no dashboards, **zero alert rules** | Critical | Observability | Certain | System blind in prod; SLO/freshness/DLQ/lag/parity breaches silently undetectable | Platform | Observability | `packages/observability/src/index.ts:11-16,91-93,161-169`, `infra/observe/*`, `observability/main.tf` — boards 11/13/14 |
| RISK-005 | Documented Iceberg lakehouse does not exist (Bronze is Postgres); events are JSON not Avro (Apicurio decorative); typed-topic catalogue collapsed | Critical | Data architecture | Certain | "Open immutable replay-SoR lakehouse" + schema governance unbuilt; Phase-3 hard migration | Platform | Data Platform | `0016_bronze_events.sql:1-20`, `kafka-producer.ts:85`, `topics.yml`, docs 03/07 — board 05 |
| RISK-006 | Attribution credit write-side is dead code — `writeCredit`/reversal hook have zero prod callers → `attribution_credit_ledger` empty | Critical | Wiring / correctness | Certain | Every attribution surface returns all-unattributed; Decision Engine fed zeros | Platform | Attribution | `credit-writer.ts:101`, `OrderEventConsumer.ts:79`, `LedgerWriter.ts:4` — board 07 |
| RISK-007 | `brain_id_alias` is write-only — no reader re-points merged ids; no UNMERGE path exists | Critical | Identity correctness / GDPR | Certain | Merges never apply → silent double-count of every merged customer; bad merge irreversible | Platform / Multi-tenant | Identity | `IdentityRepository.ts:142-147,240`, `0017:58-59,128`, grep zero unmerge — board 06 |
| RISK-008 | Redis dedup slot claimed BEFORE durable Bronze write → transient DB failure permanently drops in-flight events | Critical | Data loss / idempotency | High | Any RDS blip silently destroys events for the 7-day dedup window, all brands | Platform | Reliability | `ProcessEventUseCase.ts:159-200`, `RedisDedupAdapter.ts:49-54`, `BronzeRepository.ts:138` — board 09 |
| RISK-009 | No 503 SPOOL_FULL back-pressure; bare 500 on spool failure; spool unbounded, no brand_id, no RLS, never purged | Critical | Back-pressure / privacy | High | Sale-day Redpanda stall → pixel SDKs drop on 500; spool fills shared RDS → all write paths fail | Platform | Reliability / Privacy | `collect.route.ts:20-37`, `accept-event.usecase.ts:28`, `0015_collector_spool.sql:21-28`, `drainer.ts` — boards 09/14/15 |
| RISK-010 | `COMPLIANCE.md` overclaims as ENFORCED: erasure crypto-shred, `pii_ciphertext` KMS vault, audit WORM + chain-walk, DSAR/export, region-routing — none exist; PII plaintext-at-rest | Critical | Compliance / privacy | Certain | DPDP/GDPR erasure & access unfulfillable; ratified Canon asserts unbuilt statutory rights | Platform | Compliance | `COMPLIANCE.md:110,22,116,115,131`, 37 migrations (no `pii_erasure_log`/`pii_ciphertext`), doc 13 — board 16 |
| RISK-011 | Continuous ingest scheduler is single-instance, fully sequential, re-pulls every connector every tick; no claim/lease/shard | Critical | Scalability | Certain | Tick crosses 45s SLA in low hundreds of connectors; unsafe to scale horizontally (no leader election) | Platform | Scalability | `ingest-scheduler/run.ts:56-93`, `main.ts:294-301` — boards 10/15 |
| RISK-012 | Per-connector `run()` builds a new Pool + Kafka producer per dispatch → connection exhaustion at scale | Critical | Resource exhaustion | High | Fixed connect/TLS overhead dwarfs work; any concurrency fix multiplies pools into Postgres `max_connections` | Platform | Scalability | `shopify-repull/run.ts:82-83,117-120` — board 10 |
| RISK-013 | CI/CD ships untested: deploy pipeline (`main.yml`) runs zero tests; Playwright e2e + smoke gate run in no workflow; isolation tests self-skip green when datastores absent | Critical | CI gate / verification validity | Certain | Money/RLS/parity gates give zero protection on the release path; a cross-brand regression can ship green | Platform | Testing / DevOps | `.github/workflows/main.yml`, `pr.yml:16-32`, `pg.test.ts:266+`, `starrocks.test.ts:216` — boards 12/13 |
| RISK-014 | Clawback has no over-reversal guard → cumulative/duplicate reversals drive attributed revenue negative | Critical | Money correctness | Med | Double-reversed orders corrupt reconciliation rate feeding Decision Engine | Single→Multi | Attribution | `attribution-clawback.ts:132-186`, `clawback.ts:102` — board 07 |
| RISK-015 | Auto-rollback is theater: composite alarm has no actions, no metrics behind SLO banner, no Rollout/hook | Critical | Rollback safety | Certain | Documented auto-rollback on SLO/isolation breach fires nothing; every deploy unguarded | Platform | DevOps | `main.yml:197-207`, `observability/main.tf:138-149`, `collector.yaml:55` — boards 13/14 |
| RISK-016 | No liveness/readiness probes anywhere; stream-worker (ledger/identity/consent writes) exposes no HTTP port | Critical | Probes / recovery | Certain | k8s cannot restart a wedged worker or gate traffic; ledger/identity writes stall silently | Platform | Reliability / Prod-readiness | grep probes = 0; `stream-worker/src/main.ts` no listen; `core/main.ts:327` static | boards 11/14 |
| RISK-017 | No executable down-migrations; `migrate:down` non-functional; rollback is comment-only | Critical | Migration safety | Certain | A defective forward migration has no tested rollback; hand-DDL under incident | Platform | Database | `package.json:24-27`, `Makefile:145`, `0027:23-31` comments — board 04 |

---

## P1 — Must-fix before scale / high-severity (canonical High)

| ID | Title | Sev | Category | Likelihood | Blast radius | Owner | Evidence |
|---|---|---|---|---|---|---|---|
| RISK-020 | Documented `/api/v1/*` domain + MCP contract surface largely unbuilt (only cookie-bound BFF exists); `/metrics/query` keystone absent | High | API contract | Certain | Operational | API | `03-api-audit.md` H-1; grep path literals |
| RISK-021 | Error envelope diverges from contract — `request_id` not `{error:{code,message,trace_id,details}}`; no `trace_id` anywhere | High | API / observability | Certain | Operational | API | `bff.routes.ts:128-131`, `main.ts:316-322` |
| RISK-022 | Idempotency-Key unenforced on most mutations; connector-connect & consent-write duplicate rows on retry | High | Idempotency | High | Single-tenant | API / Reliability | `consent.routes.ts:97`, `main.ts:956,1026-1253` |
| RISK-023 | No correlation-id echo; no tenant-scoped rate limiting / rate-limit headers on read+NLQ surface (`/ask` LLM-backed) | High | Rate limiting / cost | High | Multi-tenant | API / Cost | `main.ts:238-241`, grep `X-RateLimit`=0, `bff.routes.ts:1217` |
| RISK-024 | StarRocks Silver/Gold has no engine-level row policy (enterprise-gated); isolation = one app seam, no DB backstop | High | Analytics isolation | Certain | Multi-tenant | Database / Data | `row_policy_template.sql:46-53`, `silver-deps.ts:115-129` |
| RISK-025 | StarRocks analytics password silently defaults to hardcoded `brain_analytics_dev` in prod (no fail-closed guard) | High | Misconfiguration | High | Multi-tenant | Security | `main.ts:191`, `bootstrap.sql:12` |
| RISK-026 | StarRocks ↔ Bronze parity oracle + dbt Silver tier not in CI; "same number everywhere" not gated | High | Data quality / CI | Certain | Platform | Data | `.github/workflows`, `Makefile:42-57` |
| RISK-027 | Silver order mart built from OLTP ledger, not Bronze; no Bronze→ledger replay path | High | Lineage / replay | Certain | Platform | Data | `stg_order_ledger_events.sql:36`, `main.ts:188-234` |
| RISK-028 | Topic catalogue collapsed to one JSON topic; partition key `brand_id:event_id` → no per-order ordering | High | Topic / ordering | Certain | Platform | Data | `topics.yml:8-70`, `packages/events/src/index.ts:140-142` |
| RISK-029 | ≥3-way merge silently drops middle brain_ids; merge doesn't transfer identifiers → orphaned links + merge churn | High | Identity graph | High | Multi-tenant | Identity | `IdentityResolver.ts:228-231,254` |
| RISK-030 | Phone-guard count never decrements on merge → wrongly suppresses legitimate repeat customers; threshold off-by-one (two impls) | High | Identity correctness | Med | Single-tenant | Identity | `IdentityRepository.ts:128-136`, `SharedUtilityPolicy.ts:48` |
| RISK-031 | Cross-device journeys silently dropped — stitch map is one-anon-per-order | High | Attribution accuracy | High | Single-tenant | Attribution | `0031_..._stitch_map.sql:43`, `credit-writer.ts:102` |
| RISK-032 | Reconciliation metric untested; CI-blocking parity oracle only runs live; Leg-2 SQL recompute not window-independent | High | Test coverage | Certain | Platform | Attribution / Testing | `parity-oracle.test.ts`, `attribution-credit-writer.live.test.ts:228` |
| RISK-033 | bronze_events + ledgers accumulate unbounded in OLTP Postgres; no partitioning/retention | High | Cost / storage | Certain | Platform | Scalability | `0016`, `0018`; no PARTITION BY in 37 migrations |
| RISK-034 | Every RLS query incurs extra round-trip (GUC SET before each); fixed tiny pools (max 3/5/10), no pooler/`max_connections` plan | High | DB scalability | Certain | Platform | Scalability | `packages/db/src/index.ts:194-211`, `main.ts:351-371` |
| RISK-035 | 8 Kafka consumer groups in one process each re-read the entire live topic & filter in-app (~6× consumption) | High | Event scalability | Certain | Platform | Scalability | `stream-worker/main.ts:54-216` |
| RISK-036 | No statement_timeout; single shared 10-conn pool; no per-tenant query quota (noisy neighbor) | High | DB / fairness | Certain | Multi-tenant | Database | `main.ts:371`, `packages/db/src/index.ts:182-184` |
| RISK-037 | `dev_secret` stores connector OAuth tokens, full DML to brain_app, no RLS, runs in every env | High | Secret storage | Certain | Multi-tenant | Database / Security | `0024_dev_secret.sql:20-35` |
| RISK-038 | Duplicate migration number 0033 (consent_record_tombstone + send_log) — non-deterministic apply order | High | Migration integrity | Certain | Platform | Database / Arch | `0033_*.sql` (two files) |
| RISK-039 | Per-(partition,offset) retry counters in-memory → poison messages never reach DLQ across restart/rebalance | High | Recovery / poison-pill | High | Multi-tenant | Reliability | `CollectorEventConsumer.ts:34,134-159` |
| RISK-040 | Connector HTTP clients have no request timeout → hung upstream blocks job & partition indefinitely | High | Timeouts | Med | Multi-tenant | Reliability | `shopify-paged-client.ts:73,130`, `meta-insights-client.ts:147` |
| RISK-041 | Auth rate limiter fails OPEN on Redis error with no alert → brute-force/argon2 DoS under Redis degradation | High | Auth / DoS | Med | Platform | Security | `rate-limiter.ts:43-47` |
| RISK-042 | Logs unstructured `console.*`, no correlation IDs on lines, emission-time PII redaction never called | High | Logging | Certain | Platform | Observability | 258 `console.*`; `redact.ts:130` uncalled |
| RISK-043 | No error tracking (Sentry/equiv) anywhere; no dashboards; prod alarm has no notification target | High | Alerting / triage | Certain | Platform | Observability | grep sentry=0; grafana folder empty; `observability/main.tf` no SNS |
| RISK-044 | Checkov uses a 16-ID allowlist → hundreds of default checks silently disabled (open SG, IAM `*:*`, IMDSv2) | High | Policy-as-code | Certain | Platform | DevOps | `.checkov.yaml:40-56` |
| RISK-045 | ECR push role assumed by CI never created by Terraform; OIDC trust scoped to `main` but plan gate runs on PRs | High | OIDC / pipeline | Certain | Platform | DevOps | `main.yml:57`, `oidc-github/main.tf:86-89`, `infra.yml:5` |
| RISK-046 | eval.yml AI-quality gate is a green `echo TODO` stub (NLQ/injection/narration unenforced) | High | AI gate honesty | Certain | Platform | DevOps / AI | `eval.yml:9` |
| RISK-047 | LLM call defaults to Opus while labelled Tier-3; no spend cap, no prompt-cache markers, no gateway config | High | Cost routing | Certain | Multi-tenant | Cost / AI | `ai-gateway-client/src/client.ts:30-31,110-131` |
| RISK-048 | OAuth CSRF state in in-process Map → multi-replica core breaks connector installs non-deterministically | High | Correctness under scale | High | Single-tenant | Negative / Security | `InProcessOAuthStateStore.ts:22-29`, `main.ts:544` |
| RISK-049 | Collector has no `SET ROLE brain_app`; default DSN superuser → RLS bypassed on ingest write path | High | Tenant isolation | Certain | Multi-tenant | Negative / Security | `pg-spool.repository.ts:3-30`, `main.ts:91` |
| RISK-050 | No mutation testing & no coverage thresholds anywhere despite critical-path mandate | High | Test effectiveness | Certain | Platform | Testing | grep stryker/coverage = 0 |
| RISK-051 | No uncaughtException/unhandledRejection handlers; stream-worker no HPA/PDB/resource-limits/topology-spread | High | Resilience | Certain | Platform | Prod-readiness | grep handlers=0; no Deployment exists |
| RISK-052 | Audit hash-chain read-then-insert race forks chain under concurrency; WORM anchor + chain-walk not implemented | High | Audit integrity | Med | Single-tenant | Compliance | `packages/audit/src/index.ts:124-168`, `COMPLIANCE.md:115,131` |
| RISK-053 | DSAR (right-to-access) & data portability/export not implemented; consent withdrawal doesn't propagate to graph/ledgers/Bronze | High | Privacy rights | Certain | Platform | Compliance | grep DSAR=0; `consent-write.ts` |
| RISK-054 | RBAC role trusted entirely from JWT claim; demotion/removal not reflected until token expiry (≤1h) | High | Access control | Med | Single-tenant | Security | `rbac.ts:34-55`, `auth.service.ts:1158-1172` |
| RISK-055 | Module boundary lint rules INERT (can't match relative imports) + metric-engine fence stale & bypassed | High | Boundary enforcement | Certain | Operational | Architecture | `eslint.config.mjs:138-150,91`, `bff.routes.ts:53` |
| RISK-056 | bff.routes.ts 2,538-line god-file (46 routes, 8 positional params); issues raw OLTP SQL bypassing its repos | High | Complexity / layering | Certain | Operational | Code Quality | `bff.routes.ts:77-2538,778-801` |
| RISK-057 | Three webhook handlers re-implement identical 8-step HMAC pipeline (~1,256 LOC dup, already drifting) | High | Duplication / security | Certain | Multi-tenant | Code Quality | `shopflo/razorpay/shopify WebhookHandler.ts` |

---

## P2 / P3 — Medium & Low

The 66 Medium and 36 Low findings are catalogued in full in the individual board reports (`01`–`16`) and the tech-debt register (`91-tech-debt-register.md`). Representative Mediums carried forward as tracked debt:

- Connector `account_id` non-unique per provider → SECURITY DEFINER `LIMIT 1` webhook mis-routing (DB, M).
- Reconciliation DQ check compares mismatched grains with flat absolute tolerance (Data, M).
- Money hard-locked to exponent-2 currencies; CAPI passback loses bigint precision via `Number()/100` (Negative, M).
- Prod salt resolution conflates secret-ARN with raw-hex; KMS path dead; guard-by-convention across 8+ sites (Identity/Negative, M).
- `position_based` 40-40-20 not exact for non-divisible N (Attribution, M).
- Empty/stub bounded-context modules (identity/recommendation/billing) misrepresent the architecture map (Arch/Code, M).
- `apps/web/lib/api/types.ts` 1,309-line hand-mirror of `packages/contracts` (single-source violation, Code, M).
- Breach-notification readiness is documentation-only; no runbook, no PII catalog in CI (Compliance, M).
- Data residency: no app-layer region routing/enforcement; region-tag Checkov gate absent (Compliance, M).
