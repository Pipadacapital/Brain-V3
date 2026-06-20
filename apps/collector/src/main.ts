/**
 * Collector (Deployable 1) — accept-before-validate ingest. ADR-003.
 *
 * D-1 ORDERING (immutable invariant):
 *   HTTP body → INSERT collector_spool → HTTP 200 ACK
 *   ← async, separate loop → drainer → Redpanda.produce()
 *
 * The 99.95% durability guarantee lives in collector_spool, NOT in the Kafka client.
 * Even with Redpanda completely down, every event is ACK'd and spooled.
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
import { parseEnv, CollectorEnvSchema } from '@brain/config';
import { initObservability, initSentry, createLogger } from '@brain/observability';
import { registerSchema, defaultApicurioConfig } from '@brain/events';
import { PgSpoolRepository } from './infrastructure/pg-spool.repository.js';
import { CollectorKafkaProducer } from './infrastructure/kafka-producer.js';
import { AcceptEventUseCase } from './application/accept-event.usecase.js';
import { DrainEventsUseCase } from './application/drain-events.usecase.js';
import { Drainer } from './interfaces/jobs/drainer.js';
import { registerCollectRoute } from './interfaces/rest/collect.route.js';
import { registerHealthRoutes } from './interfaces/rest/health.route.js';
import { registerPixelAssetRoute } from './interfaces/rest/pixel-asset.route.js';
import { EdgeRateLimiter, registerEdgeGuard } from './interfaces/rest/edge-guard.js';
import { SpoolBackpressure, registerSpoolBackpressure } from './interfaces/rest/spool-backpressure.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────

const cfg = parseEnv(CollectorEnvSchema, {
  ...process.env,
  SERVICE_NAME: process.env['SERVICE_NAME'] ?? 'collector',
});

/** Structured logger for collector lifecycle/error logs. */
const log = createLogger({ serviceName: 'collector' });

// ── Apicurio schema registration with exponential backoff (D-10) ──────────────

async function registerSchemaWithBackoff(): Promise<void> {
  const apicurioUrl = cfg.APICURIO_REGISTRY_URL ?? process.env['APICURIO_URL'] ?? 'http://localhost:8080';

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
  await initObservability({ serviceName: 'collector', otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT });
  await initSentry({ serviceName: 'collector' }); // gated by SENTRY_DSN (no-op in dev)

  // ── 1. Infrastructure wiring ─────────────────────────────────────────────────
  const spoolRepo = new PgSpoolRepository(cfg.DATABASE_URL);

  const brokers = cfg.REDPANDA_BROKERS.split(',').map((b) => b.trim());
  const topic = `${cfg.NODE_ENV === 'production' ? 'prod' : 'dev'}.collector.event.v1`;

  const kafkaProducer = new CollectorKafkaProducer({
    brokers,
    clientId: 'collector-drainer',
    topic,
    ...(cfg.REDPANDA_SASL_USERNAME && cfg.REDPANDA_SASL_PASSWORD
      ? {
          sasl: {
            mechanism: 'plain' as const,
            username: cfg.REDPANDA_SASL_USERNAME,
            password: cfg.REDPANDA_SASL_PASSWORD,
          },
        }
      : {}),
  });

  // ── 2. Use-cases ─────────────────────────────────────────────────────────────
  const acceptUseCase = new AcceptEventUseCase(spoolRepo);
  const DRAIN_BATCH_SIZE = 100;
  const drainUseCase = new DrainEventsUseCase(spoolRepo, kafkaProducer, DRAIN_BATCH_SIZE);
  const DRAIN_POLL_MS = Number(process.env['DRAIN_POLL_INTERVAL_MS'] ?? 1_000);

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

  // ── Edge abuse protection (REC-9): per-install_token rate-limit + origin allowlist ──
  // reject-before-spool preHandler (NOT a D-1 violation — admission gate, not validation).
  // VETO Set-Cookie on /collect (REC-4): the limiter is stateless, anon-id is client-side.
  const edgeLimiter = new EdgeRateLimiter({
    maxPerWindow: Number(process.env['EDGE_RATE_MAX_PER_WINDOW'] ?? 600),
    windowMs: Number(process.env['EDGE_RATE_WINDOW_MS'] ?? 60_000),
    originAllowlist: (process.env['EDGE_ORIGIN_ALLOWLIST'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
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

  // Register routes
  registerHealthRoutes(app, spoolRepo, backpressure);
  registerPixelAssetRoute(app); // GET /pixel.js — the served brain.js asset (Track B)
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

  // ── 7. Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info('signal received — graceful shutdown', { signal });
    backpressure.stop();
    await drainer.stop();
    await app.close();
    await (spoolRepo as PgSpoolRepository & { end(): Promise<void> }).end();
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
