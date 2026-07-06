/**
 * Backfill — the resumable, chunked, idempotent historical-backfill contract.
 *
 * This is the generic engine behind the platform target: "pull up to 2 years (or the platform max)
 * of history for any resource, in resumable chunks that can run in intervals or be picked up later,
 * with strict dedup and zero loss". Today only Shopify has a hand-written 24-month order backfill;
 * this generalises that one job into a connector-agnostic driver any resource can plug into.
 *
 * SEPARATION OF CONCERNS (the key design move):
 *   - The CONNECTOR supplies only a `IResourcePageFetcher`: "given a cursor, give me the next page
 *     of raw records + the next cursor". It knows nothing about checkpointing, resumption, dedup,
 *     retries, or DB state — just how to page its own API.
 *   - The DRIVER (`runResumableBackfill`) owns the loop: clamp the window to the platform max,
 *     resume from the persisted cursor, fetch a page, derive each record's deterministic event_id,
 *     deliver it with no-loss semantics, then CHECKPOINT the cursor + reachedAt after the chunk so
 *     the run is pausable/resumable/crash-safe at every boundary.
 *
 * Because (a) the cursor is persisted after each chunk and (b) every event's id is deterministic,
 * the driver is idempotent: re-running a partially-done backfill re-emits already-seen records,
 * and Bronze drops them on event_id — no duplicates, no loss, exact resume.
 */
import type { CanonicalEvent } from './CanonicalEvent.js';
import type { IDedupKeyDeriver } from './Dedup.js';
import { deterministicDedupKeyDeriver } from './Dedup.js';
import type { IEventSink, IDeadLetterSink, RetryPolicy } from './NoLoss.js';
import { deliverWithNoLoss, DEFAULT_RETRY_POLICY } from './NoLoss.js';
import type { ResourceDescriptor } from './IngestionManifest.js';
import { resolveBackfillFloor } from './IngestionManifest.js';
import { ResourceBackfillState } from '../domain/entities/ResourceBackfillState.js';
import type { IResourceBackfillStateRepository } from '../domain/repositories/IResourceBackfillStateRepository.js';

/** One raw record fetched from a resource, paired with the metadata the driver needs to emit it. */
export interface FetchedRecord {
  /** The upstream-immutable id (for 'provider_id' / 'provider_id+kind' dedup). */
  readonly providerId?: string;
  /** Resolved composite dedup field values (for 'composite' dedup), in dedupKeyFields order. */
  readonly compositeValues?: readonly string[];
  /**
   * The canonical event(s) this raw record maps to. The driver stamps the deterministic event_id
   * onto each before delivery (so the fetcher/mapper need not compute it). Most records produce
   * exactly one event; an order may produce several.
   */
  readonly events: readonly CanonicalEventDraft[];
}

/**
 * A canonical event WITHOUT its event_id yet — the driver derives + stamps the id from the dedup
 * strategy so id derivation lives in exactly one place. Everything else matches CanonicalEvent.
 */
export type CanonicalEventDraft = Omit<CanonicalEvent, 'provenance'> & {
  readonly provenance: Omit<CanonicalEvent['provenance'], 'event_id'>;
};

/** A page of records plus the cursor to resume from, returned by the connector's fetcher. */
export interface ResourcePage {
  readonly records: readonly FetchedRecord[];
  /**
   * The cursor to pass to the NEXT fetchPage call. Null/undefined means "no more pages" — the
   * driver treats that as having reached the floor (window exhausted).
   */
  readonly nextCursor: string | null;
  /**
   * The oldest `occurred_at` seen in THIS page (drives the reachedAt checkpoint + floor check).
   * Omit if the page was empty.
   */
  readonly oldestOccurredAt?: Date;
}

/**
 * The ONLY thing a connector must implement to gain a full resumable backfill: page its own API.
 * Stateless across calls — all state lives in the persisted cursor the driver passes back in.
 */
export interface IResourcePageFetcher {
  /**
   * Fetch the next page of a resource.
   *
   * @param args.resource  the descriptor (carries pageSize, cursorStrategy)
   * @param args.cursor    the resume cursor (null on the first page)
   * @param args.floorAt   the historical floor — the fetcher SHOULD stop returning records older
   *                        than this (the driver also enforces it, but stopping early saves calls)
   * @returns              a page + the next cursor (null nextCursor ends the walk)
   * @throws               on auth/reconnect failures — the driver fails the run and PRESERVES the
   *                       cursor so a later run resumes (it does NOT restart from scratch)
   */
  fetchPage(args: {
    resource: ResourceDescriptor;
    cursor: string | null;
    floorAt: Date;
  }): Promise<ResourcePage>;
}

/** Why a backfill run yielded control (so a scheduler knows whether to re-queue it). */
export type BackfillStopReason =
  | 'completed' // reached the floor / no more pages
  | 'paused' // hit the per-run chunk budget — resumable next interval
  | 'failed'; // auth/reconnect error — cursor preserved for manual resume

export interface BackfillRunResult {
  readonly stopReason: BackfillStopReason;
  readonly state: ResourceBackfillState;
  /** Records emitted in THIS run (not lifetime). */
  readonly recordsThisRun: number;
  /** Events that exhausted retries and were spooled to the DLQ this run (not lost). */
  readonly spooledToDlq: number;
}

