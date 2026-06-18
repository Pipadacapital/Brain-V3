# PASS 13 — Observability Audit (Brain Commerce OS)

**Reviewer:** Independent principal-level audit · **Domain:** Observability
**Repo root:** `/Users/rishabhporwal/Desktop/Brain V3/worktrees/audit`
**Date:** 2026-06-19

## Scope
Structured logging (`packages/observability`), metrics coverage, distributed tracing (trace IDs end-to-end), dashboards, alerting rules + thresholds, error tracking, SLA/SLO monitoring — compared to the documented SLOs (collector 99.95% accept+ack, freshness <60s live / settlement horizon, surfaces p95 <800ms) and the documented alert/dashboard set in `docs/requirements/04` §1845 and `docs/requirements/12` §85-86.

## Headline verdict
**There is NO real metrics, tracing, or error-tracking backend wired into the running services. Observability is effectively logs-only, and the logs themselves are unstructured `console.*` lines with no correlation IDs and no PII redaction at emission.** The entire `@brain/observability` package is a self-declared **stub** (`index.ts:11-16`) that emits metrics via `console.info` (`index.ts:162-169`). The infra OTel collector exists but its trace pipeline exports to `debug` only and its Grafana Cloud exporter is commented out (`infra/observe/otel-collector.yml`). No application imports `@opentelemetry/*` (confirmed: only `packages/observability/src/*` reference the term, and only in comments). No dashboard JSON exists. No SLO/burn-rate/freshness/DLQ/consumer-lag alert rule exists in prod — the only prod alarm is a single composite EKS-health CloudWatch alarm with no notification target. The documented SLO table and alert set are aspirational, not implemented.

---

## FINDINGS

### F1 — Observability package is a stub; metrics emit to `console.info`, spans/traces are no-ops
**Severity:** Critical | **Category:** Metrics + Tracing backend | **Priority:** P0
**Evidence:**
- `packages/observability/src/index.ts:11-16` — self-declared: *"This package avoids importing @opentelemetry/* directly in Sprint 0 to keep zero external deps. It exports the interface types and a stub implementation that will be wired to the real OTel SDK in M1."*
- `index.ts:55-99` `StubSpan` — `end()` is a literal no-op (`index.ts:91-93`: *"No-op in stub; real OTel SDK will flush to the OTLP exporter."*). Spans are never exported anywhere.
- `index.ts:161-169` default counter sink: `console.info(\`[metric] ${name} +${value} ${JSON.stringify(labels)}\`)` — every metric increment is a log line, not a metric stream.
- `packages/*/package.json` and `apps/*/package.json`: grep for `opentelemetry|prom-client|pino|sentry|prometheus` returns **zero** dependency entries. No OTel SDK, no Prometheus client, no error tracker is installed anywhere in the monorepo.

**Impact (production terms):** Zero distributed traces. The documented `gen_ai.*` spans, RED metrics, p95/p99 latency, Kafka consumer lag, OLAP query duration — none are produced. "Where is the slow span in the fan-out?" and "Is p99 breaking SLO?" are unanswerable. The `collector_dedup_conflict_total` counter (the only real metric wired, `CollectorEventConsumer.ts:109`) lands in a log line that nothing scrapes, so a forged/colliding `event_id` flood is not alertable.
**Root Cause:** Deliberate Sprint-0 deferral ("wired in M1") that was never completed; the stub is on the production import path of all three backend deployables (`apps/core`, `apps/collector`, `apps/stream-worker` `package.json` all depend on `@brain/observability`).
**Recommended Fix:** Wire `@opentelemetry/sdk-node` + auto-instrumentation (HTTP/Fastify, gRPC, kafkajs, pg, ioredis) behind the existing `BrainSpan`/`incrementCounter` interfaces; export OTLP to the collector; replace `StubSpan` and `defaultCounterSink` with real OTel Span/Meter. Gate "done" on a synthetic trace appearing in Tempo and a metric in Prometheus.
**Tenant Impact:** Multi-tenant blast radius — no per-tenant (`brand_id`) latency/error/lag visibility for ANY brand; an incident affecting one whale brand is invisible until customer report.
**Detection:** Surfaces as a production incident discovered via customer complaint or manual log grep, never via alert/metric.

