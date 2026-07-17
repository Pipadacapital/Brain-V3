/**
 * erasure-orchestrator/run.ts — the PG request-driven DPDP/PDPL erasure lane
 * (ADR-0015 WS4 completion: the LAST stream-worker Kafka consumer is gone).
 *
 * NOT a new deployable / topic / envelope: an interval poll loop wired into the already-
 * running apps/stream-worker/src/main.ts (same shape as the sync-request claimer / DQ loops).
 * Core's ErasureEventPublisher durably INSERTs the UNCHANGED CollectorEventV1-shaped trigger
 * envelope into ops.erasure_request_queue (0140); each tick here:
 *
 *   1. Requeues stale 'processing' rows (worker crash mid-sequence) — the redelivery an
 *      uncommitted Kafka offset used to provide. The sequence is idempotent (D-4), so a
 *      re-run converges to the same end-state.
 *   2. Claims due queue-head rows (per-brand ordered, FOR UPDATE SKIP LOCKED — see
 *      ErasureRequestQueueRepository for the Kafka-partition-parity argument) and processes
 *      them SEQUENTIALLY, oldest first.
 *   3. Feeds each payload byte-identically to the UNCHANGED EraseSubjectUseCase — the full
 *      ordered sequence: DEK shred → contact_pii hard delete → surrogate tombstone → Neo4j
 *      graph purge → scoped Gold re-projection + serving-cache eviction → Bronze raw sweep
 *      (Argo bronze-raw-erasure submit) → CAPI deletion (RequestCapiDeletionUseCase reuse) →
 *      pii_erasure_log complete.
 *   4. Folds the all-false envelope through ProjectConsentUseCase (an erasure IS a full
 *      consent withdrawal — the projection the trigger event's Bronze→Silver transit /
 *      the retired suppressor lane used to provide, now in-lane since the trigger no longer
 *      touches the log). Idempotent ON CONFLICT; self-gating (brain_id-only triggers carry
 *      no raw subject → 'no_subject' skip, same as before).
 *
 * RETRY / POISON DISCIPLINE (mirrors the retired consumer's offset/DLQ contract, D-7):
 *   - A write error (salt / DB / Neo4j / Argo submit / consent projection) does NOT complete
 *     the row: attempts+1, exponential backoff on next_attempt_at, row back to 'requested'.
 *     While parked, the brand's queue is blocked (head rule) — exactly like the consumer
 *     stuck on an uncommitted offset. Salt failure (D-2) rides this path: never processed
 *     with a bad/empty salt.
 *   - attempts >= MAX_RETRY(5) → status='dead' + structured error + counter metric
 *     (erasure_queue_dead_total) — the PG replacement for collector.event.v1.dlq.
 *   - 'invalid' (unparseable / missing brand_id|event_id) → dead IMMEDIATELY (no retry
 *     helps) — the old DLQ-immediate path. Defense in depth only: core validates the
 *     envelope against CollectorEventV1Schema before enqueueing.
 *   - Skip outcomes ('not_an_erasure' / 'no_consent_flags' / 'no_subject' / 'no_brain_id')
 *     → done (the old commit-as-skip), with 'no_brain_id' logged WARN as before.
 *
 * REPLAYABLE: re-enqueueing the same trigger (operator re-issue) re-runs the ordered
 * sequence (all steps idempotent) → same outcome (3× replay → one erasure record, one DEK
 * shred, one CAPI deletion).
 *
 * MUST use brain_app (RLS enforced) — never superuser 'brain'. The loop holds NO brand GUC;
 * every brand-scoped write happens inside the use case / repos under their own scoping.
 */
import { incrementCounter } from '@brain/observability';
import type { EraseSubjectUseCase } from '../../application/EraseSubjectUseCase.js';
import type { ProjectConsentUseCase } from '../../application/ProjectConsentUseCase.js';
import type {
  ClaimedErasureRequest,
  IErasureRequestQueueRepository,
} from '../../infrastructure/pg/ErasureRequestQueueRepository.js';
import { log } from '../../log.js';

/** Poison ceiling — parity with the retired consumer's MAX_RETRY=5 DLQ discipline. */
export const ERASURE_MAX_ATTEMPTS = 5;

