/**
 * IngestionManifest — the declarative, connector-agnostic description of EVERYTHING a connector
 * can pull from its upstream platform.
 *
 * WHY this exists (the foundation gap):
 *   Today each connector pulls exactly ONE resource (Shopify=orders, ad connectors=spend,
 *   pixel=sessions) and only Shopify implements a real historical backfill. There is no single
 *   place that declares, per connector, the full surface area the platform offers — all REST
 *   resources, all webhook/event topics, all stream subjects — together with the rules each one
 *   ingests under (does it backfill? how far back? how is it paged? how is a record deduped?).
 *
 *   The IngestionManifest is that single source of truth. A connector DECLARES its manifest once;
 *   the generic backfill driver, the repull scheduler, the webhook router, and the dedup layer all
 *   READ from it. Adding a new resource to an existing connector becomes a data change (one more
 *   ResourceDescriptor), not new bespoke job code. Adding a whole connector becomes "write one
 *   manifest + implement the page-fetcher interface", never a fork of the lifecycle.
 *
 *   This is the Single-Primitive Rule applied to ingestion breadth: ONE manifest shape, every
 *   connector conforms to it, and the platform target ("pull EVERYTHING, up to the max historical
 *   window the platform allows, resumably, with strict dedup, zero loss") is expressed as data the
 *   framework enforces rather than per-connector prose.
 */

/**
 * How a resource arrives from upstream.
 *   - 'rest'    : pulled by the connector polling a paged REST/GraphQL endpoint (backfill + repull).
 *   - 'webhook' : pushed by the platform as an inbound HTTP delivery (real-time; no backfill — the
 *                 historical equivalent is the matching 'rest' resource).
 *   - 'stream'  : delivered over a long-lived subscription/stream (e.g. a websocket / pub-sub feed).
 */
export type ResourceKind = 'rest' | 'webhook' | 'stream';

/**
 * The cursor advancement strategy a 'rest' resource pages with. The generic backfill driver uses
 * this to know how to checkpoint and resume a window. (Webhook/stream resources have no cursor.)
 *
 *   - 'since_id'        : monotonic id high-watermark (e.g. Shopify since_id pagination).
 *   - 'updated_at'      : timestamp high-watermark (re-pull anything updated after the watermark).
 *   - 'page_token'      : opaque continuation token returned by the platform (e.g. GA4, Meta).
 *   - 'page_number'     : 1-based page index (classic offset paging).
 *   - 'date_window'     : the resource is fetched one bounded date-range chunk at a time
 *                         (e.g. ad spend is queried day-by-day); the cursor is the next window edge.
 */
export type CursorStrategy =
  | 'since_id'
  | 'updated_at'
  | 'page_token'
  | 'page_number'
  | 'date_window';

/**
 * How a single raw record from this resource is reduced to a STABLE dedup identity. The Dedup
 * contract (see Dedup.ts) turns this into a deterministic event_id so Bronze can drop replays.
 *
 *   - 'provider_id'      : the upstream record's own immutable id is the identity (most resources).
 *   - 'provider_id+kind' : id alone is not unique across event kinds, so the event_name is folded
 *                          in (e.g. one order id emits both order.placed and order.fulfilled).
 *   - 'composite'        : the identity is a connector-defined tuple of fields (declared in
 *                          `dedupKeyFields`); used when no single upstream id exists.
 */
export type DedupKeyStrategy = 'provider_id' | 'provider_id+kind' | 'composite';

/**
 * A single ingestible resource/topic a connector exposes. This is the atomic unit of the manifest:
 * one entry per (REST resource | webhook topic | stream subject).
 */
export interface ResourceDescriptor {
  /**
   * Stable resource key, unique within the connector. This is the SAME string used as the
   * `resource` column on connector_cursor and the per-resource backfill registry, so it must be
   * durable — renaming it orphans cursors. e.g. 'orders', 'products', 'customers', 'refunds',
   * 'order.fulfilled.webhook', 'spend.daily'.
   */
  readonly name: string;

  /** How this resource arrives upstream. */
  readonly kind: ResourceKind;

  /**
   * The canonical Brain event_name(s) this resource produces (for documentation + routing). A
   * single REST resource may fan out into several canonical events (an order → order.placed +
   * line items); list all it can emit.
   */
  readonly emits: readonly string[];

  /**
   * Whether this resource supports historical backfill. Only meaningful for 'rest' resources;
   * 'webhook'/'stream' resources are real-time-only (their history is the paired 'rest' resource).
   */
  readonly backfillSupported: boolean;

  /**
   * The maximum historical window the PLATFORM allows for this resource, in milliseconds. The
   * framework clamps a requested backfill to `min(requested, maxBackfillWindowMs)`. Use
   * UNBOUNDED_BACKFILL_WINDOW_MS when the platform imposes no limit (pull from the beginning).
   *
   * Brain's default target is TWO_YEARS_MS, but a platform that only retains 13 months declares
   * its real limit here so the framework never silently claims depth it cannot reach.
   */
  readonly maxBackfillWindowMs: number;

  /**
   * The cursor advancement strategy for paging this resource during backfill/repull. Required for
   * 'rest' resources; omit for 'webhook'/'stream'.
   */
  readonly cursorStrategy?: CursorStrategy;

