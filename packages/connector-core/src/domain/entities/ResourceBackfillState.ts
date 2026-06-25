/**
 * ResourceBackfillState — provider-agnostic domain entity for the position of a RESUMABLE,
 * CHUNKED, PER-RESOURCE historical backfill.
 *
 * WHY a new entity (vs the existing backfill_job / connector_cursor):
 *   - backfill_job tracks at most ONE active job per connector_instance (its active-lock partial
 *     index is keyed on connector_instance_id alone) and carries no `resource` column. It cannot
 *     represent "orders is 80% backfilled AND customers is 30% backfilled" concurrently.
 *   - connector_cursor tracks the LIVE/repull watermark per resource, not the historical
 *     backfill frontier — overloading it would conflate "how far back have we reached" with
 *     "what's the newest record we've seen".
 *
 *   ResourceBackfillState is the missing third thing: for each (brand, connector_instance,
 *   resource) it records the historical floor the backfill is targeting, the chunk cursor it has
 *   checkpointed (so a paused/crashed run RESUMES exactly where it left off), and a resumable
 *   status. The (brandId, connectorInstanceId, resource) triple is the upsert key (I-ST04) — the
 *   SAME triple connector_cursor uses, so the two line up per resource.
 *
 * Resumability model:
 *   A backfill walks a window from `anchorAt` back to `floorAt`, one chunk at a time. After each
 *   chunk the driver calls `checkpoint(cursor, reachedAt, processedDelta)` which advances the
 *   cursor and the deepest `reachedAt`. Because the cursor + reachedAt are persisted after every
 *   chunk, the run can be paused at any boundary and resumed in a later interval — or recovered
 *   after a crash — with zero re-emission risk (re-emitting a chunk is harmless: dedup drops it).
 */

/**
 * Resumable status of a per-resource backfill.
 *   - 'queued'    : registered, not yet started.
 *   - 'running'   : a worker holds it and is walking chunks.
 *   - 'paused'    : checkpointed mid-window on purpose (interval scheduling) — resumable.
 *   - 'completed' : reached the historical floor; no more chunks.
 *   - 'failed'    : unrecoverable (auth/reconnect); cursor preserved for a manual resume.
 */
export type ResourceBackfillStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export interface ResourceBackfillStateProps {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  /** Resource key — matches a ResourceDescriptor.name and the connector_cursor.resource. */
  readonly resource: string;
  readonly status: ResourceBackfillStatus;
  /** The instant the window is anchored at (typically backfill start "now"). */
  readonly anchorAt: Date;
  /** The historical floor the backfill targets (anchorAt − effective window). */
  readonly floorAt: Date;
  /**
   * The opaque chunk cursor checkpointed after the last completed chunk (the next chunk resumes
   * from here). Null = not started. Its meaning is the resource's CursorStrategy (since_id /
   * page_token / date-window edge / ...).
   */
  readonly cursor: string | null;
  /**
   * The oldest `occurred_at` actually reached so far (progress toward floorAt). Null = no chunk
   * completed yet. When reachedAt <= floorAt the backfill is complete.
   */
  readonly reachedAt: Date | null;
  /** Running count of records emitted across all chunks (monotonic). */
  readonly recordsProcessed: number;
  /** Truncated last-failure reason (never a token — I-S09). Null unless status='failed'. */
  readonly failureReason: string | null;
  readonly updatedAt: Date;
}

export class ResourceBackfillState {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  readonly resource: string;
  readonly status: ResourceBackfillStatus;
  readonly anchorAt: Date;
  readonly floorAt: Date;
  readonly cursor: string | null;
  readonly reachedAt: Date | null;
  readonly recordsProcessed: number;
  readonly failureReason: string | null;
  readonly updatedAt: Date;

  private constructor(props: ResourceBackfillStateProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.connectorInstanceId = props.connectorInstanceId;
    this.resource = props.resource;
    this.status = props.status;
    this.anchorAt = props.anchorAt;
    this.floorAt = props.floorAt;
    this.cursor = props.cursor;
    this.reachedAt = props.reachedAt;
    this.recordsProcessed = props.recordsProcessed;
    this.failureReason = props.failureReason;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ResourceBackfillStateProps): ResourceBackfillState {
    if (props.floorAt.getTime() > props.anchorAt.getTime()) {
      throw new Error('[ResourceBackfillState] floorAt must be <= anchorAt (window is anchor→floor backwards)');
    }
    if (props.recordsProcessed < 0) {
      throw new Error('[ResourceBackfillState] recordsProcessed must be >= 0');
    }
    return new ResourceBackfillState(props);
  }

  /** True once the deepest reached point has crossed the historical floor. */
  get hasReachedFloor(): boolean {
    return this.reachedAt !== null && this.reachedAt.getTime() <= this.floorAt.getTime();
  }

  /** True if the backfill can still do more work (not terminal). */
  get isResumable(): boolean {
    return this.status === 'queued' || this.status === 'running' || this.status === 'paused';
  }

  /** Transition queued/paused → running (a worker has claimed it). */
  start(): ResourceBackfillState {
    return this.withProps({ status: 'running' });
  }

  /**
   * Checkpoint progress after one chunk: advance the cursor, deepen reachedAt (monotonic — never
   * moves forward in time), and add to the processed count. Stays 'running' (caller decides to
   * pause/complete via the dedicated transitions).
   */
  checkpoint(args: {
    cursor: string;
    reachedAt: Date;
    processedDelta: number;
  }): ResourceBackfillState {
    if (args.processedDelta < 0) {
      throw new Error('[ResourceBackfillState] processedDelta must be >= 0');
    }
    const deepestReached =
      this.reachedAt === null || args.reachedAt.getTime() < this.reachedAt.getTime()
        ? args.reachedAt
        : this.reachedAt;
    return this.withProps({
      status: 'running',
      cursor: args.cursor,
      reachedAt: deepestReached,
      recordsProcessed: this.recordsProcessed + args.processedDelta,
    });
  }

  /** Pause at the current checkpoint (resumable in a later interval). */
  pause(): ResourceBackfillState {
    return this.withProps({ status: 'paused' });
  }

  /** Mark complete (the floor was reached). */
  complete(): ResourceBackfillState {
    return this.withProps({ status: 'completed', failureReason: null });
  }

  /** Mark failed but PRESERVE the cursor so a later run resumes rather than restarts. */
  fail(reason: string): ResourceBackfillState {
    return this.withProps({ status: 'failed', failureReason: reason.slice(0, 500) });
  }

  toProps(): ResourceBackfillStateProps {
    return {
      id: this.id,
      brandId: this.brandId,
      connectorInstanceId: this.connectorInstanceId,
      resource: this.resource,
      status: this.status,
      anchorAt: this.anchorAt,
      floorAt: this.floorAt,
      cursor: this.cursor,
      reachedAt: this.reachedAt,
      recordsProcessed: this.recordsProcessed,
      failureReason: this.failureReason,
      updatedAt: this.updatedAt,
    };
  }

  private withProps(patch: Partial<ResourceBackfillStateProps>): ResourceBackfillState {
    return new ResourceBackfillState({
      ...this.toProps(),
      ...patch,
      updatedAt: new Date(),
    });
  }
}