/** A 'processing' claim older than this is presumed crashed and requeued (redelivery). */
export const ERASURE_STALE_PROCESSING_MS = 10 * 60 * 1000;

/** Exponential backoff for a failed attempt: 30s, 60s, 120s, 240s (capped 15m). */
export function retryBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60 * 1000);
}

export interface ErasureQueueDeps {
  repo: IErasureRequestQueueRepository;
  eraseSubject: EraseSubjectUseCase;
  /**
   * Consent-withdrawal fold (see header §4). Optional so unit harnesses can omit it;
   * main.ts ALWAYS wires it. FAIL-CLOSED when wired: a projection failure is a
   * consent-loss risk → the row retries (mirrors silver-identity's watermark hold).
   */
  projectConsent?: Pick<ProjectConsentUseCase, 'execute'>;
}

export interface ErasureTickResult {
  requeuedStale: number;
  claimed: number;
  erased: number;
  skipped: number;
  retried: number;
  dead: number;
}

/** Process one claimed row through the full ordered sequence + terminal state transition. */
async function processRow(
  deps: ErasureQueueDeps,
  row: ClaimedErasureRequest,
  result: ErasureTickResult,
): Promise<void> {
  const now = new Date().toISOString();
  const rowLog = log.child({ brand_id: row.brandId, erasure_request_id: row.id });
  // Byte-identical handoff: the stored envelope is the exact wire JSON the Kafka message
  // value carried, so EraseSubjectUseCase's parse/predicate/hash paths are unchanged.
  const value = row.payload != null ? Buffer.from(JSON.stringify(row.payload), 'utf8') : null;

  try {
    const outcome = await deps.eraseSubject.execute(value, now);

    if (outcome.outcome === 'invalid') {
      // Unparseable / missing brand_id|event_id → dead immediately (no retry helps) —
      // the old DLQ-immediate path. Core validates before enqueue, so this is exceptional.
      await deps.repo.markDead(
        row.id, row.attempts, outcome.reason ?? 'erasure_validation_error', 'invalid',
      );
      incrementCounter('erasure_queue_dead_total', { reason: 'invalid' });
      result.dead += 1;
      rowLog.warn(`[erasure-orchestrator] dead (invalid envelope) reason=${outcome.reason}`);
      return;
    }

    // Consent-withdrawal fold (an erasure IS a full withdrawal). Runs for every valid
    // envelope — including skip outcomes (the retired suppressor lane projected regardless
    // of whether the subject was known to the identity graph). Self-gating + idempotent.
    // A throw here rides the retry path below (consent loss must never be silent).
    if (deps.projectConsent) {
      await deps.projectConsent.execute(value, now);
    }

    // erased | not_an_erasure | no_consent_flags | no_subject | no_brain_id → done
    // (the old commit-after-confirmed-write / commit-as-skip).
    await deps.repo.markDone(row.id, outcome.outcome);

    if (outcome.outcome === 'erased') {
      result.erased += 1;
      rowLog.info(
        `[erasure-orchestrator] erased brand=${outcome.brandId} ` +
        `event=${outcome.eventId} brain_id=${outcome.brainId} ` +
        `surrogate=${outcome.surrogateId} ` +
        `bronze_raw_workflow=${outcome.bronzeRawWorkflow ?? 'not_configured'} ` +
        // AUD-OPS-039 / AUD-TP-22 evidence fields: graph edges tombstoned + whether the
        // serving-cache eviction ran (FAIL-OPEN — false is stale-until-TTL).
        `graph_links_tombstoned=${outcome.graphLinksTombstoned ?? 'not_wired'} ` +
        `cache_invalidated=${outcome.cacheInvalidated ?? false}`,
      );
    } else if (outcome.outcome === 'no_brain_id') {
      result.skipped += 1;
      // WARN parity: a valid erasure signal but subject not found in the identity graph.
      rowLog.warn(
        `[erasure-orchestrator] no_brain_id — subject hash not in identity graph ` +
        `brand=${outcome.brandId ?? 'unknown'} event=${outcome.eventId ?? 'unknown'}`,
      );
    } else {
      result.skipped += 1;
      rowLog.info(
        `[erasure-orchestrator] ${outcome.outcome} brand=${outcome.brandId ?? 'unknown'} ` +
        `event=${outcome.eventId ?? 'unknown'}`,
      );
    }
  } catch (err) {
    // Write error (shred / DB / salt / Neo4j / Argo / consent) — retry with backoff;
    // poison goes dead at MAX (the retired consumer's no-commit → retry → DLQ@MAX_RETRY).
    const attempts = row.attempts + 1;
    const lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

    if (attempts >= ERASURE_MAX_ATTEMPTS) {
      await deps.repo.markDead(row.id, attempts, `max_retry_exceeded: ${lastError}`, 'error');
      incrementCounter('erasure_queue_dead_total', { reason: 'max_retry_exceeded' });
      result.dead += 1;
      rowLog.error(
        `[erasure-orchestrator] DEAD (max retry ${attempts}/${ERASURE_MAX_ATTEMPTS}) — ` +
        `RTBF sequence NOT completed for this request; operator action required ` +
        `(ops.erasure_request_queue status='dead')`,
        { err },
      );
    } else {
      const backoffMs = retryBackoffMs(attempts);
      await deps.repo.markRetry(row.id, attempts, lastError, backoffMs);
      result.retried += 1;
      rowLog.error(
        `[erasure-orchestrator] write error (attempt ${attempts}/${ERASURE_MAX_ATTEMPTS}) — ` +
        `retrying in ${backoffMs}ms`,
        { err },
      );
    }
  }
}

