/**
 * @brain/metric-engine — getCustomerOrders (per-customer order list for Customer 360).
 *
 * The SOLE read seam for ONE resolved customer's orders — read through withSilverBrand
 * (brand predicate injected at the seam, I-ST01) over brain_serving.mv_silver_order_state, the
 * deterministic 1-row-per-(brand_id, order_id) latest-lifecycle-state fold. Backs the Customer
 * Profile "Orders" sub-tab, which is count-only today: this turns the count into the actual list.
 *
 * GRAIN: one row per order_id (latest captured lifecycle state), newest-first, capped at `limit`.
 * MONEY (I-S07): orderValueMinor is SIGNED bigint MINOR units (carried as string for BigInt-safe JSON)
 * paired with its sibling currencyCode — never a float, never blended across currencies.
 *
 * Honest-empty: returns [] when the customer has no orders (or the serving tier is unavailable — the
 * seam degrades a missing mart to []). brain_id/brand_id are varchar in this mart. NO PII (no raw
 * email/phone; identifiers are hashed upstream).
 * @see packages/metric-engine/src/customer-360.ts (sibling per-customer Gold read)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CustomerOrderRow {
  orderId: string;
  lifecycleState: string;
  isTerminal: boolean;
  /** SIGNED bigint MINOR units as string (BigInt-safe JSON); paired with currencyCode. */
  orderValueMinor: string;
  currencyCode: string | null;
  /** ISO-8601 — when the order was first observed (placed). Null = unknown. */
  firstEventAt: string | null;
  /** ISO-8601 — when the latest lifecycle state took effect. Null = unknown. */
  stateEffectiveAt: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// ── AUD-SL-11: keyset pagination ─────────────────────────────────────────────────────────────────
// The plain read below is LIMIT-only (max 200) — fine for the Customer-360 first page, but a list
// consumer that wants "the rest" would have to grow the LIMIT (a deepening scan). The paged variant
// adds an opaque keyset cursor over (sort_ts DESC, order_id ASC) — the proven journey-list pattern —
// so each page is an index-friendly strictly-older slice, never OFFSET, never a bigger re-scan.
//
// SORT KEY: state_effective_at is nullable ("unknown"), and Trino sorts NULLs FIRST under DESC — so
// the paged variant sorts on `date_trunc('second', COALESCE(state_effective_at, TIMESTAMP
// '9999-12-31 23:59:59 UTC'))`: the COALESCE sentinel reproduces the NULLS-FIRST-on-DESC placement
// with a concrete, cursor-encodable value, and the date_trunc matches the trino-adapter's
// timestamp-param normalization (it drops fractional seconds — a sub-second sort key would skip
// rows across pages). Ties within a second break on order_id ASC (unique per brand → total order).

/** Decoded keyset cursor: the (sort_ts, order_id) of the last row on the prior page. */
interface CustomerOrdersCursor {
  t: string;
  o: string;
}

/** Encode the keyset tuple as an opaque base64url token (plain strings — BigInt-free). */
function encodeCursor(c: CustomerOrdersCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode an opaque cursor; any malformed/partial token degrades to null (→ first page, honest). */
function decodeCursor(raw: string | null | undefined): CustomerOrdersCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as CustomerOrdersCursor).t === 'string' &&
      typeof (parsed as CustomerOrdersCursor).o === 'string' &&
      (parsed as CustomerOrdersCursor).t.length > 0 &&
      (parsed as CustomerOrdersCursor).o.length > 0
    ) {
      return { t: (parsed as CustomerOrdersCursor).t, o: (parsed as CustomerOrdersCursor).o };
    }
  } catch {
    // fall through — an unreadable cursor is a first-page request, never an error
  }
  return null;
}

export interface CustomerOrdersPageParams {
  /** Page size (clamped 1..200; default 50). */
  limit?: number;
  /** Opaque keyset continuation from a prior page's nextCursor (invalid → first page). */
  cursor?: string | null;
}

export interface CustomerOrdersPage {
  rows: CustomerOrderRow[];
  /** Opaque keyset cursor for the NEXT (older) page; null = this is the last page. */
  nextCursor: string | null;
}

interface CustomerOrderDbRow {
  order_id: string;
  lifecycle_state: string | null;
  is_terminal: boolean | number | null;
  order_value_minor: string | number | null;
  currency_code: string | null;
  first_event_at: string | Date | null;
  state_effective_at: string | Date | null;
}

