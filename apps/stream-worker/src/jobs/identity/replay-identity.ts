/**
 * replay-identity — OPERATOR-CONTROLLED batch rebuild of ONE brand's identity graph from Bronze.
 *
 * THIS IS A CLI / JOB ENTRYPOINT — NOT an agent/MCP tool. It is invoked deliberately by an operator
 * (or a scheduled job) for a specific brand; it must NEVER be registered in any tool/MCP registry.
 * It is read-only with respect to LIVE state: it rebuilds the brand's identity partition in an
 * isolated in-memory shadow graph (InMemoryIdentityGraph) by running the SAME deterministic
 * IdentityResolver + the order-independent backfill union-find (computeConnectedComponents) the live
 * stream uses — it does NOT write to Neo4j, PG, or Kafka. Use it to verify a brand's identity
 * resolution is deterministic + order-independent, or to investigate a suspected mis-stitch.
 *
 * GUARANTEES (the replay contract):
 *   - PER-TENANT   — exactly one brand per run (brand_id-first; cross-brand access is rejected).
 *   - ISOLATED     — no live mutation; the live graph is untouched.
 *   - IDEMPOTENT   — a pure function of the Bronze event stream; re-running yields the same report.
 *   - DETERMINISTIC— asserts the rebuilt partition is identical across permuted event orders AND
 *                    equal to the batch union-find (stream == backfill). A violation exits non-zero.
 *
 * Hashing goes through SaltProvider → the SAME per-brand salt the live resolver used, and through
 * the SAME extractor (extract-identifiers), so the replay hashes identifiers identically to live.
 *
 * Usage:  node dist/jobs/identity/replay-identity.js <brand_id> <bronze-events.ndjson>
 *   where the NDJSON file holds one Bronze collector event JSON per line (an operator export).
 */
import { readFileSync } from 'node:fs';
import { loadStreamWorkerConfig } from '@brain/config';
import { createSaltProvider, type SaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { extractRawIdentifierFields, buildIdentifiers } from '../../domain/identity/extract-identifiers.js';
import {
  replayIdentity,
  assertOrderIndependent,
  type ReplayEvent,
} from '../../domain/identity/IdentityReplayEngine.js';
import type { BrandPhoneGuardConfig } from '../../domain/identity/IdentityResolver.js';
import { log } from '../../log.js';

/** A source of a brand's Bronze events for replay — each yields the PARSED Bronze JSON. */
export interface ReplayBronzeSource {
  readBrandEvents(brandId: string): Promise<Array<{ event_id?: string; parsed: Record<string, unknown> }>>;
}

export interface ReplayReport {
  brandId: string;
  /** Bronze rows read from the source. */
  sourceEvents: number;
  /** Rows that carried at least one identifier (the rest are no_identifiers and skipped). */
  replayedEvents: number;
  distinctIdentities: number;
  reviewCount: number;
  /** Label-free partition signature of the rebuild. */
  streamSignature: string;
  /** True iff the partition is identical across permuted event orders. */
  orderIndependent: boolean;
  /** True iff the streaming rebuild equals the batch union-find (stream == backfill). */
  streamEqualsBatch: boolean;
  /** Count of each ResolveAction across the as-given replay (mint/link/merge/...). */
  outcomeCounts: Record<string, number>;
}

export interface RunIdentityReplayDeps {
  source: ReplayBronzeSource;
  saltProvider: SaltProvider;
  brandConfig?: BrandPhoneGuardConfig;
  now?: Date;
}

/**
 * Run the replay for one brand: read Bronze → extract+hash identifiers (same path as live) → rebuild
 * the partition through the resolver → assert determinism + order-independence. Pure of live state.
 */
export async function runIdentityReplay(brandId: string, deps: RunIdentityReplayDeps): Promise<ReplayReport> {
  const saltHex = await deps.saltProvider.saltHexForBrand(brandId);
  const rows = await deps.source.readBrandEvents(brandId);

  const events: ReplayEvent[] = [];
  for (const row of rows) {
    const { fields, regionCode, hasAny } = extractRawIdentifierFields(row.parsed);
    if (!hasAny) continue;
    const identifiers = buildIdentifiers(fields, saltHex, regionCode);
    if (identifiers.length === 0) continue;
    events.push({ event_id: row.event_id, identifiers });
  }

  const opts = { brandId, brandConfig: deps.brandConfig, now: deps.now };
  const primary = await replayIdentity(events, opts);
  const order = await assertOrderIndependent(events, opts);

  const outcomeCounts: Record<string, number> = {};
  for (const a of primary.outcomes) outcomeCounts[a] = (outcomeCounts[a] ?? 0) + 1;

  return {
    brandId,
    sourceEvents: rows.length,
    replayedEvents: events.length,
    distinctIdentities: primary.distinctIdentities,
    reviewCount: primary.reviewCount,
    streamSignature: primary.streamSignature,
    orderIndependent: order.orderIndependent,
    streamEqualsBatch: primary.streamEqualsBatch && order.streamEqualsBatch,
    outcomeCounts,
  };
}

/**
 * NDJSON file source — the operator artifact: a newline-delimited export of the brand's Bronze
 * collector events (one JSON object per line). Lines that fail to parse are skipped (logged).
 */
export class NdjsonReplayBronzeSource implements ReplayBronzeSource {
  constructor(private readonly filePath: string) {}

  async readBrandEvents(brandId: string): Promise<Array<{ event_id?: string; parsed: Record<string, unknown> }>> {
    const text = readFileSync(this.filePath, 'utf8');
    const out: Array<{ event_id?: string; parsed: Record<string, unknown> }> = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        log.warn('[replay-identity] skipping unparseable NDJSON line');
        continue;
      }
      // Tenant guard: only this brand's events (defence-in-depth; the export should already be scoped).
      if (typeof parsed['brand_id'] === 'string' && parsed['brand_id'] !== brandId) continue;
      const eventId = typeof parsed['event_id'] === 'string' ? (parsed['event_id'] as string) : undefined;
      out.push({ event_id: eventId, parsed });
    }
    return out;
  }
}

/** Process exit code: non-zero on a DETERMINISM VIOLATION (a replay that is not order-independent). */
export function replayExitCode(report: ReplayReport): number {
  return report.orderIndependent && report.streamEqualsBatch ? 0 : 1;
}

// ── CLI entrypoint (operator only — NEVER register as a tool/MCP) ─────────────
if (
  process.argv[1]?.endsWith('replay-identity.ts') ||
  process.argv[1]?.endsWith('replay-identity.js')
) {
  const brandId = process.argv[2];
  const filePath = process.argv[3];
  if (!brandId || !filePath) {
    log.error('[replay-identity] usage: replay-identity <brand_id> <bronze-events.ndjson>');
    process.exit(2);
  }
  const cfg = loadStreamWorkerConfig();
  const saltProvider = createSaltProvider(cfg.BRAIN_APP_DATABASE_URL);
  const source = new NdjsonReplayBronzeSource(filePath);
  runIdentityReplay(brandId, { source, saltProvider })
    .then((report) => {
      log.info('[replay-identity] complete', { ...report });
      console.log(JSON.stringify(report, null, 2));
      process.exit(replayExitCode(report));
    })
    .catch((err) => {
      log.error('[replay-identity] fatal', { err });
      process.exit(1);
    });
}
