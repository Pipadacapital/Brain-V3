/**
 * process-handlers.ts — last-resort process-level failure handlers (AUD-IMPL-003).
 *
 * Node ≥ 15 kills the process on an unhandled promise rejection with a RAW stack straight to
 * stderr — bypassing the structured (PII-redacting, NN-6) logger AND the Sentry captureError
 * path; in K8s the automatic restart then masks the event entirely. These handlers route both
 * failure classes through the BrainLogger (whose error() forwards real Errors to Sentry) and
 * still exit non-zero, so crash semantics are unchanged — the orchestrator restarts the pod,
 * but now with evidence.
 *
 * This is defense-in-depth: every service loop already catches in-band; this only fires for
 * the truly un-caught (fire-and-forget promises, sync throws on bare event-loop turns).
 */
import type { BrainLogger, LogFields } from './logger.js';

export interface ProcessFailureHandlerOptions {
  log: BrainLogger;
  serviceName: string;
  /**
   * Optional telemetry flush (e.g. the closeSentry / shutdownObservability fns) awaited — with
   * a hard 2 s cap — before exiting, so the captured event actually leaves the process.
   */
  flush?: () => Promise<void>;
  /** TEST-ONLY seam; defaults to process.exit. */
  exit?: (code: number) => void;
}

/** Flush-then-exit with a hard timeout so a wedged exporter can never keep a dying process alive. */
function exitAfterFlush(opts: ProcessFailureHandlerOptions): void {
  const exit = opts.exit ?? ((code: number): void => process.exit(code));
  if (!opts.flush) {
    exit(1);
    return;
  }
  const timer = setTimeout(() => exit(1), 2000);
  // Node's default unref keeps timers alive; unref so the timer itself can't block a clean exit.
  timer.unref?.();
  void opts.flush().catch(() => undefined).finally(() => {
    clearTimeout(timer);
    exit(1);
  });
}

/**
 * Register `unhandledRejection` + `uncaughtException` last-resort handlers.
 * Call ONCE per process from main.ts, after the logger (and ideally Sentry) are initialized.
 * Returns an unregister fn (test seam).
 */
export function registerProcessFailureHandlers(opts: ProcessFailureHandlerOptions): () => void {
  const toError = (v: unknown): Error =>
    v instanceof Error ? v : new Error(`non-Error thrown/rejected: ${String(v)}`);

  const onUnhandledRejection = (reason: unknown): void => {
    const fields: LogFields = { err: toError(reason), failure_kind: 'unhandledRejection' };
    opts.log.error(`[${opts.serviceName}] FATAL: unhandled promise rejection — exiting`, fields);
    exitAfterFlush(opts);
  };
  const onUncaughtException = (err: Error): void => {
    const fields: LogFields = { err: toError(err), failure_kind: 'uncaughtException' };
    opts.log.error(`[${opts.serviceName}] FATAL: uncaught exception — exiting`, fields);
    exitAfterFlush(opts);
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };
}
