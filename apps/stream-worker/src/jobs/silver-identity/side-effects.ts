/**
 * silver-identity/side-effects.ts — apply the post-resolve side effects the removed streaming
 * consumers used to derive from the identity.* Kafka lane (ADR-0015 WS3), DIRECTLY and in-process:
 *
 *   was IdentityChangeRecomputeConsumer  → merged ⇒ ops.scoped_recompute_request upsert
 *   was RestitchDirtyConsumer            → minted/linked/merged ⇒ ops.restitch_pending
 *                                          (per-brand `stitch.v2` flag, DEFAULT OFF — unchanged)
 *   was JourneyReversionDirtyConsumer    → linked/merged ⇒ ops.journey_reversion_pending
 *                                          (per-brand `journey.engine` flag, DEFAULT OFF — unchanged)
 *   was TouchpointCacheConsumer (merge)  → merged ⇒ tp-cache union+delete (flag identity.tp_cache)
 *   was AnalyticsCacheInvalidateConsumer → merged ⇒ brand marked for direct serving-cache eviction
 *                                          (the caller evicts once per dirty brand after the batch)
 *
 * The event SHAPES are still built by the PRESERVED domain mapper (buildIdentityEvents) and the
 * PRESERVED pure dirty-set mappers (RestitchDirty / JourneyReversionDirty / ScopedRecompute) —
 * invocation moved, logic unchanged. event_id provenance uses the SAME deterministicEventId scheme
 * the removed Kafka publisher stamped, so replays upsert identical rows (idempotent).
 *
 * Also primes the `identifier_hash → brain_id` Redis cache (IdentifierCacheAdapter) with every
 * deterministic identifier of a committed outcome, so only first-seen identifiers hit Neo4j.
 *
 * PII: hash-only throughout (I-S02); brand_id first on every row (I-S01). No money.
 */
import type {
  IdentityMintedEvent,
  IdentityLinkedEvent,
  IdentityMergedEvent,
} from '@brain/contracts';
import type { BatchOutcomeItem } from '../../domain/identity/IdentityStore.js';
import {
  buildIdentityEvents,
  deterministicEventId,
  type PreparedIdentityEvent,
} from '../../domain/identity/IdentityEventPublisher.js';
import {
  mintedToDirty,
  linkedToDirty,
  mergedToDirty,
  type RestitchDirtyEntry,
  type IRestitchDirtyRepository,
} from '../../domain/identity/RestitchDirty.js';
import {
  linkedToJourneyDirty,
  mergedToJourneyDirty,
  type JourneyDirtyEntry,
  type IJourneyReversionDirtyRepository,
} from '../../domain/journey/JourneyReversionDirty.js';
import {
  mapIdentityEventToScopedRecompute,
  type IScopedRecomputeRepository,
} from '../../domain/identity/ScopedRecompute.js';
import { log } from '../../log.js';

/** Per-brand flag gate port — the shared @brain/platform-flags FlagService is structurally assignable. */
export interface ISideEffectFlagGate {
  isFlagEnabled(brandId: string, flag: string): Promise<boolean>;
}

/** The tp-cache merge-invalidation seam (TouchpointCacheService.handleIdentityMerged, Buffer-shaped). */
export interface ITouchpointMergeInvalidator {
  handleIdentityMerged(rawValue: Buffer | null): Promise<unknown>;
}

/** Identifier-cache prime port (IdentifierCacheAdapter.primeMany). */
export interface IIdentifierCachePrimer {
  primeMany(
    brandId: string,
    entries: Array<{ type: string; hash: string; brainId: string }>,
  ): Promise<void>;
}

export interface SideEffectDeps {
  flags: ISideEffectFlagGate;
  scopedRecomputeRepo: IScopedRecomputeRepository;
  restitchRepo: IRestitchDirtyRepository;
  journeyReversionRepo: IJourneyReversionDirtyRepository;
  identifierCache: IIdentifierCachePrimer;
  /** Optional (flag-gated internally): the tp-cache merge invalidation. */
  tpMergeInvalidator?: ITouchpointMergeInvalidator;
  /** ISO-8601 now for the ScopedRecompute requested_at stamp. */
  now: string;
}

export interface SideEffectCounts {
  identityEvents: number;
  scopedRecomputes: number;
  restitchKeys: number;
  journeyReversionKeys: number;
  tpMergeInvalidations: number;
  cachePrimedIdentifiers: number;
}

/** Flags — same names + DEFAULT-OFF gating the removed consumers enforced. */
const STITCH_V2_FLAG = 'stitch.v2';
const JOURNEY_ENGINE_FLAG = 'journey.engine';

/**
 * Apply every direct side effect for ONE brand's committed batch outcomes. Returns the counts and
 * whether the brand's serving cache is dirty (a merge occurred → the caller evicts `${brand}:*`).
 * Dirty-set writes are batched into single UNNEST upserts (idempotent PK upserts — replay-safe).
 */
