/**
 * backfill-identity — OPERATOR-CONTROLLED batch identity MINTING for ONE brand's historical events.
 *
 * THIS IS A CLI / JOB ENTRYPOINT — NOT an agent/MCP tool. It is invoked deliberately by an operator
 * for a specific brand; it must NEVER be registered in any tool/MCP registry.
 *
 * WHY (GAP-A, revenue-critical): the live IdentityBridgeConsumer subscribes to the collector topic with
 * `fromBeginning: false`, so the 2024-2026 CONNECTOR BACKFILL history (order.backfill.v1 /
 * customer.upsert.v1 — landed straight into Bronze/the keystone, long past Kafka retention) was NEVER
 * identity-resolved. No brain_ids were minted for those customers → silver_order_state.brain_id is NULL
 * on ~79% of orders → silver_customer drops them (its fold is `WHERE brain_id IS NOT NULL`). The events
 * themselves carry deterministic STRONG identifiers (hashed_customer_email is a well-formed 64-hex
 * pre-hashed SHA-256; storefront_customer_id is the raw platform id) — they only ever needed to be
 * driven through the SAME resolve path the live stream uses.
 *
 * WHAT IT DOES: reads an NDJSON export of the brand's keystone/Bronze events (one JSON object per line,
 * the same operator artifact shape as replay-identity) and pushes EACH event through the LIVE
 * ResolveIdentityUseCase — the exact extract → normalize/hash (per-brand salt via SaltProvider) →
 * IdentityResolver → Neo4j-write pipeline of IdentityBridgeConsumer. Unlike replay-identity (isolated
 * in-memory shadow graph, read-only), THIS JOB WRITES the live Neo4j identity SoR (ADR-0004).
 *
 * SAFETY MODEL:
 *   - PER-TENANT      — exactly one brand per run; rows for any other brand_id are rejected (counted).
 *   - IDEMPOTENT      — the resolver is deterministic: an identifier already linked resolves to the
 *                       SAME brain_id (outcome linked/skipped, never a duplicate mint). Re-running the
 *                       whole file is safe.
 *   - DETERMINISTIC-ONLY — the confidence/decision (probabilistic review) deps are NOT wired, so the
 *                       use-case runs the deterministic strong-key path only (mint/link/merge on exact
 *                       hashes) — a batch backfill must never enqueue probabilistic review guesses.
 *   - NO DOMAIN EVENTS — the identity.{minted,linked,merged}.v1 publisher is NOT wired (batch mode):
 *                       emitting ~10^5 events would flood the recompute/cache-invalidation consumers
 *                       for no benefit — the operator runbook follows this job with identity-export
 *                       (Neo4j → ops.silver_identity_link, reads the graph directly) and a one-time
 *                       FULL_REFRESH of the downstream marts, which supersedes per-event invalidation.
 *   - DRY-RUN         — `--dry-run` parses + counts identifier-bearing events and exits WITHOUT
 *                       connecting to Neo4j (no write path is even constructed).
 *   - BATCHED (default) — events run through BatchResolveIdentityUseCase: ONE bulk readStateBatch +
 *                       ONE bulk writeOutcomesBatch per --batch-size events (default 500) instead of
 *                       ~7 Neo4j round-trips per event, with per-event-sequential semantics preserved
 *                       by the in-memory overlay (parity-tested: batch == per-event). If a batch
 *                       FAILS, that batch transparently FALLS BACK to the per-event path (writes are
 *                       idempotent — the bulk txn either fully committed or not at all), converging
 *                       on the old per-event error accounting. `--per-event` forces the legacy path.
 *
 * INPUT SHAPE: each NDJSON line must carry top-level `brand_id` + `event_id`, and the event `payload`
 * either inline (full Bronze envelope) or as a JSON STRING (the natural shape of a Trino/serving export
 * of brain_silver.silver_collector_event, whose `payload` column is varchar) — string payloads are
 * parsed here before the resolve call, so the operator export needs no reshaping.
 *
 * Usage:  node dist/jobs/identity/backfill-identity.js <brand_id> <events.ndjson>
 *           [--dry-run] [--per-event] [--batch-size=N]
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { Pool as PgPool } from 'pg';
import { loadStreamWorkerConfig } from '@brain/config';
import {
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  type VaultKeyProvider,
} from '@brain/pii-vault';
import { createSaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { Neo4jIdentityRepository } from '../../infrastructure/neo4j/Neo4jIdentityRepository.js';
import {
  ResolveIdentityUseCase,
  type ResolveOutcomeType,
  type ResolveResult,
} from '../../application/ResolveIdentityUseCase.js';
import {
  BatchResolveIdentityUseCase,
  DEFAULT_IDENTITY_BATCH_SIZE,
} from '../../application/BatchResolveIdentityUseCase.js';
import { log } from '../../log.js';

/** Progress heartbeat cadence (events) — a 10^5-event backfill logs ~every few seconds. */
const PROGRESS_EVERY = 5_000;

