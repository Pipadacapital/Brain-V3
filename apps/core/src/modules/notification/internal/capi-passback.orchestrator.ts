/**
 * capi-passback.orchestrator — drives Meta CAPI conversion feedback on a schedule (P0).
 *
 * The CapiPassbackService + adapter were CONSTRUCTED then `void`-ed in main.ts — nothing ever
 * called passback(), so conversion feedback never fired in any environment. This orchestrator is
 * the missing driver: every tick it enumerates active brands, fetches FINALIZED purchase candidates
 * over a trailing window, and calls passback() for each. The candidate query anti-joins
 * capi_passback_log, so an every-tick loop is idempotent — a conversion is attempted at most once.
 *
 * SAFETY: passback() is itself default-closed (consent-gated, and the adapter is the DevCapiAdapter
 * unless real Meta creds are resolved in prod — would_send_dev, never sends). This orchestrator is
 * ALSO gated by an explicit enable flag at the wiring seam, so it cannot fire until prod is ready.
 *
 * Dependencies are INJECTED (enumerate / fetch / passback) so the loop is unit-testable without a
 * DB or a Meta network call.
 */
import { randomUUID } from 'node:crypto';
import type { CapiSourceRow } from './capi-source.query.js';
import type { CapiConversion } from './capi-passback.service.js';

export interface CapiPassbackOrchestratorDeps {
  /** Active brand ids (via list_active_brand_ids() — SECURITY DEFINER enumeration). */
  enumerateBrandIds: () => Promise<string[]>;
  /** Brand-scoped finalized-purchase candidates over [from, to] (already anti-joined vs the log). */
  fetchCandidates: (brandId: string, from: Date, to: Date) => Promise<CapiSourceRow[]>;
  /** The CapiPassbackService.passback seam (consent-gated, default-closed). */
  passback: (conv: CapiConversion) => Promise<{ status: string }>;
  /** Trailing window to scan each tick (hours). */
  windowHours: number;
  /** Interval between ticks (ms). */
  intervalMs: number;
  log: { info: (m: string) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  /** Injectable clock for tests (defaults to real time at tick). */
  now?: () => Date;
}

/**
 * Map a finalized-purchase candidate to a CapiConversion. Returns null when the conversion has no
 * resolvable subject_hash — without it there is no consent key, so it cannot be gated or passed back
 * (skip, don't fabricate).
 */
export function mapCandidateToConversion(row: CapiSourceRow): CapiConversion | null {
  if (row.subjectHash == null) return null;
  return {
    brandId: row.brandId,
    orderId: row.orderId,
    ledgerEventId: row.ledgerEventId,
    subjectHash: row.subjectHash,
    valueMinor: BigInt(row.valueMinor),
    currencyCode: row.currencyCode,
    occurredAt: new Date(row.occurredAt),
    fbc: row.fbc,
    fbp: row.fbp,
    correlationId: randomUUID(),
  };
}

export interface CapiPassbackTickResult {
  brands: number;
  attempted: number;
  skipped: number;
}

/** One full pass: enumerate brands → fetch candidates → passback each. Fail-isolated per brand/row. */
export async function runCapiPassbackOnce(deps: CapiPassbackOrchestratorDeps): Promise<CapiPassbackTickResult> {
  const to = (deps.now ?? (() => new Date()))();
  const from = new Date(to.getTime() - deps.windowHours * 3_600_000);
  const brandIds = await deps.enumerateBrandIds();
  let attempted = 0;
  let skipped = 0;

  for (const brandId of brandIds) {
    let candidates: CapiSourceRow[];
    try {
      candidates = await deps.fetchCandidates(brandId, from, to);
    } catch (err) {
      deps.log.error(`[capi-passback] candidate fetch failed brand=${brandId}`, { err });
      continue; // fail-isolated — one brand's DB error never stops the rest
    }
    for (const row of candidates) {
      const conv = mapCandidateToConversion(row);
      if (!conv) {
        skipped += 1; // no subject_hash → no consent key → cannot passback
        continue;
      }
      try {
        await deps.passback(conv);
        attempted += 1;
      } catch (err) {
        deps.log.error(`[capi-passback] passback failed brand=${brandId} order=${row.orderId}`, { err });
      }
    }
  }
  return { brands: brandIds.length, attempted, skipped };
}

export interface CapiPassbackHandle {
  stop: () => void;
}

/** Start the periodic passback loop (first tick after one interval). Returns a stop handle. */
export function startCapiPassback(deps: CapiPassbackOrchestratorDeps): CapiPassbackHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await runCapiPassbackOnce(deps);
      deps.log.info(`[capi-passback] tick brands=${r.brands} attempted=${r.attempted} skipped=${r.skipped}`);
    } catch (err) {
      deps.log.error('[capi-passback] tick failed', { err });
    }
    if (!stopped) timer = setTimeout(() => void loop(), deps.intervalMs);
  };

  timer = setTimeout(() => void loop(), deps.intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