/**
 * runResumableBackfill — the reference resumable, chunked backfill driver.
 *
 * Walks `resource` from its anchor back toward the platform-clamped floor, one page per chunk,
 * checkpointing after EACH page. Stops when it reaches the floor (completed), runs out of its
 * per-run chunk budget (paused — resumable later), or hits an auth error (failed — cursor kept).
 *
 * Idempotency + no-loss + dedup are all guaranteed here:
 *   - each record's event_id is derived deterministically (Dedup) → replays are dropped by Bronze,
 *   - each event is delivered with bounded retry + DLQ spool (NoLoss) → never silently dropped,
 *   - the cursor + reachedAt are persisted after every chunk → exact resume, crash-safe.
 *
 * @param maxChunksThisRun  the per-run chunk (page) budget — lets a backfill run in bounded
 *                          intervals (e.g. a cron slice of N pages, then pause). Default Infinity
 *                          (run to completion in one shot, the legacy Shopify behaviour).
 */
export async function runResumableBackfill(args: {
  brandId: string;
  connectorInstanceId: string;
  provider: string;
  resource: ResourceDescriptor;
  fetcher: IResourcePageFetcher;
  sink: IEventSink;
  dlq: IDeadLetterSink;
  stateRepo: IResourceBackfillStateRepository;
  /** "now" anchor; injectable for tests. Only used when seeding a brand-new state. */
  anchor?: Date;
  /** Caller-requested window; clamped to the resource's platform max. Omit to use the platform max. */
  requestedWindowMs?: number;
  maxChunksThisRun?: number;
  dedup?: IDedupKeyDeriver;
  retryPolicy?: RetryPolicy;
  idFactory?: () => string;
}): Promise<BackfillRunResult> {
  const {
    brandId,
    connectorInstanceId,
    provider,
    resource,
    fetcher,
    sink,
    dlq,
    stateRepo,
  } = args;
  const anchor = args.anchor ?? new Date();
  const dedup = args.dedup ?? deterministicDedupKeyDeriver;
  const retryPolicy = args.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const maxChunks = args.maxChunksThisRun ?? Number.POSITIVE_INFINITY;
  const idFactory = args.idFactory ?? defaultId;

  if (!resource.backfillSupported) {
    throw new Error(`[Backfill] resource "${provider}/${resource.name}" does not support backfill`);
  }

  // ── Load or seed the resumable state (resume from the persisted cursor) ──────────────────────
  let state =
    (await stateRepo.findByResource(brandId, connectorInstanceId, resource.name)) ??
    ResourceBackfillState.create({
      id: idFactory(),
      brandId,
      connectorInstanceId,
      resource: resource.name,
      status: 'queued',
      anchorAt: anchor,
      floorAt: resolveBackfillFloor(resource, anchor, args.requestedWindowMs),
      cursor: null,
      reachedAt: null,
      recordsProcessed: 0,
      failureReason: null,
      updatedAt: anchor,
    });

  // Already done → no-op (idempotent re-trigger).
  if (state.status === 'completed') {
    return { stopReason: 'completed', state, recordsThisRun: 0, spooledToDlq: 0 };
  }

  state = state.start();
  await stateRepo.upsert(state);

  let recordsThisRun = 0;
  let spooledThisRun = 0;
  let chunks = 0;

  while (chunks < maxChunks) {
    let page: ResourcePage;
    try {
      page = await fetcher.fetchPage({ resource, cursor: state.cursor, floorAt: state.floorAt });
    } catch (err) {
      // Auth/reconnect/page error → fail but PRESERVE cursor for a later resume.
      state = state.fail(String(err).slice(0, 500));
      await stateRepo.upsert(state);
      return { stopReason: 'failed', state, recordsThisRun, spooledToDlq: spooledThisRun };
    }

    // Emit every event of every record with deterministic id + no-loss delivery.
    for (const record of page.records) {
      for (const draft of record.events) {
        const eventId = dedup.deriveEventId({
          brandId,
          provider,
          resource,
          providerId: record.providerId,
          eventName: draft.event_name,
          compositeValues: record.compositeValues,
        });
        const event: CanonicalEvent = {
          ...draft,
          provenance: { ...draft.provenance, event_id: eventId },
        };
        const outcome = await deliverWithNoLoss({
          event,
          resource: resource.name,
          sink,
          dlq,
          policy: retryPolicy,
        });
        recordsThisRun += 1;
        if (outcome.spooledToDlq) spooledThisRun += 1;
      }
    }

    chunks += 1;

    // ── Checkpoint AFTER the chunk (pause/resume/crash-safe boundary) ──────────────────────────
    const reached = page.oldestOccurredAt ?? state.reachedAt ?? state.anchorAt;
    const processedDelta = page.records.reduce((n, r) => n + r.events.length, 0);
    const nextCursor = page.nextCursor;

    if (nextCursor === null) {
      // No more pages → window exhausted → completed.
      state = state
        .checkpoint({ cursor: state.cursor ?? '', reachedAt: reached, processedDelta })
        .complete();
      await stateRepo.upsert(state);
      return { stopReason: 'completed', state, recordsThisRun, spooledToDlq: spooledThisRun };
    }

    state = state.checkpoint({ cursor: nextCursor, reachedAt: reached, processedDelta });
    await stateRepo.upsert(state);

    if (state.hasReachedFloor) {
      state = state.complete();
      await stateRepo.upsert(state);
      return { stopReason: 'completed', state, recordsThisRun, spooledToDlq: spooledThisRun };
    }
  }

  // Hit the per-run chunk budget → pause (resumable next interval).
  state = state.pause();
  await stateRepo.upsert(state);
  return { stopReason: 'paused', state, recordsThisRun, spooledToDlq: spooledThisRun };
}

/** Default id factory — UUID-shaped via crypto.randomUUID where available. */
function defaultId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Deterministic-enough fallback for non-crypto runtimes (tests inject their own).
  return `rbf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
