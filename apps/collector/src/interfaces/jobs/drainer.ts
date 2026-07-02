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
 * Startup: the drainer attempts to connect the Kafka producer. If Redpanda is down
 * at startup, connection fails and the loop starts anyway — each tick retries the
 * produce, catching errors. The spool continues to ACK events.
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
      log.info('Kafka producer connected');
    } catch (err) {
      // Redpanda may be down — drainer starts anyway (back-pressure hold).
      log.warn('Kafka producer connect failed (back-pressure mode)', { err });
    }
  }

  private async tick(): Promise<void> {
    // Skip when the previous tick is still draining (AUD-PERF-006): setInterval keeps firing while
    // a slow drain (Kafka stall, big batch) is in flight; without this guard two ticks would poll
    // the same pending rows and double-produce them.
    if (!this.running || this.inTick) return;
    this.inTick = true;
    try {
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
