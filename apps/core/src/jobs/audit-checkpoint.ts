/**
 * audit-checkpoint — the hourly WORM anchor for the audit hash-chain (R-19 / compliance).
 *
 * Reads the audit_log chain HEAD (max id + its entry_hash + row count), seals it together with
 * the prior checkpoint's hash (buildAuditCheckpoint — PURE, in @brain/audit), and writes the
 * record to the S3 Object-Lock COMPLIANCE bucket. That bucket's default retention WORMs every
 * PutObject, so not even root can alter or delete a checkpoint. A later chain-walk that disagrees
 * with any immutable checkpoint is proof an attacker rewrote Postgres audit history.
 *
 * ENV-GATED (mirrors OTLP/Sentry): with AUDIT_CHECKPOINT_BUCKET unset (dev), the job logs and
 * exits 0 — no AWS dependency is loaded and nothing breaks. In prod the bucket + the brain-jobs
 * IRSA role (s3-audit terraform) are present and the checkpoint is written.
 *
 * Invoked by the core image's job entrypoint (CLI): `node dist/jobs/audit-checkpoint.js`.
 * Idempotent enough: each run writes a unique timestamped key; a missed/retried run is harmless.
 */
import pg from 'pg';
import { createLogger } from '@brain/observability';
import { buildAuditCheckpoint, type AuditChainHead, type AuditCheckpoint } from '@brain/audit';

const log = createLogger({ serviceName: 'job:audit-checkpoint' });

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const CHECKPOINT_PREFIX = 'checkpoints/';

/**
 * The WORM sink: read the most recent checkpoint's hash (to chain) and put a new checkpoint.
 * Abstracted so the orchestration is unit-testable with a fake; the S3 impl is below.
 */
export interface CheckpointSink {
  /** The prior checkpoint's checkpointHash (newest key under the prefix), or null if none. */
  readLatestHash(): Promise<string | null>;
  /** Write a checkpoint at `key` with its JSON body (the bucket WORMs it by default retention). */
  put(key: string, body: string): Promise<void>;
}

export interface AuditCheckpointResult {
  written: boolean;
  reason?: string;
  checkpoint?: AuditCheckpoint;
}

/** Read the audit chain HEAD (max id + entry_hash + total count) — BIGINT-safe as strings.
 *
 * The hash-chain is GLOBAL (one chain across all brands), but audit.audit_log now FORCEs RLS
 * (migration 0067) scoped to the per-request brand. This job connects as brain_app, so it claims
 * the privileged read-all escape via `SET app.role = 'audit_reader'` (the established GUC pattern,
 * contact_pii/0017) on a dedicated session — without it, RLS would scope these reads to a (here
 * unset) brand and the WORM anchor would silently see an empty chain. */
async function readAuditHead(pool: pg.Pool): Promise<AuditChainHead> {
  const client = await pool.connect();
  try {
    // Session-scoped (the connection is released right after) — grants the cross-brand chain walk.
    await client.query(`SET app.role = 'audit_reader'`);
    const headRes = await client.query<{ id: string; entry_hash: string }>(
      `SELECT id::text AS id, entry_hash FROM audit_log ORDER BY id DESC LIMIT 1`,
    );
    const countRes = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`);
    const head = headRes.rows[0];
    return {
      headId: head?.id ?? '0',
      headEntryHash: head?.entry_hash ?? null,
      rowCount: countRes.rows[0]?.n ?? '0',
    };
  } finally {
    // Best-effort GUC reset before release — the session is released immediately after, so a
    // failure here is harmless. Log at debug rather than swallow silently. // intentional
    await client
      .query(`RESET app.role`)
      .catch((err) => log.debug('audit-checkpoint: RESET app.role failed (session released)', { err }));
    client.release();
  }
}

/**
 * Core orchestration (PURE of AWS): read head → chain prior → seal → put. Takes the sink + a
 * `now` ISO string so it's deterministic under test. Returns what was written.
 */
export async function writeAuditCheckpoint(
  pool: pg.Pool,
  sink: CheckpointSink,
  nowIso: string,
): Promise<AuditCheckpointResult> {
  const head = await readAuditHead(pool);
  // Inter-checkpoint chaining is defense-in-depth; the head anchor is the critical write. If the
  // prior-hash read fails (e.g. the audit IAM role grants PutObject but not List/Get), DON'T fail
  // the WORM write — log and anchor without the back-link.
  let prevHash: string | null = null;
  try {
    prevHash = await sink.readLatestHash();
  } catch (err) {
    log.warn('could not read prior checkpoint — anchoring without back-link', { err });
  }
  const checkpoint = buildAuditCheckpoint(head, prevHash, nowIso);
  // Timestamped, unique, lexicographically-sortable key → "newest" = latest checkpoint.
  const key = `${CHECKPOINT_PREFIX}${nowIso.replace(/[:.]/g, '-')}-${checkpoint.headId}.json`;
  await sink.put(key, JSON.stringify(checkpoint, null, 2));
  log.info('audit checkpoint written', {
    key,
    head_id: checkpoint.headId,
    row_count: checkpoint.rowCount,
    chained: prevHash !== null,
  });
  return { written: true, checkpoint };
}

/** S3 Object-Lock sink — lazy-imports @aws-sdk/client-s3 (only when a bucket is configured). */
function createS3CheckpointSink(bucket: string, region?: string): CheckpointSink {
  return {
    async readLatestHash(): Promise<string | null> {
      const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client(region ? { region } : {});
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: CHECKPOINT_PREFIX }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string')
        .sort();
      const latest = keys[keys.length - 1];
      if (!latest) return null;
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest }));
      const body = await got.Body?.transformToString();
      if (!body) return null;
      return (JSON.parse(body) as AuditCheckpoint).checkpointHash ?? null;
    },
    async put(key: string, body: string): Promise<void> {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client(region ? { region } : {});
      // No explicit Object-Lock headers needed: the bucket's default retention (COMPLIANCE, 7y)
      // WORMs every object at write. ContentType for readability in the console.
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }),
      );
    },
  };
}

export async function runAuditCheckpoint(deps?: {
  pool?: pg.Pool;
  sink?: CheckpointSink;
  nowIso?: string;
}): Promise<AuditCheckpointResult> {
  const bucket = process.env['AUDIT_CHECKPOINT_BUCKET'];
  if (!deps?.sink && !bucket) {
    log.warn('audit-checkpoint skipped — AUDIT_CHECKPOINT_BUCKET unset (no WORM anchor in dev)');
    return { written: false, reason: 'no_bucket' };
  }

  const pool = deps?.pool ?? new pg.Pool({ connectionString: DB_URL, max: 2 });
  const sink =
    deps?.sink ?? createS3CheckpointSink(bucket as string, process.env['AWS_REGION']);
  const ownsPool = !deps?.pool;
  const nowIso = deps?.nowIso ?? new Date().toISOString();
  try {
    return await writeAuditCheckpoint(pool, sink, nowIso);
  } finally {
    if (ownsPool) await pool.end();
  }
}

// Entry point — only when run directly (not when imported in tests).
if (
  process.argv[1]?.endsWith('audit-checkpoint.ts') ||
  process.argv[1]?.endsWith('audit-checkpoint.js')
) {
  runAuditCheckpoint()
    .then((r) => process.exit(r.written || r.reason === 'no_bucket' ? 0 : 1))
    .catch((err) => {
      log.error('fatal', { err });
      process.exit(1);
    });
}
