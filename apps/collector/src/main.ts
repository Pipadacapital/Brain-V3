/**
 * Collector (Deployable 1) — accept-before-validate ingest. ADR-003.
 *
 * D-1 ORDERING (immutable invariant):
 *   HTTP body → INSERT collector_spool → HTTP 200 ACK
 *   ← async, separate loop → drainer → Kafka.produce()
 *
 * The 99.95% durability guarantee lives in collector_spool, NOT in the Kafka client.
 * Even with Kafka completely down, every event is ACK'd and spooled.
 *
 * Startup sequence (D-10):
 *   1. Parse + validate config (exit 1 on invalid env).
 *   2. Connect spool DB (PgSpoolRepository).
 *   3. Register Avro schema with Apicurio — exponential backoff, max 30s.
 *      On timeout: log warning, degrade to spool-only mode (do NOT crash-loop).
 *   4. Open HTTP listener.
 *   5. Start drainer loop (separate async interval — NOT in request handler).
 */

import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { loadCollectorConfig } from '@brain/config';
import { initObservability, initSentry, createLogger } from '@brain/observability';
import { registerSchema, ensureCompatibilityRule, defaultApicurioConfig } from '@brain/events';
import { createFlagService, RedisFlagStoreAdapter, type RedisFlagClient } from '@brain/platform-flags';
import {
  createPixelIdentityConfigService,
  PgBrandConsentConfigReader,
} from './interfaces/rest/pixel-identity-config.js';
import { PgSpoolRepository } from './infrastructure/pg-spool.repository.js';
import { CollectorKafkaProducer } from './infrastructure/kafka-producer.js';
import { AcceptEventUseCase } from './application/accept-event.usecase.js';
import { DrainEventsUseCase } from './application/drain-events.usecase.js';
import { Drainer } from './interfaces/jobs/drainer.js';
import { registerCollectRoute } from './interfaces/rest/collect.route.js';
import { registerHealthRoutes } from './interfaces/rest/health.route.js';
import { registerMetricsRoute } from './interfaces/rest/metrics.route.js';
import { registerPixelAssetRoute } from './interfaces/rest/pixel-asset.route.js';
import { EdgeRateLimiter, registerEdgeGuard } from './interfaces/rest/edge-guard.js';
import { SpoolBackpressure, registerSpoolBackpressure } from './interfaces/rest/spool-backpressure.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────

// intentional: SERVICE_NAME defaults to 'collector' (the schema requires the literal) — set the
// env default BEFORE the memoized loader parses so an unset SERVICE_NAME still validates.
process.env['SERVICE_NAME'] = process.env['SERVICE_NAME'] ?? 'collector';
const cfg = loadCollectorConfig();

/** Structured logger for collector lifecycle/error logs. */
const log = createLogger({ serviceName: 'collector' });

// ── Apicurio schema registration with exponential backoff (D-10) ──────────────

