/**
 * Drainer loop — polls collector_spool for pending rows and produces to Redpanda.
 *
 * D-1 INVARIANT: this loop MUST be started AFTER the HTTP listener opens.
 * It runs on a setInterval, NOT inline in any HTTP request handler.
 *
 * F-3 / back-pressure: if Redpanda is down, DrainEventsUseCase returns 0 (skips batch).
 * Rows stay 'pending'. On Redpanda recovery, the next tick drains them automatically.
 * No event is dropped. No error is returned to the already-200'd caller.
 *
 * Startup: the drainer attempts to connect the Kafka producer. If Kafka is down at
 * startup, connection fails and the loop starts anyway — each tick then RE-ATTEMPTS
 * producer.connect() until it succeeds (never-connected ≠ permanent back-pressure),
 * and only drains once connected. The spool continues to ACK events throughout.
 */
import type { DrainEventsUseCase } from '../../application/drain-events.usecase.js';
import type { CollectorKafkaProducer } from '../../infrastructure/kafka-producer.js';
import { log as rootLog } from "../../log.js";

// Job-scoped child logger — every drainer line carries { job: 'collector-drainer' } so the
// background drain loop is distinguishable from request-path logs in the structured stream.
const log = rootLog.child({ job: 'collector-drainer' });

export interface DrainerConfig {
  /** How often to poll the spool for pending rows (ms). Default: 1000. */
  pollIntervalMs: number;
  /** Max rows to drain per tick. Default: 100. */
  batchSize: number;
}

export class Drainer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** In-flight guard (AUD-PERF-006): a tick slower than pollIntervalMs must NOT overlap the next. */
  private inTick = false;
  /** Consecutive failed producer-connect attempts — throttles the reconnect warn log. */
  private connectFailures = 0;

  constructor(
    private readonly drainUseCase: DrainEventsUseCase,
    private readonly producer: CollectorKafkaProducer,
    private readonly config: DrainerConfig,
  ) {}

  /**
   * Connect the Kafka producer with retry, then start the drain loop.
   * If Kafka is unreachable, starts the loop anyway (produces will fail fast,
   * spool rows stay pending — correct back-pressure behaviour).
   */
  async start(): Promise<void> {
    await this.connectProducer();
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    log.info(`started — poll every ${this.config.pollIntervalMs}ms, batch=${this.config.batchSize}`);
  }

  private async connectProducer(): Promise<void> {
    try {
      await this.producer.connect();
      if (this.connectFailures > 0) {
        log.info(`Kafka producer connected after ${this.connectFailures} failed attempt(s)`);
      } else {
        log.info('Kafka producer connected');
      }
      this.connectFailures = 0;
    } catch (err) {
      // Kafka may be down — drainer starts / keeps ticking anyway (back-pressure hold).
      // Throttle the warn: at 1 tick/s a broker outage would otherwise emit one warn per second.
      this.connectFailures += 1;
      if (this.connectFailures === 1 || this.connectFailures % 60 === 0) {
        log.warn(
          `Kafka producer connect failed (back-pressure mode, attempt ${this.connectFailures})`,
          { err },
        );
      }
    }
  }

  private async tick(): Promise<void> {
    // Skip when the previous tick is still draining (AUD-PERF-006): setInterval keeps firing while
    // a slow drain (Kafka stall, big batch) is in flight; without this guard two ticks would poll
    // the same pending rows and double-produce them.
    if (!this.running || this.inTick) return;
    this.inTick = true;
    try {
      // Producer never connected (startup lost the race against a booting/restarting Kafka) →
      // RE-ATTEMPT the connect each tick instead of letting every produceBatch fail on a
      // never-connected producer forever ("permanent back-pressure" — seen live 2026-07-17: the
      // docker stack restarted ~1 min before the collector booted, connect() lost the race, and
      // all spool rows stayed 'pending' until a process restart). Still not connected after the
      // attempt → skip the drain (rows stay 'pending'; no pointless claim/rollback churn).
      if (!this.producer.isConnected()) {
        await this.connectProducer();
        if (!this.producer.isConnected()) return;
      }
      const count = await this.drainUseCase.execute();
      if (count > 0) {
        log.info(`drained ${count} event(s)`);
      }
    } catch (err) {
      // Unexpected drainer error — log but do not crash the loop.
      // Pass the Error in fields.err so Sentry + stack handling fires.
      log.error('tick error', { err });
    } finally {
      this.inTick = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.producer.disconnect();
      log.info('stopped and Kafka producer disconnected');
    } catch (err) {
      log.warn('disconnect error', { err });
    }
  }
}