  /** The dedup identity strategy for records of this resource (drives deterministic event_id). */
  readonly dedupKeyStrategy: DedupKeyStrategy;

  /**
   * When `dedupKeyStrategy === 'composite'`, the ordered list of record field paths whose values
   * compose the dedup identity. Ignored for the other strategies.
   */
  readonly dedupKeyFields?: readonly string[];

  /**
   * Suggested page size for backfill/repull paging (records per page). The driver passes this to
   * the connector's page-fetcher; the connector may cap it to the platform maximum.
   */
  readonly pageSize?: number;

  /**
   * Optional human description for catalog/diagnostics surfaces. Not load-bearing.
   */
  readonly description?: string;
}

/**
 * A connector's complete ingestion manifest: the provider id plus every resource it can ingest.
 * Declared once per connector and consumed by the whole framework.
 */
export interface IngestionManifest {
  /** Provider id — matches CONNECTOR_CATALOG + the IConnector.provider + ConnectorFactory key. */
  readonly provider: string;

  /** Every resource/topic this connector can pull. */
  readonly resources: readonly ResourceDescriptor[];
}

/** Two years in milliseconds — Brain's default historical backfill target. */
export const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Sentinel for "the platform imposes no historical limit — pull from the beginning of time".
 * Chosen as a very large finite value (not Infinity) so it survives JSON/DB round-trips and
 * arithmetic (Date math) without producing NaN.
 */
export const UNBOUNDED_BACKFILL_WINDOW_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Resolve the effective historical floor (the oldest `occurred_at` a backfill should reach) for a
 * resource, given the moment the backfill is anchored at and an optionally-requested window.
 *
 * The effective window is the SMALLEST of:
 *   - the caller's requested window (if any), and
 *   - the resource's platform-imposed `maxBackfillWindowMs`.
 *
 * This is the single place the "up to 2 years, or the max the platform allows" rule is computed,
 * so no connector can accidentally claim more depth than the platform can serve.
 *
 * @param resource     the resource being backfilled
 * @param anchor       the instant the backfill is anchored at (typically "now")
 * @param requestedWindowMs  optional caller-requested window; omit to use the platform max
 * @returns            the historical floor Date — records older than this are out of scope
 */
export function resolveBackfillFloor(
  resource: ResourceDescriptor,
  anchor: Date,
  requestedWindowMs?: number,
): Date {
  const platformMax = resource.maxBackfillWindowMs;
  const effective =
    requestedWindowMs === undefined ? platformMax : Math.min(requestedWindowMs, platformMax);
  return new Date(anchor.getTime() - effective);
}

/**
 * Look up a resource descriptor by name, or throw if the connector does not declare it. Used by
 * the backfill driver + webhook router to fail loudly on a typo rather than silently no-op.
 */
export function getResource(
  manifest: IngestionManifest,
  resourceName: string,
): ResourceDescriptor {
  const found = manifest.resources.find((r) => r.name === resourceName);
  if (!found) {
    throw new Error(
      `[IngestionManifest] provider "${manifest.provider}" declares no resource "${resourceName}". ` +
        `Declared: [${manifest.resources.map((r) => r.name).join(', ')}]`,
    );
  }
  return found;
}

/** All resources of a manifest that support historical backfill (the driver's work list). */
export function backfillableResources(
  manifest: IngestionManifest,
): readonly ResourceDescriptor[] {
  return manifest.resources.filter((r) => r.backfillSupported && r.kind === 'rest');
}

/**
 * Validate a manifest's internal consistency at registration time (fail-fast at startup, never at
 * ingest time). Throws on the first violation found.
 *
 * Rules enforced:
 *   - resource names are non-empty and unique within the connector,
 *   - 'rest' resources that declare backfillSupported MUST declare a cursorStrategy,
 *   - 'composite' dedup resources MUST declare a non-empty dedupKeyFields,
 *   - maxBackfillWindowMs is a positive finite number.
 */
export function assertManifestValid(manifest: IngestionManifest): void {
  if (!manifest.provider) {
    throw new Error('[IngestionManifest] provider id is required');
  }
  const seen = new Set<string>();
  for (const r of manifest.resources) {
    if (!r.name) {
      throw new Error(`[IngestionManifest] provider "${manifest.provider}" has a resource with an empty name`);
    }
    if (seen.has(r.name)) {
      throw new Error(
        `[IngestionManifest] provider "${manifest.provider}" declares duplicate resource "${r.name}"`,
      );
    }
    seen.add(r.name);

    if (!Number.isFinite(r.maxBackfillWindowMs) || r.maxBackfillWindowMs <= 0) {
      throw new Error(
        `[IngestionManifest] resource "${manifest.provider}/${r.name}" has invalid maxBackfillWindowMs`,
      );
    }
    if (r.kind === 'rest' && r.backfillSupported && !r.cursorStrategy) {
      throw new Error(
        `[IngestionManifest] backfillable REST resource "${manifest.provider}/${r.name}" must declare a cursorStrategy`,
      );
    }
    if (r.dedupKeyStrategy === 'composite' && (!r.dedupKeyFields || r.dedupKeyFields.length === 0)) {
      throw new Error(
        `[IngestionManifest] resource "${manifest.provider}/${r.name}" uses composite dedup but declares no dedupKeyFields`,
      );
    }
  }
}