async function registerSchemaWithBackoff(): Promise<void> {
  const apicurioUrl = cfg.APICURIO_REGISTRY_URL ?? cfg.APICURIO_URL;

  // Load the Avro schema from the contracts package generated artifact.
  // Path: packages/contracts/generated/avro/brain.collector.event.v1.avsc
  let avscJson: string;
  try {
    const avscPath = fileURLToPath(new URL('../../../packages/contracts/generated/avro/brain.collector.event.v1.avsc', import.meta.url));
    avscJson = readFileSync(avscPath, 'utf-8');
  } catch (err) {
    log.warn('Could not load Avro schema file — skipping Apicurio registration', { err });
    return;
  }

  // SPEC A.1.1 (WA-07, AMD-03): the pixel.identify.v1 JSON Schema artifact — registered alongside
  // the collector envelope, under the same idempotent boot step. Missing file → log + skip (never
  // blocks the envelope registration).
  let identifyJson: string | null = null;
  try {
    const identifyPath = fileURLToPath(new URL('../../../packages/contracts/generated/json-schema/brain.pixel.identify.v1.json', import.meta.url));
    identifyJson = readFileSync(identifyPath, 'utf-8');
  } catch (err) {
    log.warn('Could not load pixel.identify.v1 JSON Schema — skipping its Apicurio registration', { err });
  }

  // SPEC A.2.4 (WA-19, AMD-03/AMD-08): the identity.unmerged.v1 JSON Schema artifact — the ONE new
  // identity program topic that gets a registry-registered JSON Schema under FULL_TRANSITIVE. Registered
  // here on the collector's proven idempotent boot step (single governance site for the new JSON-Schema
  // program artifacts; the event is PRODUCED by core). Missing file → log + skip (never blocks boot).
  let identityUnmergedJson: string | null = null;
  try {
    const p = fileURLToPath(new URL('../../../packages/contracts/generated/json-schema/brain.identity.unmerged.v1.json', import.meta.url));
    identityUnmergedJson = readFileSync(p, 'utf-8');
  } catch (err) {
    log.warn('Could not load identity.unmerged.v1 JSON Schema — skipping its Apicurio registration', { err });
  }

  const apicurioConfig = {
    ...defaultApicurioConfig(),
    baseUrl: apicurioUrl,
  };

  const MAX_BACKOFF_MS = 30_000;
  let attemptMs = 500;
  let totalMs = 0;

  while (totalMs < MAX_BACKOFF_MS) {
    try {
      const result = await registerSchema(apicurioConfig, avscJson);
      log.info('Apicurio schema registered', { artifact_id: result.artifactId, version: result.version });
      // SPEC A.1.1 (WA-07, AMD-03): register pixel.identify.v1 (JSON Schema) + ensure its
      // FULL_TRANSITIVE compatibility rule (the AMD-03 idempotent boot step — the compose env var
      // provably does not materialize a rule, and a rule-less artifact enforces nothing).
      if (identifyJson) {
        const identifyConfig = { ...apicurioConfig, artifactId: 'pixel.identify.v1' };
        const identifyResult = await registerSchema(identifyConfig, identifyJson, 'JSON');
        await ensureCompatibilityRule(identifyConfig, 'FULL_TRANSITIVE');
        log.info('Apicurio schema registered', {
          artifact_id: identifyResult.artifactId,
          version: identifyResult.version,
          rule: 'FULL_TRANSITIVE',
        });
      }
      // SPEC A.2.4 (WA-19, AMD-03): identity.unmerged.v1 (JSON Schema) + its FULL_TRANSITIVE rule.
      if (identityUnmergedJson) {
        const unmergedConfig = { ...apicurioConfig, artifactId: 'identity.unmerged.v1' };
        const unmergedResult = await registerSchema(unmergedConfig, identityUnmergedJson, 'JSON');
        await ensureCompatibilityRule(unmergedConfig, 'FULL_TRANSITIVE');
        log.info('Apicurio schema registered', {
          artifact_id: unmergedResult.artifactId,
          version: unmergedResult.version,
          rule: 'FULL_TRANSITIVE',
        });
      }
      return;
    } catch (err) {
      log.warn('Apicurio registration attempt failed', { elapsed_ms: totalMs, err });
      await new Promise<void>((resolve) => setTimeout(resolve, attemptMs));
      totalMs += attemptMs;
      attemptMs = Math.min(attemptMs * 2, 5_000);
    }
  }

  // D-10: after backoff budget exhausted, degrade to spool-only (do NOT crash).
  log.warn(
    'Apicurio registration failed after 30s — degrading to spool-only mode. ' +
      'Schema will be registered on next restart. Events continue to spool and drain normally.',
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the flush fns so graceful shutdown can export the final telemetry batch before exit (C1).
  const shutdownObservability = await initObservability({ serviceName: 'collector', otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT });
  const closeSentry = await initSentry({ serviceName: 'collector' }); // gated by SENTRY_DSN (no-op in dev)

  // ── 1. Infrastructure wiring ─────────────────────────────────────────────────
  const spoolRepo = new PgSpoolRepository(cfg.DATABASE_URL);

  const brokers = cfg.KAFKA_BROKERS.split(',').map((b) => b.trim());
  const topic = `${cfg.NODE_ENV === 'production' ? 'prod' : 'dev'}.collector.event.v1`;

  const kafkaProducer = new CollectorKafkaProducer({
    brokers,
    clientId: 'collector-drainer',
    topic,
    ...(cfg.KAFKA_SASL_USERNAME && cfg.KAFKA_SASL_PASSWORD
      ? {
          sasl: {
            mechanism: 'plain' as const,
            username: cfg.KAFKA_SASL_USERNAME,
            password: cfg.KAFKA_SASL_PASSWORD,
          },
        }
      : {}),
  });

  // ── 2. Use-cases ─────────────────────────────────────────────────────────────
  const acceptUseCase = new AcceptEventUseCase(spoolRepo);
  const DRAIN_BATCH_SIZE = cfg.DRAIN_BATCH_SIZE;
  const drainUseCase = new DrainEventsUseCase(spoolRepo, kafkaProducer, DRAIN_BATCH_SIZE);
  const DRAIN_POLL_MS = cfg.DRAIN_POLL_INTERVAL_MS;

  const drainer = new Drainer(drainUseCase, kafkaProducer, {
    pollIntervalMs: DRAIN_POLL_MS,
    batchSize: DRAIN_BATCH_SIZE,
  });

  // ── 3. Apicurio schema registration (D-10) — with backoff, degrade-don't-crash ──
  await registerSchemaWithBackoff();

  // ── 4. Fastify HTTP server ───────────────────────────────────────────────────
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024, // 1 MiB
    trustProxy: true,
  });

  // Parse text/plain bodies as JSON. The pixel SDK posts events as text/plain (a CORS-"simple"
  // content-type) so cross-origin POSTs need no preflight — but the payload is still JSON. Accept-
  // before-validate (D-1): an unparseable body becomes {} and is spooled anyway (never lose an event).
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body && typeof body === 'string' ? JSON.parse(body) : {});
    } catch (err) {
      // intentional: accept-before-validate — an unparseable beacon body becomes {} and is spooled
      // anyway (never lose an event); the drainer/DQ quarantines malformed payloads downstream. Logged
      // at debug only (hot path: a misbehaving client could fire this per-request).
      log.debug('unparseable text/plain body — spooling empty envelope (accept-before-validate)', { err });
      done(null, {});
    }
  });

  // ── Edge abuse protection (REC-9): per-install_token rate-limit + origin allowlist ──
  // reject-before-spool preHandler (NOT a D-1 violation — admission gate, not validation).
  // VETO Set-Cookie on /collect (REC-4): the limiter is stateless, anon-id is client-side.
  const edgeLimiter = new EdgeRateLimiter({
    maxPerWindow: cfg.EDGE_RATE_MAX_PER_WINDOW,
    windowMs: cfg.EDGE_RATE_WINDOW_MS,
    originAllowlist: cfg.EDGE_ORIGIN_ALLOWLIST,
  });
  registerEdgeGuard(app, edgeLimiter);

  // ── Spool back-pressure (C4 / R-09): bound the pending backlog ───────────────
  // Sheds load with 503 SPOOL_FULL + Retry-After when the drainer falls behind, so the
  // durable spool cannot grow unbounded and fill the Postgres volume (which would fail the
  // ACK path for ALL tenants). Reject-before-spool admission gate (not validation → D-1 holds).
  const backpressure = new SpoolBackpressure(
    spoolRepo,
    {
      maxPending: cfg.SPOOL_MAX_PENDING,
      resumePending: cfg.SPOOL_RESUME_PENDING,
      sampleIntervalMs: cfg.SPOOL_SAMPLE_INTERVAL_MS,
      retryAfterSeconds: cfg.SPOOL_RETRY_AFTER_SECONDS,
    },
    (err) => log.warn('spool back-pressure sample failed — holding last known state', { err }),
  );
  registerSpoolBackpressure(app, backpressure);

  // ── SPEC A.1.1 + A.1.2 (WA-07/WA-08): per-brand pixel identity bootstrap wiring ──────────────
  // Redis (per-brand platform flags, DEFAULT OFF fail-closed) + PG (tenancy.brand consent config
  // via the 0121 SECURITY DEFINER reader). Everything here is fail-closed-to-legacy: Redis down,
  // PG down, flag OFF, or unknown token ⇒ the served asset carries NO identity config and behaves
  // exactly as before WA-07. lazyConnect mirrors apps/core (startup never blocks on Redis).
  const flagRedis = new Redis(cfg.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  flagRedis.connect().catch((err: unknown) => {
    log.warn('Redis connect failed — platform flags read disabled (pixel identity stays legacy)', { err });
  });
  const flagService = createFlagService({
    store: new RedisFlagStoreAdapter(flagRedis as unknown as RedisFlagClient),
  });
  const consentConfigReader = new PgBrandConsentConfigReader(cfg.DATABASE_URL);
  const pixelIdentityConfig = createPixelIdentityConfigService({
    reader: consentConfigReader,
    flags: flagService,
    onError: (err) => log.warn('pixel identity config resolve failed — serving legacy asset', { err }),
  });

  // Register routes
  registerHealthRoutes(app, spoolRepo, backpressure);
  registerMetricsRoute(app); // GET /metrics — Prometheus exposition (AUD-LOCAL-016); ungated (guards match POST ingest routes only)
  registerPixelAssetRoute(app, pixelIdentityConfig); // GET /pixel.js — the served brain.js asset (Track B + WA-07 identity bootstrap)
  registerCollectRoute(app, acceptUseCase);

  // ── 5. Start HTTP listener ───────────────────────────────────────────────────
  try {
    await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
    log.info('HTTP listener open', { port: cfg.PORT });
  } catch (err) {
    log.error('FATAL: failed to bind port', { port: cfg.PORT, err });
    process.exit(1);
  }

  // ── 6. Start drainer loop (AFTER HTTP listener — separate async loop, D-1) ──
  await drainer.start();

  // Prime + start the back-pressure gauge sampler (background interval; gate already wired).
  await backpressure.start();

  // ── 6b. Spool retention reaper (DB-AUDIT M6) — bound collector_spool growth ──────────────────
  // The drainer marks rows 'drained' but never deletes them; without a reaper the raw pre-tenant
  // buffer grows unbounded. Periodically purge drained rows past a short trail window. Best-effort:
  // a reap failure is logged, never fatal (the spool/ACK path is unaffected). unref so it never
  // holds the process open.
  const SPOOL_RETENTION_SECONDS = cfg.SPOOL_RETENTION_SECONDS; // 24h trail
  const SPOOL_REAP_INTERVAL_MS = cfg.SPOOL_REAP_INTERVAL_MS; // every 5 min
  const reaperTimer = setInterval(() => {
    void spoolRepo
      .reapDrained(SPOOL_RETENTION_SECONDS)
      .then((n) => { if (n > 0) log.info('spool reaper purged drained rows', { purged: n }); })
      .catch((err) => log.warn('spool reaper failed (non-fatal)', { err }));
  }, SPOOL_REAP_INTERVAL_MS);
  reaperTimer.unref?.();

  // ── 7. Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info('signal received — graceful shutdown', { signal });
    clearInterval(reaperTimer);
    backpressure.stop();
    await drainer.stop();
    await app.close();
    await (spoolRepo as PgSpoolRepository & { end(): Promise<void> }).end();
    // WA-07/WA-08 identity-bootstrap resources — best-effort teardown (both are fail-closed paths).
    await consentConfigReader.end().catch((err) => log.debug('consent-config pool end failed on shutdown', { err }));
    try { flagRedis.disconnect(); } catch (err) { log.debug('flag redis disconnect failed on shutdown', { err }); }
    // Flush buffered telemetry LAST so shutdown spans/metrics are exported (C1).
    // intentional: a flush failure during shutdown must not block process exit — best-effort,
    // logged at debug so a stuck exporter is still traceable.
    await shutdownObservability().catch((err) => log.debug('observability flush failed on shutdown', { err }));
    await closeSentry().catch((err) => log.debug('Sentry flush failed on shutdown', { err }));
    log.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Entry point — only called when run directly, not when imported in tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