---

### F2 — No metrics scrape path exists: Prometheus targets ports that serve no `/metrics`
**Severity:** Critical | **Category:** Metrics coverage | **Priority:** P0
**Evidence:**
- `infra/observe/prometheus.yml` scrapes `brain-collector` at `host.docker.internal:9091` and `brain-stream-worker` at `host.docker.internal:9092`.
- No application exposes a `/metrics` endpoint or instantiates a Prometheus registry: grep `/metrics|prom-client` across `apps/*/src` returns only unrelated business "metrics" (revenue-snapshot) and Kafka broker port `9092` (`apps/stream-worker/src/main.ts:47` — `9092` is the **Kafka broker** port, not a metrics endpoint; the scrape target collides with the broker port).
- `infra/argocd` and `infra/helm`: no `ServiceMonitor`, no `prometheus.io/scrape` pod annotation (grep returns nothing) — so even in EKS nothing discovers/scrapes app metrics.

**Impact:** Prometheus scrapes will fail/return nothing for both backend services. There is no metrics ingestion path from app → backend, even in local dev. RED metrics, consumer-lag, OLAP/PG query duration (the documented standard metric set) are entirely absent.
**Root Cause:** Scrape config written against an assumed `/metrics` endpoint that was never built (consequence of F1's stub).
**Recommended Fix:** Add an OTel/prom-client `/metrics` listener per service (or push OTLP metrics to the collector, which already has a `prometheus` exporter on `:8889`), then add ServiceMonitor/scrape annotations to the ArgoCD/Helm manifests.
**Tenant Impact:** Platform-wide; no per-brand metric dimensions anywhere.
**Detection:** Silent — Prometheus shows targets `DOWN`; no one is paged because no alert rule references these series.

---

### F3 — Trace pipeline exports to `debug` only; Grafana Cloud exporter is commented out (nothing leaves the collector in prod)
**Severity:** Critical | **Category:** Tracing backend / Dashboards data path | **Priority:** P0
**Evidence:** `infra/observe/otel-collector.yml`:
- `service.pipelines.traces.exporters: [debug]` — traces go only to the local debug exporter; **not** to Tempo/Grafana.
- The Grafana Cloud exporter block is entirely commented out: *"# otlphttp/grafana: ... # Uncomment and set GRAFANA_OTLP_ENDPOINT ... in production"*. No active exporter ships any signal off-box.
- `metrics` pipeline → `[prometheus, debug]` (local only); `logs` → `[loki, debug]` (local only). There is no production export target for ANY signal.

**Impact:** Even if F1/F2 were fixed and apps emitted OTLP, **traces would be dropped at the collector** (debug exporter only) and nothing would reach Grafana Cloud — the documented backend (`docs/requirements/12` §86: "Grafana Cloud"; ADR-009 referenced in `index.ts:10`). The Stage-8 DoD requirement "trace pipeline healthy post-deploy" cannot be satisfied; there is no trace store to be healthy.
**Root Cause:** Collector config left in local-dev posture; production exporter never enabled.
**Recommended Fix:** Add `otlphttp/grafana` (or Tempo) to the `traces` pipeline exporters; provision the Grafana Cloud OTLP endpoint/token via the secrets module; remove `debug` from prod pipelines.
**Tenant Impact:** Platform-wide.
**Detection:** Surfaces only when someone opens Grafana expecting traces and finds an empty store.

---

### F4 — No dashboards exist; the Grafana provisioning folder is empty
**Severity:** High | **Category:** Dashboards | **Priority:** P1
**Evidence:**
- `infra/observe/grafana/provisioning/dashboards/dashboards.yml` declares a file provider at path `/etc/grafana/provisioning/dashboards`, but `find infra -name "*.json"` returns **zero** dashboard JSON files. The provider has nothing to load.
- Documented requirement `docs/requirements/12` §86: "Dashboards: per-deployable health; data-quality (DQ grades, freshness); parity (StarRocks vs Bronze recompute, hourly); attribution (reconciliation tolerance, match-rate, unattributed bucket). Grafana Cloud." None of these dashboards exist as code.

**Impact:** No per-service health view, no data-quality/freshness dashboard, no parity-convergence dashboard, no attribution dashboard. On-call has no visual surface to triage; the documented "per-deployable health" saved views are absent.
**Root Cause:** Dashboards-as-code never authored; provisioning scaffold shipped empty.
**Recommended Fix:** Commit dashboard JSON for the documented set (per-deployable RED, DQ/freshness, parity, attribution) under the provisioning path; treat them as code reviewed with the slice.
**Tenant Impact:** Platform-wide; no per-brand drill-down dashboards.
**Detection:** Empty Grafana folder; discovered during an incident when no dashboard exists to open.

---

### F5 — No SLO / burn-rate / freshness / DLQ / consumer-lag alert rules in production
**Severity:** Critical | **Category:** Alerting | **Priority:** P0
**Evidence:**
- Documented SLO + alert table `docs/requirements/04` §1845-1849: Collector accept+ack 99.95% with **multiwindow 14.4×(1h)+6×(6h)** burn alert; Surfaces p95 <800ms (`p95>800ms 10m`); Data freshness live `>120s 10m`; settlement freshness breach. Documented alert set `docs/requirements/04` §304 (M7): consumer lag per group, DLQ depth, quarantine rate, materialization lag, schema-rejection rate, volume anomaly. `docs/requirements/12` §85: "SLO-burn, DLQ growth, freshness breach, parity drift, isolation-test failure (page)."
- Implemented alerting (`infra/terraform/modules/observability/main.tf`): exactly **two** child CloudWatch alarms — `pod_crashloop` (BackOff metric-filter, threshold 5/2-periods) and `node_not_ready` — combined into **one** composite alarm `eks_unhealthy`. The module header states the scope: *"Scope-reduced per ruling: CloudWatch log groups + ONE composite EKS-unhealthy alarm. Grafana Cloud owns SLOs."*
- grep for `alerting|alertmanager|alert_rule|burn.rate|PrometheusRule|groups:` across `infra` returns **only** Redpanda topic config — **zero** Prometheus alert rules, zero Grafana alert rules, zero burn-rate rules exist anywhere in the repo.

**Impact:** None of the documented SLO/operational alerts fire. A 99.95%-SLO breach on the ingest path, a freshness breach (stale OLAP → wrong numbers shown to brands), DLQ/quarantine growth, consumer-lag backlog, or parity drift are all **completely undetected**. The module defers SLOs to "Grafana Cloud" but no Grafana alert rules exist either (F4/F1 make the data unavailable regardless). This directly contradicts the `docs/requirements/12` §166 acceptance criterion "alert fires on synthetic breach."
**Root Cause:** SLO ownership punted to "Grafana Cloud," but the Grafana side was never built; the Terraform side was deliberately scope-reduced to EKS pod health only.
**Recommended Fix:** Author Grafana/Prometheus alert rules for the full documented set (multiwindow burn for collector 99.95%, surfaces p95, live + settlement freshness, DLQ depth, consumer lag per group, quarantine/schema-reject rate, parity drift, isolation-test failure → page) with the thresholds already specified in §1845. Wire a synthetic-breach test per §166.
**Tenant Impact:** Multi-tenant — a single brand's ingest degradation or stale data is undetectable; blast radius is per-brand silent data corruption surfaced to customers.
**Detection:** Surfaces as a customer-reported "my numbers are wrong / stale" incident, never as a page.

---

### F6 — The one production alarm has no notification/paging target
**Severity:** High | **Category:** Alerting / Incident response | **Priority:** P1
**Evidence:** `infra/terraform/modules/observability/main.tf` — `aws_cloudwatch_composite_alarm.eks_unhealthy` and both child alarms (`pod_crashloop`, `node_not_ready`) define **no** `alarm_actions`, no SNS topic, no PagerDuty/Opsgenie integration. The alarm changes state into the void.
**Impact:** Even the single implemented EKS-health alarm pages no one. A cluster-wide crashloop or node loss fires the alarm silently. The "page" requirement (`docs/requirements/12` §85) is unmet even for the one alarm that exists.
**Root Cause:** Alarm authored without an action sink; no SNS topic provisioned in the module.
**Recommended Fix:** Add an SNS topic + on-call subscription (PagerDuty/Opsgenie) and attach `alarm_actions`/`ok_actions` to the composite alarm.
**Tenant Impact:** Platform-wide (cluster health).
**Detection:** Alarm state visible only if someone opens the CloudWatch console; no proactive notification.

---

### F7 — Logs are unstructured `console.*` with no correlation IDs and no emission-time PII redaction
**Severity:** High | **Category:** Structured logging | **Priority:** P1
**Evidence:**
- 258 `console.{log,info,error,warn}` calls across `apps/*/src` (excluding tests). Examples: `apps/stream-worker/src/main.ts:249-413` (`console.info('[stream-worker] ...')`), `apps/collector/src/main.ts:51-72`, `CollectorEventConsumer.ts:80,99,121,129,147,151`.
- These are prefixed string lines (`[service] message`), **not** structured JSON. No `pino`/`structlog` dependency exists (F1 grep). The skill mandates structured JSON with `request_id + trace_id + tenant_id + user_id` on every line and a field-level `redact` config — none of this is present at the call sites.
- Correlation IDs exist in the request layer (`apps/core/src/main.ts:204,240`; `apps/collector/.../collect.route.ts:21`) and ride Kafka headers (`kafka-producer.ts:87`), but they are **never attached to the `console.*` log lines** — there is no `als.getStore()`-style child logger. A log search for `request_id:abc123` (the skill's non-negotiable verification) cannot stitch a call chain because the IDs aren't on the lines.
- `redactLogRecord` exists (`packages/observability/src/redact.ts:130`) but is **not called by any app** (grep: only the package's own test references it). The `redact.lua` collector second-pass referenced in `redact.ts:6` ("Config is in infra/observability") does not exist in the repo.

**Impact:** No cross-service trace stitching via logs; per-tenant investigation ("every line for `tenant_id`") is impossible because `brand_id` isn't on log lines. PII risk: any `console.error` of an event/error object can leak email/phone/PAN to CloudWatch unredacted (the SDK redactor is bypassed by `console.*`, exactly the skill's "console.log skips redaction" anti-pattern). `CollectorEventConsumer.ts:129` `console.error` of processing errors can carry event payloads.
**Root Cause:** No structured logger adopted; logging done ad-hoc with `console.*`; the redaction helper that exists was never wired into a logger.
**Recommended Fix:** Introduce pino with the AsyncLocalStorage child-logger pattern (correlation fields auto-attached) + the field redact list; ban `console.*` in app code via lint; add the collector `redact.lua` second pass; add the synthetic `email:'test@x.com'` never-reaches-store test.
**Tenant Impact:** Multi-tenant — cannot isolate logs by `brand_id`; PII leak risk spans all tenants writing to shared log groups.
**Detection:** A PII-in-logs incident found during a compliance/DPDP review, or an inability to trace during an active incident.

---

### F8 — No error tracking (Sentry or equivalent) anywhere
**Severity:** High | **Category:** Error tracking | **Priority:** P1
**Evidence:** grep for `sentry|datadog|newrelic|honeycomb|signoz` across the repo (excl. node_modules) returns **zero** matches. No `init({ dsn, release, beforeSend })`. Runtime exceptions are handled only via `console.error` (e.g. `apps/stream-worker/src/main.ts:413` `console.error('[stream-worker] fatal', err)`; `CollectorEventConsumer.ts:129,151`).
**Impact:** No aggregated, deduplicated, stack-traced error tracking. "What stack trace does this 500 correspond to?" requires manual CloudWatch log spelunking. No error-rate-spike signal, no release-tagged regressions, no `beforeSend` stitching errors to `request_id`/`brand_id`.
**Root Cause:** Error tracker never adopted.
**Recommended Fix:** Add Sentry (Node + web + future Python) with `release: '<service>@<sha>'` and a `beforeSend` that tags `request_id`/`trace_id`/`brand_id` from ALS.
**Tenant Impact:** Multi-tenant; no per-brand error attribution.
**Detection:** Errors discovered via raw log grep or customer report.

---

### F9 — Documented freshness/SLA monitoring (the core data-quality promise) has no runtime
**Severity:** High | **Category:** SLA/SLO monitoring | **Priority:** P1
**Evidence:** `docs/data-collection-platform/08-dataquality-and-trackingcenter.md:134` — Bronze/Ledger/Connector freshness calculation is defined and *"the contract exists (`DqFreshnessCheckSchema`); the runtime that executes it does not ('No live DQ logic ships in Sprint 0')."* §263 — Diagnostics center "Missing" (composes pixel `last_error`, connector health, DLQ depth, freshness lag, failed DQ checks). The documented freshness SLOs (`04` §1848-1849: live event→queryable p95 <60s alert at >120s/10m; settlement within horizon+grace) have no emitting code and no alert (see F5).
**Impact:** Freshness — the load-bearing signal for Brain's "honest freshness" / recommendation-safety promise (`04` §518-519, the seven connector states) — is not measured or alarmed at runtime. Stale data can be served as fresh with no detection; "recommendation_safety: degraded|blocked" gating has no freshness input feeding an alert.
**Root Cause:** DQ/freshness runtime deferred past Sprint 0; never resumed.
**Recommended Fix:** Implement the freshness evaluators (max-timestamp vs SLA per table/connector), emit as metrics, and wire the `>120s/10m` and settlement-breach alerts from §1848-1849.
**Tenant Impact:** Per-brand — a single connector going stale on one brand is invisible; that brand sees wrong/old numbers.
**Detection:** Customer report of stale dashboards; no internal signal.

---

### F10 — `extractCorrelationId` fallback uses `Math.random()` and treats W3C `traceparent` as an opaque correlation ID
**Severity:** Medium | **Category:** Tracing / correlation correctness | **Priority:** P2
**Evidence:** `packages/observability/src/index.ts:203-218`:
- `extractCorrelationId` returns the raw `traceparent` header value as the "correlation id" (`index.ts:206-210`) — but `traceparent` is the full W3C string (`00-<trace-id>-<span-id>-<flags>`), not a trace/correlation id. Using it verbatim conflates the span-id into the key, so two requests on the same trace get different "correlation ids."
- Fallback id generation: `return \`gen-${Date.now()}-${Math.random().toString(36).slice(2,10)}\`` (`index.ts:217`) — non-crypto, collision-prone, self-acknowledged ("real impl uses crypto"). Used on `apps/collector/.../collect.route.ts:21` on the ingest path.
**Impact:** Correlation IDs are inconsistent and collision-prone, undermining the one piece of cross-service stitching that does exist (Kafka header propagation). Two collector requests in the same millisecond can collide on `Math.random` truncation.
**Root Cause:** Placeholder implementation never hardened.
**Recommended Fix:** Parse `traceparent` per W3C and extract the 32-hex trace-id as the correlation key; generate fallbacks with `crypto.randomUUID()`.
**Tenant Impact:** Cross-tenant — collisions could (rarely) cause one brand's request to share a correlation id with another, corrupting any future per-id investigation.
**Detection:** Surfaces as confusing/partial traces during incident investigation.

---

### F11 — PII redact suffix list omits common keys; relies on a list that "grows, never shrinks" but is narrow
**Severity:** Medium | **Category:** Structured logging / PII | **Priority:** P2
**Evidence:** `packages/observability/src/redact.ts:64-72` — `PII_SUFFIX_PATTERNS` covers `_email/_phone/_mobile/_address/_pan/_aadhaar/_passport` but **not** `_name` (deliberately, to avoid `service_name`, per the comment) — meaning `customer_name`, `buyer_name`, `shipping_name` pass through unredacted. No coverage for `upi_id`/`vpa` in the SDK list (though the collector config `otel-collector.yml` does drop `upi_id` — the two layers are **inconsistent**, so an attribute the collector would drop is not dropped at the SDK layer, and vice-versa for `cvv`/`bank_account` which the SDK drops but the collector's explicit list omits beyond `cvv`).
**Impact:** Name-bearing and UPI/VPA attributes can reach spans/logs unredacted at the SDK layer (when it eventually ships). The two redaction layers (SDK list in `redact.ts:22-72` vs collector list in `otel-collector.yml`) are not synchronized, so defense-in-depth has gaps in both directions.
**Root Cause:** Two hand-maintained PII key lists that drifted; conservative suffix matching dropped `_name` entirely.
**Recommended Fix:** Single source-of-truth PII key list shared between the SDK redactor and a generated collector config; add `customer_name`/`buyer_name`/`upi_id`/`vpa` coverage; add a CI test asserting the two layers match.
**Tenant Impact:** Multi-tenant PII leak risk across all brands.
**Detection:** Found via a PII-in-spans synthetic test (which doesn't yet exist) or a compliance audit.

---

### F12 — No circuit breakers / breaker-state metric on cross-service & external calls
**Severity:** Medium | **Category:** Resilience telemetry | **Priority:** P2
**Evidence:** The observability floor (skill: "circuit breakers on every cross-service/external call" + `CircuitBreakerState` metric). grep for `circuit|breaker|CircuitBreaker` in `apps/*/src` returns nothing; the connector adapters (`ses-adapter.ts`, `capi-adapter.ts`, mapper HTTP calls) and gRPC/vendor calls have no breaker wrapper and emit no breaker-state signal. The documented LLM-fallback / analytics-degrade behaviors (`04` §564, chaos drills) have no breaker telemetry to drive them.
**Impact:** A slow/failing vendor (Razorpay, Shopify, Meta CAPI, SES) cascades instead of failing fast, and there is no `CircuitBreakerState` metric/alarm to detect sustained Open state. Degradation paths described in the docs aren't observable.
**Root Cause:** Resilience layer not implemented; consistent with the broader "no metrics backend" gap.
**Recommended Fix:** Wrap external/gRPC calls in a breaker (with timeout + bounded backoff) and emit `CircuitBreakerState` by downstream; alarm on sustained Open.
**Tenant Impact:** Multi-tenant — a vendor outage can degrade all brands with no early signal.
**Detection:** Cascading-failure incident; no breaker-open alert today.

---

## Severity tally
- **Critical:** 4 (F1, F2, F3, F5)
- **High:** 5 (F4, F6, F7, F8, F9)
- **Medium:** 3 (F10, F11, F12)
- **Low:** 0

## Domain verdict
Brain's observability is, in production terms, **logs-only and the logs are unstructured `console.*` without correlation IDs or emission-time PII redaction**. The `@brain/observability` package is an explicit stub that routes metrics to `console.info` and makes spans no-ops; no `@opentelemetry/*`, `prom-client`, `pino`, or Sentry dependency exists anywhere in the monorepo. The infra collector exists but its trace pipeline exports to `debug` only and its Grafana Cloud exporter is commented out, so even instrumented signals would never leave the box; Prometheus is configured to scrape `/metrics` endpoints that no service serves; the Grafana dashboard provider points at an empty folder; and the only production alarm is a single composite EKS-health CloudWatch alarm with **no notification target**. Against the documented SLOs (collector 99.95% accept+ack with multiwindow burn alerts, live freshness <60s, surfaces p95 <800ms, DLQ/lag/parity/freshness alerts, all on Grafana Cloud per `docs/requirements/04` §1845 and `docs/requirements/12` §85-86), essentially **nothing is implemented** — the SLO table is aspirational. The net result is that an ingest-path SLO breach, a freshness/staleness breach (the heart of Brain's "honest data → trust → decisions" promise), DLQ/consumer-lag backlog, parity drift, or a per-brand outage are all **silently undetectable**, and the first signal will be a customer report rather than a page. This is the highest-leverage area to fix before any production traffic; F1, F2, F3, and F5 are P0 blockers.