/**
 * One poll tick: requeue stale claims, claim due queue heads, process sequentially.
 * Exported for unit tests + a potential one-shot CLI invocation.
 */
export async function processErasureQueueTick(
  deps: ErasureQueueDeps,
  claimBatch: number,
): Promise<ErasureTickResult> {
  const result: ErasureTickResult = {
    requeuedStale: 0, claimed: 0, erased: 0, skipped: 0, retried: 0, dead: 0,
  };

  result.requeuedStale = await deps.repo.requeueStaleProcessing(ERASURE_STALE_PROCESSING_MS);
  if (result.requeuedStale > 0) {
    log.warn(`[erasure-orchestrator] requeued ${result.requeuedStale} stale 'processing' row(s) (crash redelivery)`);
  }

  const rows = await deps.repo.claimBatch(claimBatch);
  result.claimed = rows.length;

  // SEQUENTIAL, oldest first — combined with the per-brand head claim this preserves the
  // Kafka partition-by-brand total order for the erasure lane.
  for (const row of rows) {
    await processRow(deps, row, result);
  }
  return result;
}

export interface ErasureOrchestratorHandle {
  stop(): Promise<void>;
}

/**
 * Resident poll loop (main.ts wire) — same lifecycle shape as startSyncRequestClaimer:
 * tick immediately, then every intervalMs; inFlight guard; a throw is logged and swallowed
 * so the loop never dies (individual-row failures are already absorbed by the retry lane —
 * a tick-level throw means the queue itself was unreachable).
 */
export function startErasureOrchestrator(
  deps: ErasureQueueDeps,
  intervalMs: number,
  claimBatch: number,
): ErasureOrchestratorHandle {
  let running = true;
  let inFlight = false;

  const tickOnce = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await processErasureQueueTick(deps, claimBatch);
      if (r.claimed > 0 || r.requeuedStale > 0) {
        log.info(
          `[erasure-orchestrator] tick claimed=${r.claimed} erased=${r.erased} ` +
          `skipped=${r.skipped} retried=${r.retried} dead=${r.dead} requeued_stale=${r.requeuedStale}`,
        );
      }
    } catch (err) {
      log.error('[erasure-orchestrator] tick failed (queue unreachable? non-fatal, will retry)', { err });
    } finally {
      inFlight = false;
    }
  };

  const loop = async (): Promise<void> => {
    while (running) {
      await tickOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
  void loop();

  return {
    stop: async (): Promise<void> => {
      running = false;
      // Bounded drain: wait for an in-flight tick to finish so a mid-sequence row is not
      // abandoned as a stale claim (it would still self-heal via requeueStaleProcessing).
      const deadline = Date.now() + 30_000;
      while (inFlight && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
