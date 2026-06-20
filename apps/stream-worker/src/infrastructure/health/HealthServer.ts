/**
 * HealthServer — minimal liveness/readiness HTTP endpoint for the stream-worker (T2-10).
 *
 * The stream-worker is a headless KafkaJS consumer process — it exposes NO HTTP surface, so an
 * orchestrator (K8s, ECS, Nomad) has no way to tell a wedged pod from a healthy one, nor a
 * still-booting pod from a ready one. Without that, a crash-looping or hung worker silently keeps
 * its partitions assigned and ingestion stalls with no signal.
 *
 * Two probes, two distinct meanings (do NOT collapse them):
 *   - GET /healthz — LIVENESS. The process is up and the event loop answers. Returns 200 as long
 *     as the server responds at all. A failure here means "restart the pod".
 *   - GET /readyz  — READINESS. The worker has finished starting its consumers AND its Postgres
 *     dependency is reachable right now. Returns 200 ready / 503 not-ready. A 503 means "pull me
 *     from rotation but DON'T kill me" — a booting or DB-blipped worker rejoins automatically.
 *
 * The DB ping is bounded (a hung socket must not make the probe itself hang — same posture as the
 * T2-9 connector timeouts). The check is dependency-agnostic via the injected `pingDb` thunk.
 */
import http from 'node:http';
import type { BrainLogger } from '@brain/observability';

export interface HealthServerOptions {
  /** Port to listen on (0.0.0.0). */
  port: number;
  /** True once every consumer has started — readiness gates on this. */
  isReady: () => boolean;
  /** Bounded Postgres reachability check; resolves when the DB answered, rejects/​throws otherwise. */
  pingDb: () => Promise<void>;
  /** Structured logger (the shared stream-worker logger). */
  log: Pick<BrainLogger, 'info' | 'warn'>;
}

export interface HealthServerHandle {
  /** Stop accepting connections and resolve once closed. */
  close: () => Promise<void>;
}

const READINESS_DB_TIMEOUT_MS = 2000;

/** Bound `pingDb` so a hung socket can't stall the readiness probe. */
async function pingDbBounded(pingDb: () => Promise<void>): Promise<void> {
  await Promise.race([
    pingDb(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('readiness db ping timed out')), READINESS_DB_TIMEOUT_MS),
    ),
  ]);
}

/** Start the health HTTP server. Returns a handle whose close() drains it on shutdown. */
export function startHealthServer(opts: HealthServerOptions): HealthServerHandle {
  const { port, isReady, pingDb, log } = opts;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (code: number, body: Record<string, unknown>): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url === '/healthz') {
      // Liveness: the process answers → it's alive. Never gated on dependencies.
      send(200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    if (url === '/readyz') {
      if (!isReady()) {
        send(503, { status: 'not_ready', reason: 'consumers_starting', timestamp: new Date().toISOString() });
        return;
      }
      pingDbBounded(pingDb)
        .then(() => send(200, { status: 'ready', timestamp: new Date().toISOString() }))
        // Do not leak the DB error string; the dependency name is enough for the operator.
        .catch(() =>
          send(503, { status: 'not_ready', reason: 'database_unreachable', timestamp: new Date().toISOString() }),
        );
      return;
    }

    send(404, { error: 'not_found' });
  });

  // Never let a health-port bind error crash the worker — log and continue (the consumers are
  // the product; the probe is auxiliary). A bind failure surfaces as an unreachable probe, which
  // the orchestrator already treats as not-ready.
  server.on('error', (err) => log.warn('[health] server error — probes may be unavailable', { err }));
  server.listen(port, '0.0.0.0', () => log.info(`[health] liveness/readiness probes on :${port}`));

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
