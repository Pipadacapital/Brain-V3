# Deployment Report — observability-trace-and-circuit-breaker
**Date:** 2026-06-22T20:46:00Z
**Branch:** feat/universal-connector-platform
**Stage:** 8 — implementation complete, typecheck + tests green

## What shipped

### A. Kafka W3C Trace Propagation (all 9 stream-worker consumers)
Every `eachMessage` handler now calls `extractKafkaTraceContext(message.headers)` and wraps its body in `context.with(traceCtx, async () => { ... })`. Spans across the Kafka topic boundary are no longer orphaned root spans. Consumers patched:
- `CollectorEventConsumer`, `EventBronzeBridgeConsumer`, `BackfillOrderConsumer`, `LiveLedgerBridgeConsumer`, `SettlementLedgerConsumer`, `SpendLedgerConsumer`, `ShipmentLedgerConsumer`, `CapiDeletionConsumer`, `ConsentSuppressorConsumer`

### B. Tracing Backend (Tempo)
- `docker-compose.yml`: added `tempo` service (grafana/tempo:2.5.0) under the `observe` profile; port 3200 exposed; `otel-collector` and `grafana` depend on it.
- `infra/observe/tempo.yml`: Tempo local config (OTLP gRPC receiver on 4317, local storage, 48h retention).
- `infra/observe/otel-collector.yml`: added `otlp/tempo` exporter; traces pipeline now exports to `[otlp/tempo, debug]` instead of `[debug]` only.
- `infra/observe/grafana/provisioning/datasources/datasources.yml`: added Tempo datasource at `http://tempo:3200` with Loki/Prometheus trace correlation.

### C. Three Grafana Dashboards
- `infra/observe/grafana/provisioning/dashboards/ingest-health.json` — accept rate, spool-full shed, Bronze write rate, consumer lag, DLQ growth, circuit breaker rejections.
- `infra/observe/grafana/provisioning/dashboards/connector-health.json` — per-provider dispatch rate/errors, rate-limiting, auth rejections, circuit breaker state changes, scheduler overruns, Meta token refresh errors.
- `infra/observe/grafana/provisioning/dashboards/revenue-integrity.json` — ledger write rates, over-reversals, CoD RTO clawbacks, Silver lag, DLQ redrive, ad spend and settlement writes.

### D. BrainWebhookProduceFailing Alert
- `infra/observe/alerts/brain-slo.rules.yml`: new `brain-webhook-health` group with `BrainWebhookProduceFailing` alert (critical; two-window 1m+5m burn guard on `brain_collector_webhook_produce_error_total`).

### E. Circuit Breaker (`@brain/observability`)
- `packages/observability/src/circuit-breaker.ts`: Closed/Open/HalfOpen state machine; emits OTel counters; optional `callTimeoutMs` per-call deadline.
- `packages/observability/src/kafka-trace.ts`: `extractKafkaTraceContext` / `injectKafkaTraceContext` helpers.
- `packages/observability/src/index.ts`: exports added for both.
- `packages/observability/src/circuit-breaker.test.ts`: 11 unit tests, 36 total pass.

### F. Circuit Breaker wrapping all 8 vendor clients
- `shopify-paged-client.ts` (name: `shopify-backfill`, threshold: 5, openMs: 30s)
- `shopify-live-client.ts` (name: `shopify-live`, threshold: 5, openMs: 30s)
- `meta-insights-client.ts` (name: `meta-insights`, threshold: 5, openMs: 60s)
- `meta-token-client.ts` (name: `meta-token`, threshold: 3, openMs: 60s — module-level singleton)
- `google-ads-searchstream-client.ts` (name: `google-ads`, threshold: 5, openMs: 60s)
- `razorpay-settlements-client.ts` (name: `razorpay`, threshold: 5, openMs: 60s)
- `gokwik-awb-client.ts` (name: `gokwik-awb`, threshold: 5, openMs: 30s)
- `shiprocket-client.ts` (name: `shiprocket`, threshold: 5, openMs: 30s)

### G. Ingest-scheduler per-connector deadline
- `ingest-scheduler/run.ts`: `DISPATCH_DEADLINE_MS = 5 * 60 * 1000` (5-minute backstop); `Promise.race([run(id), deadlinePromise])` with `finally { clearTimeout }`.

### H. Package dependency
- `apps/stream-worker/package.json`: added `@opentelemetry/api: ^1.9.0` (direct dep needed for `context` import in consumers).

## Verification
- `pnpm --filter @brain/observability typecheck` — PASS (0 errors)
- `pnpm --filter @brain/stream-worker typecheck` — PASS (0 errors)
- `pnpm --filter @brain/observability test:unit` — PASS (36/36)

## Reversibility recipe
- Kafka trace propagation: remove `extractKafkaTraceContext` + `context.with()` from each consumer (revert to plain `eachMessage` body). No DB or Kafka state change — pure code path.
- Tempo: `docker compose --profile observe stop tempo` and remove the `tempo` service + dependency edges from `docker-compose.yml`; revert `otel-collector.yml` traces exporters to `[debug]`.
- Circuit breakers: remove `this.breaker.fire(async () => { ... })` wrappers from each client and delete `packages/observability/src/circuit-breaker.ts` + `kafka-trace.ts`; revert `index.ts` exports.
- Ingest-scheduler deadline: revert to `await run(connector.connector_instance_id)`.
- All changes are in `feat/universal-connector-platform`; master is not affected.
