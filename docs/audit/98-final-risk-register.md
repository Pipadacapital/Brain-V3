# 98 — FINAL RISK REGISTER (reconciled, ranked, evidence-validated)

**Scope:** only evidence-validated findings. Each merges the board + persona findings, severity reconciled (corrected position taken where a persona corrected the board). Status: **confirmed** = re-verified against code this session; **disputed** = severity contested, resolution recorded; **refuted/corrected** = board claim overturned.

Severity: CRITICAL / HIGH / MEDIUM / LOW. Priority: P0 (blocks any tenant data) · P1 (pre-1k-brand / hardening) · P2 / P3 (backlog).

---

## TIER 0 — P0 release-blockers (any one is launch-gating)

| Rank | ID | Risk | Sev / Pri | Status | Strongest evidence |
|---|---|---|---|---|---|
| 1 | **R-01** | App runs as table-owning superuser → all 30 FORCE-RLS policies inert at runtime; the only line of tenant-data defense is app-layer WHERE clauses | CRITICAL / P0 | confirmed | `.env:3` `postgres://brain:brain`; `docker-compose.yml:20`; `infra/.../rds/main.tf:127` only `brainadmin`; `brain_app` zero hits in `infra/` |
| 2 | **R-02** | `@brain/db` GUC set via `SET LOCAL` outside a transaction → context discarded; on R-01 fix every BFF read fail-closes to 0 rows → login outage. **Must land WITH R-01.** | CRITICAL / P0 | confirmed | `packages/db/src/index.ts:201-209` (two separate `rawClient.query`, no `BEGIN`); correct pattern at `metric-engine/deps.ts:46-50` |
| 3 | **R-03** | Zero Dockerfiles → build-and-push pipeline dead on arrival | CRITICAL / P0 | confirmed | `find -name Dockerfile*` empty; `main.yml:74` builds `-f apps/${app}/Dockerfile` |
| 4 | **R-04** | ArgoCD apps reference non-existent manifests (`infra/helm/{core,stream-worker,web}`, `infra/k8s/`) → GitOps cannot sync | CRITICAL / P0 | confirmed | `infra/helm` = `README.md` + `authentik/values-dev.yaml`; `infra/k8s` MISSING |
| 5 | **R-05** | Observability is a self-declared Sprint-0 stub: no metrics/traces/errors backend wired | CRITICAL / P0 | confirmed | `packages/observability/src/index.ts:12-13,55,92` (`StubSpan.end()` no-op); zero `@opentelemetry/*`/`prom-client`/`pino`/`sentry` deps |
| 6 | **R-06** | "Auto-rollback" is `echo` banners over an actionless alarm; no `Rollout`/PrometheusRule | CRITICAL / P0 | confirmed | `main.yml:197-207` echo-only; `observability/main.tf:138-149` composite alarm has no `alarm_actions`/SNS |
| 7 | **R-07** | No SLO/burn-rate/freshness/DLQ/consumer-lag alert rules in prod | CRITICAL / P0 | confirmed | only `pod_crashloop`+`node_not_ready` child alarms, no notification target; grep `PrometheusRule\|burn.rate` in infra = 0 |
| 8 | **R-08** | Redis dedup claims slot BEFORE durable Bronze write → routine DB blip permanently drops the event (suppressed 7 days, undetectable under R-05) | CRITICAL / P0 | confirmed | `ProcessEventUseCase.ts:160` claim @ Step 2; `bronze.write()` @ `:193` Step 4 throws on DB error |
| 9 | **R-09** | Collector never implements `503 SPOOL_FULL`+`Retry-After`; spool unbounded → 500 + client data loss + shared-RDS exhaustion | CRITICAL / P0 | confirmed | `collect.route.ts` no spool-depth check, falls to Fastify default 500 |
| 10 | **R-10** | Attribution write-side is dead code; `attribution_credit_ledger` never populated in prod → decision-grade surface reads 100%-unattributed, indistinguishable from honest no-data | CRITICAL / P0 | confirmed | only non-test writer `credit-writer.ts`; `writeCredit`/`AttributionCreditWriter` only re-exported (`attribution/index.ts:46-47`); live path `LedgerWriter.ts:4` provably can't import core |
| 11 | **R-11** | Clawback has no over-reversal guard → attributed revenue can go negative; the formatter even masks small negative rates | CRITICAL / P0 | confirmed (reproduced) | `attribution-clawback.ts:132,147` no cumulative clamp; `apportionMinor` no non-negativity; executed: credit [4001,2000,4000] + two −10001 clawbacks = [-4001,-2000,-4000] |
| 12 | **R-12** | Erasure/crypto-shred pipeline asserted ENFORCED in Canon, does not exist; PII vault is plaintext with no destruction primitive (no `pii_ciphertext` column, no DELETE grant) | CRITICAL / P0 | confirmed | `pii_erasure_log`/`surrogate_brain_id` zero hits; `pii_ciphertext` comment-only (`0017:220,228`); `COMPLIANCE.md:110,116,156` overclaim |
| 13 | **R-13** | DSAR / right-to-access / data export entirely unimplemented and not even flagged deferred in Canon | HIGH / P0 | confirmed (corrected) | source grep `DSAR\|subjectAccess\|exportSubject` = 0 (board's "3 hits" were `.next/` artifacts) |
| 14 | **R-14** | createPool prod path never tested under `brain_app`; only live test runs as superuser → "isolation is tested" is literally true, operationally false | CRITICAL / P0 | confirmed | `switch-brand.live.test.ts:33` `postgres://brain:brain`; `rls.test.ts:155` is a `vi.fn` simulation; `isolation-fuzz/pg.test.ts` hand-rolls BEGIN, bypassing createPool |
| 15 | **R-15** | Deploy pipeline runs ZERO tests before prod promote; Playwright e2e/smoke (38 specs) run in NO CI workflow; StarRocks cross-tenant negative control self-skips on CI image | CRITICAL / P0 | confirmed | `main.yml` no lint/test/parity step; grep `playwright` in workflows = 0; `starrocks.test.ts:216` `ctx.skip()` on OSS allin1 |
| 16 | **R-16** | StarRocks analytics password defaults to repo-public dev credential; no `isProduction` fail-closed guard | HIGH / P0 | confirmed | `main.ts:191` `getEnv('STARROCKS_ANALYTICS_PASSWORD','brain_analytics_dev')`; contrast KMS throw at `main.ts:531` |

---

## TIER 1 — P1 (pre-1k-brand re-architecture / security & wire hardening)

| Rank | ID | Risk | Sev / Pri | Status | Strongest evidence |
|---|---|---|---|---|---|
| 17 | **R-17** | Idempotency-Key unenforced on connector-connect + consent writes → active data corruption (dup `connector_instance` + dup stored secret on retry) | HIGH / P1 | confirmed | `main.ts:956` reads no header; `:1051` mints `randomUUID()` then saves; only `member.routes.ts:372/428/475` enforce it |
| 18 | **R-18** | Single-instance sequential ingest scheduler, no shard/lease → ~100-brand ceiling; 2nd replica only doubles work | HIGH / P1 | confirmed | `ingest-scheduler/run.ts:56-99` sequential `for`; single `startIngestScheduler` (`main.ts:299`); only per-connector `FOR UPDATE SKIP LOCKED` |
| 19 | **R-19** | Audit hash-chain forks under concurrent same-brand appends (non-locking SELECT-then-INSERT); fork undetectable — PK is `id BIGSERIAL`, no per-brand `seq` (Canon overclaims `PK(brand_id,seq)`) | HIGH / P1 | confirmed | `packages/audit/src/index.ts:126-168` no `FOR UPDATE`/lock; `0001:75` BIGSERIAL PK; `COMPLIANCE.md:130` overclaim |
| 20 | **R-20** | No erasure propagation — consent withdrawal is suppression only; does not reach PII vault/identity graph/ledgers/Bronze; CAPI deletion is `would_delete_dev` no-op | HIGH / P1 | confirmed | `ConsentSuppressorConsumer.ts:60` consent-only; `capi-adapter.ts:116` `would_delete_dev` |
| 21 | **R-21** | Error envelope diverges from frozen contract (no `trace_id`, `request_id` sibling not nested) enforced by 395 hand-rolled blocks; no shared helper; no wire-format CI gate | HIGH / P1 | confirmed | `main.ts:306-322` shape; `grep trace_id` envelope = 0; 395 sites; `generated/openapi/openapi.json` paths = `['/v1/events']` only |
| 22 | **R-22** | Bronze is unpartitioned Postgres heap, no TTL — first cost wall (~500 brands), shares IOPS with OLTP; doc 03/07 still present Iceberg as live | HIGH / P1 | confirmed (disputed→HIGH) | `0016_bronze_events.sql:24` plain heap, self-labelled "NOT yet an immutable SoR"; board CRITICAL → reconciled HIGH (honest D-4 labelling) |
| 23 | **R-23** | No request timeout on connector HTTP clients → hung upstream blocks partition indefinitely | HIGH / P1 | confirmed | bare `fetch` no `AbortController` in shopify-paged/meta-insights clients |
| 24 | **R-24** | In-memory per-(partition,offset) retry counters in 9 consumers → poison messages never reach DLQ across restart/rebalance | HIGH / P1 | confirmed | `retryCount = new Map<RetryKey,number>()` ×9 consumers |
| 25 | **R-25** | No liveness/readiness probes; stream-worker has no HTTP port; core `/health` static (no dep check) | HIGH / P1 (→P0 once deployed) | confirmed (disputed) | grep `listen\|healthz` in stream-worker = test-only; `core/main.ts:327` static `{status:'ok'}` |
| 26 | **R-26** | Order Silver mart built from OLTP `realized_revenue_ledger`, not Bronze → Bronze-replay rebuildability broken for finance | HIGH / P1 | confirmed | `stg_order_ledger_events.sql:36` `source('oltp','realized_revenue_ledger')` vs `stg_touchpoint_events.sql:43` Bronze |
| 27 | **R-27** | Events produced as JSON not Avro; Apicurio schema loaded-but-never-applied on the wire → decode-failure alert can never fire | HIGH / P1 | confirmed | `collector/main.ts:51` registers avsc; `kafka-producer.ts:85` `JSON.stringify(rawBody)` |
| 28 | **R-28** | dbt-Silver build + StarRocks↔Bronze reconciliation + replay-stability absent from CI (parity IS gated — board "no parity in CI" REFUTED) | HIGH / P1 | corrected | `pr.yml:65,69` run `test:contract`+`test:parity` (RED control); grep `dbt\|starrocks\|reconciliation` in workflows = 0 |
| 29 | **R-29** | No per-tenant LLM spend cap; NLQ resolver defaults to top model tier; no gateway config in repo (cost-routing paradigm breach) | MEDIUM / P1 | corrected | `client.ts:31` `DEFAULT_RESOLVER_MODEL='claude-opus-4-8'`; cap of `RESOLVER_MAX_OUTPUT_TOKENS=256` REFUTES "unbounded" |
| 30 | **R-30** | No brand-scoped rate limiting; `/api/v1/ask` LLM route unthrottled per-brand; no `X-RateLimit-*` headers; `X-Correlation-Id` ingested but never echoed | MEDIUM / P1 | confirmed | `grep X-RateLimit` = 0; `bff.routes.ts:1234` /ask no limiter; `main.ts:238-241` ingests correlation, never echoes |
| 31 | **R-31** | No mutation testing, no enforced coverage thresholds; critical-path >95% floor unverifiable | HIGH / P1 | confirmed | grep `stryker` = docs only; no vitest `coverage.thresholds`; no `--coverage` gate |
| 32 | **R-32** | gitops-staging digest bump dead code; ECR push role never created by Terraform; OIDC trust scoped to `refs/heads/main` but plan gate runs on `pull_request`; Checkov is a 16-ID allowlist; eval.yml is `echo TODO`; prod env compute commented out | HIGH / P1 | confirmed | `main.yml:23` undefined `matrix.app`; `oidc-github/main.tf:84-88,101`; `.checkov.yaml` 16 IDs; `eval.yml:9`; `prod/bootstrap.tf` net/eks/rds commented |
| 33 | **R-33** | Auth rate limiter fails OPEN on Redis error with only `console.error` — no metric/alert; brute-force protection silently vanishes during Redis incident | MEDIUM / P1 | confirmed | `rate-limiter.ts:44-47` return `allowed:true` |
| 34 | **R-34** | No fixed pool tuning / pooler / `statement_timeout` → noisy-neighbor; one runaway query saturates a 3–10-conn pool | HIGH / P1 | confirmed | `packages/db/src/index.ts` defaults `max:10`, `statement_timeout:undefined`; worker pools `max:3` |

---

## TIER 2 — P2 (hardening / integrity fast-follows)

| Rank | ID | Risk | Sev / Pri | Status | Evidence |
|---|---|---|---|---|---|
| 35 | **R-35** | Duplicate migration `0033` (two files) → non-deterministic apply order on consent/security schema | MEDIUM / P2 | confirmed | `0033_consent_record_tombstone.sql` + `0033_send_log.sql` |
| 36 | **R-36** | Connector account-id columns non-unique → LIMIT-1 SECURITY DEFINER resolver can misroute settlements/spend cross-tenant | MEDIUM / P2 | confirmed | `0027:64` plain partial index; only uniqueness `UNIQUE(brand_id,provider)` (`0006`) |
| 37 | **R-37** | Cross-device journeys silently dropped (one-anon-per-order stitch map; no identity-graph fan-in on credit read) | HIGH / P2 | confirmed | `0031:43` `PK(brand_id,order_id)` over single `stitched_anon_id`; `credit-writer.ts:159` single-anon read |
| 38 | **R-38** | Silver/OLAP isolation opt-in by sentinel string — `String.replace` silent no-op if sentinel forgotten → unscoped cross-brand query | MEDIUM / P2 | confirmed | `silver-deps.ts:124`; `runScoped` never throws on missing sentinel |
| 39 | **R-39** | `bff.routes.ts` 2,554-line god-file (46 routes, 8 positional params incl. `pool` vs `rawPool` silent mis-wire) + `main.ts` 1,657-line second god-file | MEDIUM / P2 | confirmed | `wc -l` 2554 / 1657 |
| 40 | **R-40** | Webhook security pipeline re-implemented 3× (~1,256 LOC) → HMAC/replay-guard drift hazard | MEDIUM / P2 | confirmed | razorpay 474 + shopflo 399 + shopify 383 LOC, structurally identical |
| 41 | **R-41** | `ratePct` duplicated across 5 files; cursor/sync-state primitives redefined across 5 repull jobs (Single-Primitive violations) | MEDIUM / P2 | confirmed | `ratePct` in 5 metric-engine files; `acquireCursorLock` in 5 jobs |
| 42 | **R-42** | BFF issues raw OLTP SQL bypassing repositories (leaky abstraction); isolation REAL but milder than board framed (consistent QueryContext + explicit org_id) | MEDIUM / P2 | confirmed (disputed→milder) | inline SELECTs `bff.routes.ts:794/801/881/970/1042` |
| 43 | **R-43** | Reconciliation compares mismatched grains with flat absolute 100-order tolerance (over-passes whales, over-fails small brands) | MEDIUM / P2 | confirmed | `reconciliation-check.ts:29` `MAX_ROW_DELTA=100` |
| 44 | **R-44** | `dev_secret` plaintext connector credentials, no RLS, full DML to brain_app, migration runs in every env | MEDIUM / P2 | confirmed | `0024:35` GRANT to brain_app; not RLS-scoped |
| 45 | **R-45** | RBAC role trusted from JWT claim; demotion/removal not enforced until token expiry (≤1h) | MEDIUM / P2 | confirmed | `rbac.ts:44` reads `auth.role` from JWT, no DB re-check |
| 46 | **R-46** | Reconciliation rate untested; pure CI parity "oracle" leg is tautological (`unattributed = realized − attributed` then asserts sum) | HIGH / P2 | confirmed | `attribution-reconciliation.ts:78` zero unit tests; `attribution-parity-oracle.test.ts:316,319` |
| 47 | **R-47** | Leg-2 "independent SQL" reuses the seam's own window predicate; no boundary fixture → window-boundary bugs pass tolerance-0 | HIGH / P2 | confirmed | `attribution-credit-writer.live.test.ts:234` same `::date BETWEEN` predicate |
| 48 | **R-48** | Isolation/parity CI gates `--affected`-scoped → cross-cutting PR touching GUC middleware/migration can skip both | HIGH / P2 | confirmed | `pr.yml:67-69` `--affected` |
| 49 | **R-49** | No `uncaughtException`/`unhandledRejection` handlers in any service | MEDIUM / P2 | confirmed | grep across services = 0 |
| 50 | **R-50** | Logs unstructured `console.*` (258 calls), no correlation IDs on lines, `redactLogRecord` exists but never called → latent emission-time PII | MEDIUM / P2 | confirmed | facet of R-05 |
| 51 | **R-51** | Region-residency enforcement is stored attribute only; no routing/mismatch hard-error; no Checkov region-tag policy (Canon overclaims) | MEDIUM / P2 | confirmed | `policy/checkov/` no region policy; India-only today makes exposure LOW NOW |
| 52 | **R-52** | Breach-notification readiness doc-only; no runbook, no PII catalog, no CI assertion | MEDIUM / P2 | confirmed | `docs/runbooks` README stubs; no field-level catalog |
| 53 | **R-53** | WORM S3-Object-Lock audit anchor + quarterly chain-walk verifier claimed, not implemented | HIGH / P2 | confirmed | grep `ObjectLock\|verifyChain\|walkChain` = 0; s3-audit TF exists, nothing writes |
| 54 | **R-54** | No circuit breakers on any cross-service/external call | MEDIUM / P2 | confirmed | grep `CircuitBreaker\|opossum` = 0 |
| 55 | **R-55** | Per-`run()` constructs new Pool + Kafka producer per dispatch (latent exhaustion trap once R-18 adds concurrency) | HIGH / P2 | confirmed (disputed→HIGH) | `shopify-repull/run.ts:82-88` `new Pool({max:3})`+`new Kafka()` per call; board CRITICAL → HIGH |
| 56 | **R-56** | 8 consumer groups in one process re-read full live topic, filter in-app (~6× consumption CPU) | HIGH / P2 | confirmed | `stream-worker/main.ts` 8 groups "same live topic, separate group" |
| 57 | **R-57** | Dead `writeCredit` ships a PASSING live test (green test on zero-caller code); `rls.test.ts` "negative control" is a tautological vi.fn; auth refresh-rotation tested only against hand-mocked SQL | MEDIUM / P2 | confirmed | `attribution-credit-writer.live.test.ts`; `rls.test.ts:20-32`; `critical-paths.test.ts:87-89` |
| 58 | **R-58** | Single-partition backfill lane serializes onboarding cohorts (no graduation path); typed-topic catalogue collapsed to one collector topic, partition key gives zero per-order ordering | MEDIUM / P2 | confirmed | `topics.yml:33` `partitions:1`; `events/index.ts` `buildPartitionKey = brand_id:event_id` |

---

## TIER 3 — P3 (backlog)

| Rank | ID | Risk | Sev / Pri | Status | Evidence |
|---|---|---|---|---|---|
| 59 | **R-59** | No down-migrations; declared `migrate:down` non-functional (misleading capability; forward-only defensible for append-only design) | MEDIUM / P3 | confirmed (disputed→MEDIUM) | 37 plain `.sql`, zero `exports.down`; `package.json:26` declares `migrate:down` |
| 60 | **R-60** | No DR/restore-drill/failover runbook; RB-2 recovery itself broken (re-syncs R-04's missing manifests) | HIGH / P3 (process) | confirmed | runbooks README stubs |
| 61 | **R-61** | position_based "40-40-20" not exactly held; endpoints absorb middle remainder (sub-penny) | MEDIUM / P3 | confirmed (reproduced) | `attribution-models.ts:140-165`; N=5/9/11 endpoints=40000001 |
| 62 | **R-62** | `ratePct` loses sign for small negative rates (masks R-11 from human reviewer) | LOW / P3 | confirmed (reproduced) | `attribution-reconciliation.ts:31-37`; `ratePct(-34,10000)`→"0.34" |
| 63 | **R-63** | `dev_secret` plaintext OAuth tokens kept from prod only by runtime NODE_ENV guard (no structural backstop) | LOW / P3 | confirmed | `0024:22` plaintext TEXT; guard in `LocalSecretsManager.ts` |
| 64 | **R-64** | Cross-bounded-context import: shopflo imports razorpay `RedisDedupAdapter` | LOW / P3 | confirmed | `shopfloWebhookHandler.ts:38` |
| 65 | **R-65** | Hand-rolled JWT verify leaks signature length before constant-time compare (no forgery path) | LOW / P3 | confirmed | `jwt.ts:72` |
| 66 | **R-66** | Residual mixes two windowing semantics (as-of-diff vs inclusive-BETWEEN) → period-boundary disagreement | MEDIUM / P3 | confirmed | `attribution-reconciliation.ts:104-124` |
| 67 | **R-67** | `extractCorrelationId` fallback uses `Math.random()`; no SBOM/provenance; `latest` tag to IMMUTABLE ECR; EKS bring-up deadlock at min=0; no remote build cache; `subject_hash` regionCode inconsistency; event_id UUID v7-vs-v4 doc contradiction; no Bronze TTL job | LOW–MEDIUM / P3 | confirmed | bundled IaC/hygiene/latent items |

---

## Reconciliation ledger (corrected positions taken)

- **Bronze severity** CRITICAL→**HIGH** (R-22): honest D-4 self-labelling, nothing broken in prod.
- **Down-migrations** CRITICAL→**MEDIUM** (R-59): forward-only defensible; misleading `migrate:down` is the real defect.
- **Probe-absence** CRITICAL→**HIGH** (R-25): no Deployment to wedge yet; auto-escalates once deployed.
- **LLM cost** CRITICAL→**MEDIUM** (R-29): output cap + single-call REFUTE "unbounded"; cheaper-tier + per-tenant cap survive.
- **Per-run pool churn** CRITICAL→**HIGH** (R-55): exhaustion conditional on a future concurrency change.
- **"No parity in CI"** REFUTED → corrected to R-28 (reconciliation/dbt/starrocks absent, parity present).
- **"through 0020" stale comment** HIGH→**LOW** (folded into R-67): `migrate:up` applies all 37.
- **C-3 RLS-fragility framing** downgraded (R-42): consistent QueryContext + explicit org_id proven.
- **No finding refuted on core evidence** — every cited line held under independent verification.