export interface BackfillIdentityReport {
  brandId: string;
  /** NDJSON lines read (incl. blank/unparseable/other-brand rows). */
  linesRead: number;
  /** Lines skipped: blank or JSON-unparseable. */
  unparseable: number;
  /** Rows rejected by the tenant guard (brand_id !== the run's brand). */
  otherBrandRejected: number;
  /** Events pushed through the resolver (dry-run: events that WOULD be pushed). */
  attempted: number;
  /** Resolve outcome → count (minted/linked/merged/skipped/no_identifiers/invalid). Empty on dry-run. */
  outcomeCounts: Partial<Record<ResolveOutcomeType, number>>;
  /** Events whose resolve THREW (salt/Neo4j failure) — logged and continued; non-zero exit if > 0. */
  errors: number;
  dryRun: boolean;
  /** 'batch' (default; bulk read/write per batch) or 'per-event' (legacy path via --per-event). */
  mode: 'batch' | 'per-event';
  /** Batches that failed the bulk path and were re-run per-event (idempotent fallback). */
  batchFallbacks: number;
}

/**
 * Normalize one NDJSON row into the Bronze-envelope Buffer ResolveIdentityUseCase.execute expects.
 * Returns null for rows execute() could never act on (missing brand_id/event_id) so the caller can
 * count them without a resolver round-trip. A STRING payload (keystone varchar export) is parsed into
 * an object — execute() reads `parsed.payload.properties.*` and a string would extract nothing.
 */
export function toResolveBuffer(row: Record<string, unknown>): Buffer | null {
  if (typeof row['brand_id'] !== 'string' || typeof row['event_id'] !== 'string') return null;
  const out: Record<string, unknown> = { ...row };
  if (typeof out['payload'] === 'string') {
    try {
      out['payload'] = JSON.parse(out['payload'] as string) as Record<string, unknown>;
    } catch {
      return null; // unparseable payload string — nothing to extract, don't feed the resolver garbage
    }
  }
  return Buffer.from(JSON.stringify(out), 'utf8');
}

