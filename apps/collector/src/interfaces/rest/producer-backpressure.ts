/**
 * producer-backpressure — bounded admission gate for the ingest routes (ADR-0015 D1).
 *
 * THE FAILURE THIS PREVENTS: the collector ACKs by producing to the log (produce-ack) or,
 * when the log is unreachable, by appending to the bounded local-disk WAL. The WAL is
 * size-capped (INGEST_FALLBACK_MAX_BYTES): during a long total log outage it fills. Past
 * the cap there is NO durable anchor left — accepting more events would mean losing them,
 * and an unbounded buffer just moves the disk-full cliff (the lesson of the deleted PG
 * spool). So we shed at the door: 503 + Retry-After, clients back off and retry.
 *
 * TWO LAYERS (both O(1), reject-before-anchor — admission control, not validation, so the
 * accept-before-validate D-1 posture holds exactly like the edge rate-limiter):
 *   • preHandler: producer disconnected AND WAL saturated → 503 before the handler runs.
 *   • error mapping: a produce that fails mid-request while the WAL is at cap throws
 *     FallbackSaturatedError from the accept path → mapped to the same 503 here.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { incrementCounter } from '@brain/observability';
import { FallbackSaturatedError, type LocalDiskFallback } from '../../infrastructure/local-disk-fallback.js';
import type { CollectorKafkaProducer } from '../../infrastructure/kafka-producer.js';
import { GUARDED_INGEST_ROUTES } from './edge-guard.js';

export interface ProducerBackpressureConfig {
  /** Retry-After header value (seconds) sent on a 503 INGEST_BACKPRESSURE. */
  retryAfterSeconds: number;
}

export interface ProducerBackpressureSnapshot {
  producerConnected: boolean;
  fallbackSaturated: boolean;
  fallbackPendingBytes: number;
  tripped: boolean;
}

export class ProducerBackpressure {
  constructor(
    private readonly producer: Pick<CollectorKafkaProducer, 'isConnected'>,
    private readonly fallback: Pick<LocalDiskFallback, 'isSaturated' | 'pendingBytes'>,
    private readonly cfg: ProducerBackpressureConfig,
  ) {}

  /**
   * Admission decision — true = admit. The collector must accept whenever EITHER durable
   * anchor is available: the log (producer connected) OR headroom in the disk WAL. Only
   * "log down AND WAL full" sheds — that is the whole point of the fallback (ADR-0015 D1).
   */
  admit(): boolean {
    return this.producer.isConnected() || !this.fallback.isSaturated();
  }

  get retryAfterSeconds(): number {
    return this.cfg.retryAfterSeconds;
  }

  snapshot(): ProducerBackpressureSnapshot {
    const producerConnected = this.producer.isConnected();
    const fallbackSaturated = this.fallback.isSaturated();
    return {
      producerConnected,
      fallbackSaturated,
      fallbackPendingBytes: this.fallback.pendingBytes(),
      tripped: !producerConnected && fallbackSaturated,
    };
  }
}

/** The 503 shed reply — one shape for both the preHandler and the error-mapping layer. */
async function shed(reply: FastifyReply, retryAfterSeconds: number): Promise<void> {
  // Shed counter backs the collector SLO burn-rate + back-pressure alerts (C2 / R-05).
  incrementCounter('collector_backpressure_shed_total');
  await reply
    .code(503)
    .header('Retry-After', String(retryAfterSeconds))
    .send({ accepted: false, error: { code: 'INGEST_BACKPRESSURE' } });
}

/**
 * Register the back-pressure gate scoped to the ingest endpoints. Route-PATTERN match
 * (query-string-free) over the full ingest set incl. /batch — raw req.url equality would let
 * `/collect?x=1` bypass the gate (AUD-PERF-001).
 */
export function registerProducerBackpressure(app: FastifyInstance, gate: ProducerBackpressure): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || !GUARDED_INGEST_ROUTES.has(req.routeOptions.url ?? '')) return;
    if (gate.admit()) return;
    await shed(reply, gate.retryAfterSeconds);
  });

  // Race coverage: the produce can fail AFTER admission while the WAL is at cap — the accept
  // path then throws FallbackSaturatedError. Map it to the same 503; everything else keeps
  // Fastify's default error handling (500 + logged by the process failure handlers).
  app.setErrorHandler(async (err: FastifyError | Error, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof FallbackSaturatedError) {
      await shed(reply, gate.retryAfterSeconds);
      return;
    }
    throw err; // rethrow → Fastify's default handler takes over
  });
}