export async function applyResolveSideEffects(
  brandId: string,
  items: BatchOutcomeItem[],
  deps: SideEffectDeps,
): Promise<{ counts: SideEffectCounts; servingCacheDirty: boolean }> {
  const counts: SideEffectCounts = {
    identityEvents: 0,
    scopedRecomputes: 0,
    restitchKeys: 0,
    journeyReversionKeys: 0,
    tpMergeInvalidations: 0,
    cachePrimedIdentifiers: 0,
  };
  let servingCacheDirty = false;

  // Per-brand flag reads once per batch (the consumers read per message; same fail-closed default).
  const [stitchOn, journeyOn] = await Promise.all([
    deps.flags.isFlagEnabled(brandId, STITCH_V2_FLAG),
    deps.flags.isFlagEnabled(brandId, JOURNEY_ENGINE_FLAG),
  ]);

  const restitchEntries: RestitchDirtyEntry[] = [];
  const journeyEntries: JourneyDirtyEntry[] = [];
  const cacheEntries: Array<{ type: string; hash: string; brainId: string }> = [];

  for (const item of items) {
    // Prime the identifier cache with every DETERMINISTIC identifier of the committed outcome —
    // weak signals are never deterministic resolution keys, so they are never cached.
    if (item.outcome.brainId) {
      for (const id of item.identifiers) {
        if (id.tier === 'weak') continue;
        cacheEntries.push({ type: id.type, hash: id.hash, brainId: item.outcome.brainId });
      }
    }

    const events: PreparedIdentityEvent[] = buildIdentityEvents(
      brandId,
      item.outcome,
      item.identifiers,
    );
    counts.identityEvents += events.length;

    for (const evt of events) {
      const eventId = deterministicEventId(brandId, evt.eventName, evt.dedupeKey);

      switch (evt.eventName) {
        case 'identity.minted': {
          if (stitchOn) {
            const wire = { brand_id: brandId, event_id: eventId, payload: evt.payload } as unknown as IdentityMintedEvent;
            restitchEntries.push(...mintedToDirty(wire));
          }
          break;
        }
        case 'identity.linked': {
          const wire = { brand_id: brandId, event_id: eventId, payload: evt.payload } as unknown as IdentityLinkedEvent;
          if (stitchOn) restitchEntries.push(...linkedToDirty(wire));
          if (journeyOn) journeyEntries.push(...linkedToJourneyDirty(wire));
          break;
        }
        case 'identity.merged': {
          const wire = { brand_id: brandId, event_id: eventId, payload: evt.payload } as unknown as IdentityMergedEvent;
          if (stitchOn) restitchEntries.push(...mergedToDirty(wire));
          if (journeyOn) journeyEntries.push(...mergedToJourneyDirty(wire));

          // Scoped Gold recompute — UNGATED, exactly like the removed recompute consumer.
          const recompute = mapIdentityEventToScopedRecompute(
            {
              event_name: 'identity.merged',
              event_id: eventId,
              brand_id: brandId,
              payload: {
                canonical_brain_id: evt.payload.canonical_brain_id,
                merged_brain_id: evt.payload.merged_brain_id,
              },
            },
            deps.now,
          );
          await deps.scopedRecomputeRepo.upsert(recompute);
          counts.scopedRecomputes += 1;
          servingCacheDirty = true;

          // tp-cache merge invalidation (flag identity.tp_cache checked inside the service).
          if (deps.tpMergeInvalidator) {
            try {
              await deps.tpMergeInvalidator.handleIdentityMerged(
                Buffer.from(JSON.stringify({ brand_id: brandId, payload: evt.payload })),
              );
              counts.tpMergeInvalidations += 1;
            } catch (err) {
              // Best-effort hot cache — Iceberg is truth (same fail-safe the consumer had).
              log.warn('[silver-identity] tp-cache merge invalidation failed (fail-safe)', {
                brand_id: brandId, err,
              });
            }
          }
          break;
        }
        // identity.review_queued / identity.suppressed carried no dirty-set/recompute side effects
        // on the streaming path (review is human-gated; suppressed had no live producer).
        default:
          break;
      }
    }
  }

  if (restitchEntries.length > 0) {
    await deps.restitchRepo.markDirty(restitchEntries);
    counts.restitchKeys = restitchEntries.length;
  }
  if (journeyEntries.length > 0) {
    await deps.journeyReversionRepo.markDirty(journeyEntries);
    counts.journeyReversionKeys = journeyEntries.length;
  }
  if (cacheEntries.length > 0) {
    await deps.identifierCache.primeMany(brandId, cacheEntries);
    counts.cachePrimedIdentifiers = cacheEntries.length;
  }

  return { counts, servingCacheDirty };
}
