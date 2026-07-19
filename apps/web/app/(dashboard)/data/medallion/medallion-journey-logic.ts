/**
 * medallion-journey-logic — pure, React-free derivations for the "Data Journey" page.
 *
 * Extracted out of medallion-journey-content.tsx so they are unit-testable node-side (the .tsx
 * module imports client-only `@/...` UI barrels + hooks that the node-env vitest can't resolve —
 * same reason backfill-control-logic.ts lives apart from its component). No React, no `@/` imports.
 *
 * The five medallion stages each report a `state` string from the backend
 * ('fresh'|'stale'|'failed'|'never'|'no_data'). These helpers turn that raw state into the
 * plain-language label + StatusPill status the render drives from, plus the small numeric
 * derivations (fresh-vs-stale mart tallies, lag humaniser, big-number humaniser) — so the tests
 * guard the SAME functions the JSX calls.
 */

/** The stage lifecycle state as the medallion-journey endpoint reports it. */
export type StageState = 'fresh' | 'stale' | 'failed' | 'never' | 'no_data';

/** StatusPill's three-state vocabulary (glyph SHAPE differs per state — never colour-only). */
export type PillStatus = 'healthy' | 'waiting' | 'error';

export interface StageVerdict {
  status: PillStatus;
  /** Human label carrying the meaning (StatusPill text). */
  label: string;
}

/**
 * stageVerdict — a stage `state` → { StatusPill status, plain-language label }.
 *
 * Honesty rule (Brain): 'never'/'no_data' are NOT failures and NOT successes — they read
 * "No data yet" as a calm waiting state, never a fabricated healthy/zero. 'failed' is the only
 * error. An unknown/forward-compatible state string is surfaced verbatim (never hidden) as a
 * waiting pill rather than silently dropped.
 */
export function stageVerdict(state: string | null | undefined): StageVerdict {
  switch (state) {
    case 'fresh':
      return { status: 'healthy', label: 'Fresh' };
    case 'stale':
      return { status: 'waiting', label: 'Falling behind' };
    case 'failed':
      return { status: 'error', label: 'Failed' };
    case 'never':
    case 'no_data':
    case null:
    case undefined:
      return { status: 'waiting', label: 'No data yet' };
    default:
      // Forward-compatible: an unrecognised backend state is shown, never hidden.
      return { status: 'waiting', label: String(state) };
  }
}

/**
 * humanizeCount — big integers → compact, readable form (1_240_000 → "1.2M", 12_400 → "12.4K").
 *
 * Honest about the absence of a number: null/undefined → "—" (never a fabricated 0). Small
 * counts (< 1000) render with locale grouping (en-IN) so "947" stays exact.
 */
export function humanizeCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return new Intl.NumberFormat('en-IN').format(n);
  if (abs < 1_000_000) return `${trim1(n / 1000)}K`;
  if (abs < 1_000_000_000) return `${trim1(n / 1_000_000)}M`;
  return `${trim1(n / 1_000_000_000)}B`;
}

/** One-decimal, but drop a trailing ".0" (1.0M → "1M", 1.2M stays "1.2M"). */
function trim1(x: number): string {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * humanizeLag — a watermark lag in SECONDS → a short "behind" phrase for the Silver stage
 * ("42s behind", "8m behind", "3h behind", "2d behind"). null → "lag unknown" (honest — we don't
 * claim caught-up). A non-positive lag reads "up to date".
 */
export function humanizeLag(lagSeconds: number | null | undefined): string {
  if (lagSeconds === null || lagSeconds === undefined || !Number.isFinite(lagSeconds)) {
    return 'lag unknown';
  }
  if (lagSeconds <= 0) return 'up to date';
  if (lagSeconds < 90) return `${Math.round(lagSeconds)}s behind`;
  const min = Math.round(lagSeconds / 60);
  if (min < 90) return `${min}m behind`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h behind`;
  const day = Math.round(hr / 24);
  return `${day}d behind`;
}

/** A stage that carries a list of marts with per-item state (Serving; also reused for Gold BI). */
export interface MartLike {
  state?: string | null;
  freshnessAt?: string | null;
}

export interface MartTally {
  total: number;
  fresh: number;
  stale: number;
}

/**
 * martTally — count fresh vs everything-else across a list of marts/views. Used for the Serving
 * stage's "N of M views fresh" summary. A mart is "fresh" ONLY when its state is exactly 'fresh';
 * anything else (stale/failed/never/no_data/unknown/missing) counts as not-fresh — honest, never
 * optimistic-rounds a stale view up to fresh.
 */
export function martTally(marts: readonly MartLike[] | null | undefined): MartTally {
  const list = marts ?? [];
  const total = list.length;
  const fresh = list.filter((m) => m.state === 'fresh').length;
  return { total, fresh, stale: total - fresh };
}

/**
 * servingSummaryLabel — the Serving stage headline: "3 of 5 views fresh" / "All 5 views fresh" /
 * "No serving views yet". Drives the render AND is unit-guarded.
 */
export function servingSummaryLabel(tally: MartTally): string {
  if (tally.total === 0) return 'No serving views yet';
  if (tally.fresh === tally.total) {
    return `All ${tally.total} view${tally.total === 1 ? '' : 's'} fresh`;
  }
  return `${tally.fresh} of ${tally.total} views fresh`;
}
