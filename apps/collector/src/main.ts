/**
 * Collector (Deployable 1) — accept-before-validate ingest. ADR-003 + ADR-0015.
 *
 * D-1 ORDERING (immutable invariant, re-anchored by ADR-0015 direct-to-log ingest):
 *   HTTP body → PRODUCE to the log (idempotent, acks=-1) → HTTP 200 ACK
 *   └─ on produce failure → fsync'd append to the bounded local-disk WAL → HTTP 200 ACK
 *      (background flusher re-produces the WAL on reconnect)
 *
 * The durability guarantee lives in the produce-ack (or the WAL append), NOT in Postgres.
 * The PG spool + drainer + reaper are DELETED (ADR-0015 D1). Even with Kafka completely
 * down, every event is ACK'd into the WAL until the cap — then 503 backpressure.
 *
 * Startup sequence (D-10):
 *   1. Parse + validate config (exit 1 on invalid env; INGEST_DIRECT_TO_LOG=false refuses boot).
 *   2. Init the local-disk fallback WAL (adopts crash-leftover bytes).
 *   3. Connect the Kafka producer — bounded boot retry; failure is NON-fatal (WAL covers).
 *   4. Register Avro schema with Apicurio — exponential backoff, max 30s (degrade, don't crash).
 *   5. Open HTTP listener.
 *   6. Start the fallback flusher loop (separate async interval — NOT in request handler).
 */