export async function runIdentityBackfill(
  brandId: string,
  filePath: string,
  opts: { dryRun?: boolean; perEvent?: boolean; batchSize?: number } = {},
): Promise<BackfillIdentityReport> {
  const cfg = loadStreamWorkerConfig();
  const dbUrl = cfg.BRAIN_APP_DATABASE_URL;
  const dryRun = opts.dryRun === true;
  const perEvent = opts.perEvent === true;
  const batchSize = opts.batchSize ?? DEFAULT_IDENTITY_BATCH_SIZE;

  const report: BackfillIdentityReport = {
    brandId,
    linesRead: 0,
    unparseable: 0,
    otherBrandRejected: 0,
    attempted: 0,
    outcomeCounts: {},
    errors: 0,
    dryRun,
    mode: perEvent ? 'per-event' : 'batch',
    batchFallbacks: 0,
  };

  // Live write path — constructed ONLY on a real run (dry-run never touches Neo4j/PG/KMS).
  // Wiring mirrors the stream-worker composition root (main.ts): same salt resolution, same vault DEK
  // provider selection, same Neo4j SoR repository. Publisher/confidence deps deliberately absent (see
  // module docstring — deterministic-only, no domain-event flood).
  let identityRepo: Neo4jIdentityRepository | null = null;
  let useCase: ResolveIdentityUseCase | null = null;
  let batchUseCase: BatchResolveIdentityUseCase | null = null;
  if (!dryRun) {
    const saltProvider = createSaltProvider(dbUrl);
    // intentional raw: NODE_ENV prod-gating selects the secret/KMS code path (same as main.ts).
    const vaultKeyProvider: VaultKeyProvider =
      process.env['NODE_ENV'] === 'production'
        ? new KmsVaultKeyProvider(new PgPool({ connectionString: dbUrl, max: 2 }), new AwsKmsDecryptAdapter())
        : new DevVaultKeyProvider();
    identityRepo = new Neo4jIdentityRepository(
      cfg.NEO4J_URI,
      cfg.NEO4J_USER,
      cfg.NEO4J_PASSWORD,
      dbUrl,
      vaultKeyProvider,
    );
    await identityRepo.bootstrap();
    // The per-event use case is ALWAYS constructed: it is the --per-event path AND the idempotent
    // per-batch fallback when a bulk batch fails (the bulk txn is atomic — nothing partial to skip).
    useCase = new ResolveIdentityUseCase(saltProvider, identityRepo);
    if (!perEvent) {
      batchUseCase = new BatchResolveIdentityUseCase(saltProvider, identityRepo, brandId, { batchSize });
    }
  }

  try {
    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    const now = new Date().toISOString();

    const logProgress = (): void => {
      log.info('[backfill-identity] progress', {
        attempted: report.attempted,
        errors: report.errors,
        batchFallbacks: report.batchFallbacks,
        ...report.outcomeCounts,
      });
    };

    /** Per-event resolve (the legacy path AND the per-batch fallback): count outcome or error. */
    const resolveOneByOne = async (bufs: Array<{ buf: Buffer; eventId: unknown }>): Promise<void> => {
      for (const { buf, eventId } of bufs) {
        try {
          const result = await useCase!.execute(buf, now);
          report.outcomeCounts[result.outcome] = (report.outcomeCounts[result.outcome] ?? 0) + 1;
        } catch (err) {
          // Salt/Neo4j failure on ONE event: log + continue (the file is re-runnable; idempotent), but
          // surface it in the exit code so the operator re-runs rather than trusting a partial pass.
          report.errors += 1;
          log.error('[backfill-identity] resolve failed — continuing', {
            brand_id: brandId,
            event_id: eventId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // Batch accumulator (batch mode only) — flushed at batchSize and at EOF. Batches are strictly
    // sequential (bulk write k completes before bulk read k+1) so cross-batch dependencies resolve
    // through the store exactly like the per-event path.
    let pending: Array<{ buf: Buffer; eventId: unknown }> = [];
    const flushBatch = async (): Promise<void> => {
      if (pending.length === 0) return;
      const chunk = pending;
      pending = [];
      try {
        const results: ResolveResult[] = await batchUseCase!.execute(chunk.map((c) => c.buf), now);
        for (const result of results) {
          report.outcomeCounts[result.outcome] = (report.outcomeCounts[result.outcome] ?? 0) + 1;
        }
      } catch (err) {
        // The bulk txn is atomic (nothing partial committed on failure) and every write is
        // idempotent — re-running the SAME events per-event is safe and converges on the legacy
        // error accounting (one poison event costs itself, not the whole batch).
        report.batchFallbacks += 1;
        log.warn('[backfill-identity] batch failed — falling back to per-event for this batch', {
          brand_id: brandId,
          batch_events: chunk.length,
          err: err instanceof Error ? err.message : String(err),
        });
        await resolveOneByOne(chunk);
      }
      logProgress();
    };

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      report.linesRead += 1;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        report.unparseable += 1;
        continue;
      }
      // Tenant guard (defence-in-depth; the export should already be brand-scoped).
      if (parsed['brand_id'] !== brandId) {
        report.otherBrandRejected += 1;
        continue;
      }
      const buf = toResolveBuffer(parsed);
      if (buf === null) {
        report.unparseable += 1;
        continue;
      }

      report.attempted += 1;
      if (dryRun) continue;

      if (batchUseCase) {
        pending.push({ buf, eventId: parsed['event_id'] });
        if (pending.length >= batchSize) await flushBatch();
        continue;
      }

      await resolveOneByOne([{ buf, eventId: parsed['event_id'] }]);
      if (report.attempted % PROGRESS_EVERY === 0) logProgress();
    }

    if (batchUseCase) await flushBatch();

    return report;
  } finally {
    if (identityRepo) await identityRepo.end();
  }
}

/** Non-zero when ANY event errored (partial pass — re-run the same file; idempotent). */
export function backfillExitCode(report: BackfillIdentityReport): number {
  return report.errors > 0 ? 1 : 0;
}

// ── CLI entrypoint (operator only — NEVER register as a tool/MCP) ─────────────
if (
  process.argv[1]?.endsWith('backfill-identity.ts') ||
  process.argv[1]?.endsWith('backfill-identity.js')
) {
  const brandId = process.argv[2];
  const filePath = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  const perEvent = process.argv.includes('--per-event');
  const batchSizeArg = process.argv.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? Number(batchSizeArg.slice('--batch-size='.length)) : undefined;
  if (!brandId || !filePath || (batchSizeArg && (!Number.isInteger(batchSize) || batchSize! < 1))) {
    log.error(
      '[backfill-identity] usage: backfill-identity <brand_id> <events.ndjson> [--dry-run] [--per-event] [--batch-size=N]',
    );
    process.exit(2);
  }
  runIdentityBackfill(brandId, filePath, { dryRun, perEvent, batchSize })
    .then((report) => {
      log.info('[backfill-identity] complete', { ...report });
      console.log(JSON.stringify(report, null, 2));
      process.exit(backfillExitCode(report));
    })
    .catch((err) => {
      log.error('[backfill-identity] fatal', { err });
      process.exit(1);
    });
}