function mapRow(r: CustomerOrderDbRow): CustomerOrderRow {
  return {
    orderId: r.order_id,
    lifecycleState: r.lifecycle_state ?? 'unknown',
    isTerminal: r.is_terminal === true || Number(r.is_terminal) === 1,
    orderValueMinor: BigInt(String(r.order_value_minor ?? '0').split('.')[0] ?? '0').toString(),
    currencyCode: r.currency_code ?? null,
    firstEventAt: toIso(r.first_event_at),
    stateEffectiveAt: toIso(r.state_effective_at),
  };
}

/** The cursor-stable sort key (see the keyset note above). */
const SORT_TS =
  "date_trunc('second', COALESCE(state_effective_at, TIMESTAMP '9999-12-31 23:59:59 UTC'))";

/**
 * getCustomerOrdersPage — ONE keyset page of the resolved customer's orders, newest-first
 * (AUD-SL-11). Same mart / seam / row shape as getCustomerOrders; adds the opaque cursor so
 * deep lists page in bounded slices instead of a growing LIMIT.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param brainId - The resolved customer's brain_id.
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param params  - page size (clamped 1..200; default 50) + optional keyset continuation.
 */
export async function getCustomerOrdersPage(
  brandId: string,
  brainId: string,
  deps: { srPool: SilverPool },
  params: CustomerOrdersPageParams = {},
): Promise<CustomerOrdersPage> {
  if (!brainId || brainId.length === 0) return { rows: [], nextCursor: null };
  const lim = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const cursor = decodeCursor(params.cursor);

  const dbRows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally after the caller's
    // params. LIMIT lim+1 = look-ahead row: its presence means a further page exists (not returned).
    if (cursor) {
      return scope.runScoped<CustomerOrderDbRow & { sort_ts: string | Date }>(
        `SELECT order_id, lifecycle_state, is_terminal, order_value_minor, currency_code,
                first_event_at, state_effective_at, ${SORT_TS} AS sort_ts
           FROM brain_serving.mv_silver_order_state
          WHERE brain_id = ?
            AND (${SORT_TS} < ? OR (${SORT_TS} = ? AND order_id > ?))
            AND ${BRAND_PREDICATE}
          ORDER BY sort_ts DESC, order_id ASC
          LIMIT ${lim + 1}`,
        [brainId, cursor.t, cursor.t, cursor.o],
      );
    }
    return scope.runScoped<CustomerOrderDbRow & { sort_ts: string | Date }>(
      `SELECT order_id, lifecycle_state, is_terminal, order_value_minor, currency_code,
              first_event_at, state_effective_at, ${SORT_TS} AS sort_ts
         FROM brain_serving.mv_silver_order_state
        WHERE brain_id = ? AND ${BRAND_PREDICATE}
        ORDER BY sort_ts DESC, order_id ASC
        LIMIT ${lim + 1}`,
      [brainId],
    );
  });

  const hasMore = dbRows.length > lim;
  const page = hasMore ? dbRows.slice(0, lim) : dbRows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last && last.sort_ts != null
      ? encodeCursor({ t: String(last.sort_ts), o: String(last.order_id) })
      : null;
  return { rows: page.map(mapRow), nextCursor };
}

/**
 * getCustomerOrders — the resolved customer's orders (latest state each), newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param brainId - The resolved customer's brain_id.
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param limit   - max orders to return (clamped 1..200; default 50).
 */
export async function getCustomerOrders(
  brandId: string,
  brainId: string,
  deps: { srPool: SilverPool },
  limit: number = DEFAULT_LIMIT,
): Promise<CustomerOrderRow[]> {
  if (!brainId || brainId.length === 0) return [];
  const lim = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<CustomerOrderDbRow>(
      // BRAND_PREDICATE must be the LAST placeholder — the seam APPENDS brandId, so brain_id = ? (the
      // caller's own placeholder) comes first and brand_id = ? is appended last.
      `SELECT order_id, lifecycle_state, is_terminal, order_value_minor, currency_code,
              first_event_at, state_effective_at
         FROM brain_serving.mv_silver_order_state
        WHERE brain_id = ? AND ${BRAND_PREDICATE}
        ORDER BY state_effective_at DESC, order_id ASC
        LIMIT ${lim}`,
      [brainId],
    );

    return rows.map(mapRow);
  });
}