import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { loadCollectorConfig } from '@brain/config';
import { initObservability, initSentry, createLogger, registerProcessFailureHandlers } from '@brain/observability';
import { registerSchema, ensureCompatibilityRule, defaultApicurioConfig } from '@brain/events';
import { createFlagService, RedisFlagStoreAdapter, type RedisFlagClient } from '@brain/platform-flags';
import {
  createPixelIdentityConfigService,
  PgBrandConsentConfigReader,
} from './interfaces/rest/pixel-identity-config.js';
import { CollectorKafkaProducer } from './infrastructure/kafka-producer.js';
import { LocalDiskFallback } from './infrastructure/local-disk-fallback.js';
import { AcceptEventUseCase } from './application/accept-event.usecase.js';
import { registerCollectRoute } from './interfaces/rest/collect.route.js';
import { registerHealthRoutes } from './interfaces/rest/health.route.js';
import { registerMetricsRoute } from './interfaces/rest/metrics.route.js';
import { registerPixelAssetRoute } from './interfaces/rest/pixel-asset.route.js';
import { EdgeRateLimiter, registerEdgeGuard, edgePostureWarnings } from './interfaces/rest/edge-guard.js';
import { TokenBrandBinding } from './interfaces/rest/token-brand-binding.js';
import { ProducerBackpressure, registerProducerBackpressure } from './interfaces/rest/producer-backpressure.js';
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

  // SPEC I (Wave I, AMD-03): the five action.*.v1 envelopes — NEW program topics registered as
  // JSON Schema artifacts under FULL_TRANSITIVE (AMD-03 R1 enumerates action.*.v1 among the new
  // JSON-Schema program topics; NOT Avro). Loaded here on the collector's proven idempotent boot
  // step (single governance site for new JSON-Schema artifacts; the events are produced by the
  // Wave-I action platform, not the collector). Missing file → log + skip (never blocks boot).
  const actionArtifactIds = [
    'action.requested.v1',
    'action.approved.v1',
    'action.executed.v1',
    'action.failed.v1',
    'action.rolled_back.v1',
  ] as const;
  const actionSchemas: Array<{ artifactId: string; json: string }> = [];
  for (const artifactId of actionArtifactIds) {
    try {
      const p = fileURLToPath(
        new URL(`../../../packages/contracts/generated/json-schema/brain.${artifactId}.json`, import.meta.url),
      );
      actionSchemas.push({ artifactId, json: readFileSync(p, 'utf-8') });
    } catch (err) {
      log.warn(`Could not load ${artifactId} JSON Schema — skipping its Apicurio registration`, { err });
    }
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
      // SPEC I (Wave I, AMD-03): action.{requested,approved,executed,failed,rolled_back}.v1 (JSON
      // Schema) + their FULL_TRANSITIVE rules. Scaffold-only envelopes; no executor consumes them yet.
      for (const { artifactId, json } of actionSchemas) {
        const actionConfig = { ...apicurioConfig, artifactId };
        const actionResult = await registerSchema(actionConfig, json, 'JSON');
        await ensureCompatibilityRule(actionConfig, 'FULL_TRANSITIVE');
        log.info('Apicurio schema registered', {
          artifact_id: actionResult.artifactId,
          version: actionResult.version,
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

  // D-10: after backoff budget exhausted, degrade (do NOT crash) — the accept path keeps
  // ACKing via direct produce / disk fallback; schema registers on the next restart.
  log.warn(
    'Apicurio registration failed after 30s — degrading. ' +
      'Schema will be registered on next restart. Events continue to produce/fallback normally.',
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // ADR-0015 kill-switch guard: the PG spool path is DELETED, so INGEST_DIRECT_TO_LOG=false has
  // no path to fall back to. Refusing to boot is the only honest behavior — a silently-ignored
  // flag would look like a rollback while events kept flowing to the log (or worse, nowhere).
  // Rollback of this architecture is a git revert, not a flag flip.
  if (!cfg.INGEST_DIRECT_TO_LOG) {
    throw new Error(
      '[config] INGEST_DIRECT_TO_LOG=false but the spool path is deleted (ADR-0015 WS1). ' +
        'The flag is a kill switch that refuses boot rather than silently losing events — ' +
        'unset it (default true) or revert the direct-to-log commit to restore the spool.',
    );
  }

  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the flush fns so graceful shutdown can export the final telemetry batch before exit (C1).
  const shutdownObservability = await initObservability({ serviceName: 'collector', otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT });
  const closeSentry = await initSentry({ serviceName: 'collector' }); // gated by SENTRY_DSN (no-op in dev)
  // Last-resort handlers (AUD-IMPL-003): route unhandledRejection/uncaughtException through the
  // structured logger + Sentry (instead of Node's raw-stderr crash), then exit non-zero.
  registerProcessFailureHandlers({ log, serviceName: 'collector', flush: closeSentry });

  // ── 1. Infrastructure wiring ─────────────────────────────────────────────────
  const brokers = cfg.KAFKA_BROKERS.split(',').map((b) => b.trim());
  const topic = `${cfg.NODE_ENV === 'production' ? 'prod' : 'dev'}.collector.event.v1`;

  const kafkaProducer = new CollectorKafkaProducer({
    brokers,
    clientId: 'collector',
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

  // Bounded local-disk fallback WAL (ADR-0015 D1) — the durability anchor when the log is down.
  const fallback = new LocalDiskFallback(
    {
      dir: cfg.INGEST_FALLBACK_DIR,
      maxBytes: cfg.INGEST_FALLBACK_MAX_BYTES,
      flushIntervalMs: cfg.INGEST_FALLBACK_FLUSH_INTERVAL_MS,
    },
    kafkaProducer,
  );
  await fallback.init();

  // ── 2. Use-cases ─────────────────────────────────────────────────────────────
  const acceptUseCase = new AcceptEventUseCase(kafkaProducer, fallback);

  // ── 3. Kafka producer boot connect — bounded retry, NON-fatal ────────────────
  // The accept path must 200 via the WAL even when Kafka is down at boot; the fallback
  // flusher (and the hot path's lazy connect) keep re-attempting after these attempts.
  for (let attempt = 1; attempt <= 3 && !kafkaProducer.isConnected(); attempt += 1) {
    try {
      await kafkaProducer.connect();
      log.info('Kafka producer connected', { attempt });
    } catch (err) {
      log.warn('Kafka producer boot connect failed — WAL fallback covers accepts', { attempt, err });
      if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
  }

  // ── 4. Apicurio schema registration (D-10) — with backoff, degrade-don't-crash ──
  await registerSchemaWithBackoff();

  // ── 5. Fastify HTTP server ───────────────────────────────────────────────────
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024, // 1 MiB
    trustProxy: true,
  });

  // Parse text/plain bodies as JSON. The pixel SDK posts events as text/plain (a CORS-"simple"
  // content-type) so cross-origin POSTs need no preflight — but the payload is still JSON. Accept-
  // before-validate (D-1): an unparseable body becomes {} and is accepted anyway (never lose an event).
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body && typeof body === 'string' ? JSON.parse(body) : {});
    } catch (err) {
      // intentional: accept-before-validate — an unparseable beacon body becomes {} and is accepted
      // anyway (never lose an event); Silver quarantines malformed payloads downstream. Logged
      // at debug only (hot path: a misbehaving client could fire this per-request).
      log.debug('unparseable text/plain body — accepting empty envelope (accept-before-validate)', { err });
      done(null, {});
    }
  });

  // ── Edge abuse protection (REC-9): per-install_token rate-limit + origin allowlist ──
  // reject-before-accept preHandler (NOT a D-1 violation — admission gate, not validation).
  // VETO Set-Cookie on /collect (REC-4): the limiter is stateless, anon-id is client-side.
  const edgeLimiter = new EdgeRateLimiter({
    maxPerWindow: cfg.EDGE_RATE_MAX_PER_WINDOW,
    windowMs: cfg.EDGE_RATE_WINDOW_MS,
    originAllowlist: cfg.EDGE_ORIGIN_ALLOWLIST,
  });

  // ── install_token→brand_id binding (AUD-INFRA-025): tenant-isolation admission gate ──
  // The 0121 SECURITY DEFINER reader (constructed here; ALSO the WA-07 pixel-identity source
  // below) is the binding oracle: a fully-presented (token, brand_id) pair the oracle disproves
  // is rejected 403 TOKEN_BRAND_MISMATCH before the accept path — a LEAKED install_token can no
  // longer write another brand's lane. Fail-open on PG outage / unprovable pairs (no event loss).
  const consentConfigReader = new PgBrandConsentConfigReader(cfg.DATABASE_URL);
  const tokenBrandBinding = new TokenBrandBinding({
    reader: consentConfigReader,
    mode: cfg.EDGE_TOKEN_BINDING_MODE,
    ttlMs: cfg.EDGE_TOKEN_BINDING_TTL_MS,
  });
  registerEdgeGuard(app, edgeLimiter, tokenBrandBinding);

  // Insecure-posture warnings (AUD-INFRA-025): misconfig must be LOUD, never a silent allow-all.
  for (const warning of edgePostureWarnings(cfg.NODE_ENV, cfg.EDGE_ORIGIN_ALLOWLIST, cfg.EDGE_TOKEN_BINDING_MODE)) {
    log.warn(warning);
  }

  // ── Producer/fallback back-pressure (ADR-0015): bound the WAL, shed at cap ──
  // Sheds load with 503 INGEST_BACKPRESSURE + Retry-After ONLY when the log is unreachable
  // AND the disk WAL is saturated — the point where no durable anchor remains. Reject-before-
  // accept admission gate (not validation → D-1 holds).
  const backpressure = new ProducerBackpressure(kafkaProducer, fallback, {
    retryAfterSeconds: cfg.INGEST_FALLBACK_RETRY_AFTER_SECONDS,
  });
  registerProducerBackpressure(app, backpressure);

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
  // (consentConfigReader constructed above with the edge guard — one shared 0121 reader/pool.)
  const pixelIdentityConfig = createPixelIdentityConfigService({
    reader: consentConfigReader,
    flags: flagService,
    onError: (err) => log.warn('pixel identity config resolve failed — serving legacy asset', { err }),
  });

  // Register routes
  registerHealthRoutes(app, backpressure);
  registerMetricsRoute(app); // GET /metrics — Prometheus exposition (AUD-LOCAL-016); ungated (guards match POST ingest routes only)
  registerPixelAssetRoute(app, pixelIdentityConfig); // GET /pixel.js — the served brain.js asset (Track B + WA-07 identity bootstrap)
  registerCollectRoute(app, acceptUseCase, { firstPartyCookie: cfg.PIXEL_FIRST_PARTY_COOKIE });

  // ── 6. Start HTTP listener ───────────────────────────────────────────────────
  try {
    await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
    log.info('HTTP listener open', { port: cfg.PORT });
  } catch (err) {
    log.error('FATAL: failed to bind port', { port: cfg.PORT, err });
    process.exit(1);
  }

  // ── 7. Start the fallback flusher loop (AFTER HTTP listener — separate async loop, D-1) ──
  // The flusher re-produces WAL entries on reconnect and is the producer's reconnect driver
  // while Kafka is down (each tick attempts connect before flushing).
  fallback.start();

  // ── 8. Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info('signal received — graceful shutdown', { signal });
    await app.close();
    // Best-effort final WAL flush, then stop the flusher + close the append handle. Anything
    // unflushed survives on disk and is adopted by init() on the next boot (crash-safe WAL).
    await fallback.flushOnce().catch((err) => log.debug('final WAL flush failed on shutdown', { err }));
    await fallback.stop().catch((err) => log.debug('fallback stop failed on shutdown', { err }));
    await kafkaProducer.disconnect().catch((err) => log.debug('producer disconnect failed on shutdown', { err }));
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
