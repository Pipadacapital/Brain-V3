/**
 * @brain/metric-engine — queryConnectorRecords
 *
 * Paginated, newest-first browser over the CANONICAL business records each connector produces
 * (Silver serving marts): orders, shipments, ad-spend. Powers the UI "Data" records browser — one
 * generic reader for every entity so a new entity is a config entry, not a new query file.
 *
 * The metric engine is the SOLE sanctioned computation/read layer (ADR-002 / D-3). Per-brand isolation
 * is enforced at the Silver read seam (withSilverBrand → BRAND_PREDICATE injects brand_id = ?, placed
 * LAST so the seam binds the brand after any search params). NEVER trust the request body for brand.
 *
 * SAFETY (fail-closed, injection-safe):
 *   - entity → an ALLOWLISTED config (table/date/search/select columns are server-owned, never user
 *     input); an unknown entity THROWS.
 *   - date window → Date-formatted 'YYYY-MM-DD' literals (mirrors ad-spend-timeseries.ts).
 *   - search → PARAMETERIZED `LIKE ?` across the entity's search columns (never interpolated).
 *   - page → sanitized positive int; limit is the fixed PAGE_SIZE; both interpolated as integer literals.
 *
 * MONEY (I-S07): amount columns are returned as BIGINT-minor-unit STRINGS + a sibling currency_code.
 * NEVER divided/floated here — the UI formats via formatMoney(minorString, currency).
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** The canonical entities the records browser can page over. */
export type RecordEntity = 'orders' | 'shipments' | 'ad_spend';

/** Display metadata for one column — the UI renders + formats from this (no hardcoded columns client-side). */
export interface RecordColumn {
  /** Row key (matches a SELECTed column). */
  key: string;
  /** Human column header. */
  label: string;
  /** Render/format hint. money → formatMoney(value, row[currencyKey]); date → localized; number → thousands. */
  type: 'text' | 'date' | 'money' | 'number';
  /** For type='money': the sibling row key holding the ISO currency code. */
  currencyKey?: string;
}

export interface ConnectorRecordsResult {
  entity: RecordEntity;
  /** 1-based page. */
  page: number;
  /** Rows per page (fixed). */
  limit: number;
  /** Total rows matching the filters (for pagination), brand-scoped. */
  total: number;
  /** Column metadata for the table header + per-cell formatting. */
  columns: RecordColumn[];
  /** The page of rows — every value stringified (money = bigint minor string; date = ISO). */
  rows: Array<Record<string, string | null>>;
}

export interface ConnectorRecordsParams {
  entity: string;
  /** Inclusive window, 'YYYY-MM-DD' — the route validates/normalizes these. */
  fromStr: string;
  toStr: string;
  /** Free-text search across the entity's search columns (optional). */
  search?: string;
  /** 1-based page (optional; defaults to 1). */
  page?: number;
}

/** Fixed page size — the product spec is 20 records/page. */
export const CONNECTOR_RECORDS_PAGE_SIZE = 20;

interface EntityConfig {
  /** FROM clause — a table, optionally ALIASED so a SELECT column can carry a correlated sub-select. */
  from: string;
  /** Column the window filters + newest-first ORDER BY use (unqualified → resolves to the FROM table). */
  dateCol: string;
  /** Columns the free-text search matches (case-insensitive LIKE). */
  searchCols: readonly string[];
  /** SELECT list entries — plain columns OR expressions aliased to a column key (superset of columns[].key + currency siblings). */
  selectCols: readonly string[];
  columns: RecordColumn[];
}

/**
 * ALLOWLIST — the only tables/columns this reader will touch. Everything here is server-owned; nothing
 * is derived from the request, so entity/column interpolation is injection-safe by construction.
 */
const ENTITIES: Record<RecordEntity, EntityConfig> = {
  orders: {
    // Aliased `os` so the Value column can pull the GROSS order total via a correlated sub-select.
    from: 'brain_serving.mv_silver_order_state os',
    dateCol: 'first_event_at',
    searchCols: ['order_id', 'lifecycle_state'],
    selectCols: [
      'order_id',
      'lifecycle_state',
      // Value = GROSS order total (Σ line totals), populated for ALL orders including `placed`. The mart's
      // own order_value_minor is RECOGNISED revenue (0 until confirmed — "revenue truth"), which reads as
      // "0 for every recent order" in a browser. COALESCE→0 when an order has no lines yet.
      'COALESCE((SELECT SUM(ol.line_total_minor) FROM brain_serving.mv_silver_order_line ol '
        + 'WHERE ol.brand_id = os.brand_id AND ol.order_id = os.order_id), 0) AS order_value_minor',
      'currency_code',
      'first_event_at',
    ],
    columns: [
      { key: 'first_event_at', label: 'Placed', type: 'date' },
      { key: 'order_id', label: 'Order', type: 'text' },
      { key: 'lifecycle_state', label: 'Status', type: 'text' },
      { key: 'order_value_minor', label: 'Value', type: 'money', currencyKey: 'currency_code' },
    ],
  },
  shipments: {
    from: 'brain_serving.mv_silver_shipment',
    dateCol: 'first_event_at',
    searchCols: ['order_id', 'courier', 'current_status', 'pincode'],
    selectCols: ['order_id', 'courier', 'current_status', 'pincode', 'payment_method', 'source', 'first_event_at'],
    columns: [
      { key: 'first_event_at', label: 'First event', type: 'date' },
      { key: 'order_id', label: 'Order', type: 'text' },
      { key: 'courier', label: 'Courier', type: 'text' },
      { key: 'current_status', label: 'Status', type: 'text' },
      { key: 'pincode', label: 'Pincode', type: 'text' },
      { key: 'payment_method', label: 'Payment', type: 'text' },
      { key: 'source', label: 'Source', type: 'text' },
    ],
  },
  ad_spend: {
    from: 'brain_serving.mv_silver_marketing_spend',
    dateCol: 'stat_date',
    searchCols: ['campaign_name', 'platform', 'level'],
    selectCols: ['stat_date', 'platform', 'campaign_name', 'level', 'spend_minor', 'currency_code', 'impressions', 'clicks'],
    columns: [
      { key: 'stat_date', label: 'Date', type: 'date' },
      { key: 'platform', label: 'Platform', type: 'text' },
      { key: 'campaign_name', label: 'Campaign', type: 'text' },
      { key: 'level', label: 'Level', type: 'text' },
      { key: 'spend_minor', label: 'Spend', type: 'money', currencyKey: 'currency_code' },
      { key: 'impressions', label: 'Impressions', type: 'number' },
      { key: 'clicks', label: 'Clicks', type: 'number' },
    ],
  },
};

/** The entities the UI can request (allowlist for the route/tabs). */
export const CONNECTOR_RECORD_ENTITIES = Object.keys(ENTITIES) as RecordEntity[];

function isRecordEntity(v: string): v is RecordEntity {
  return Object.prototype.hasOwnProperty.call(ENTITIES, v);
}

/**
 * queryConnectorRecords — one page (newest first) of canonical records for an entity, brand-scoped.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER the request body).
 * @param deps    - The Silver serving pool.
 * @param params  - entity + date window + optional search + page.
 * @returns       - {columns, rows, total, page, limit} — total drives pagination; rows are stringified.
 * @throws        - on an unknown entity (fail-closed).
 */
export async function queryConnectorRecords(
  brandId: string,
  deps: { srPool: SilverPool },
  params: ConnectorRecordsParams,
): Promise<ConnectorRecordsResult> {
  if (!isRecordEntity(params.entity)) {
    throw new Error(`[connector-records] unknown entity '${params.entity}'`);
  }
  const cfg = ENTITIES[params.entity];

  // page → positive int; limit fixed; both become integer LITERALS (sanitized, injection-safe).
  const page = Math.max(1, Math.trunc(Number(params.page ?? 1)) || 1);
  const limit = CONNECTOR_RECORDS_PAGE_SIZE;
  const offset = (page - 1) * limit;

  // Date window: CAST(dateCol AS DATE) is a no-op for stat_date and tz-safe for timestamp cols. The
  // fromStr/toStr are Date-formatted 'YYYY-MM-DD' upstream → safe to interpolate as DATE literals.
  const dateFilter = `CAST(${cfg.dateCol} AS DATE) BETWEEN DATE '${params.fromStr}' AND DATE '${params.toStr}'`;

  // Search: parameterized LIKE across the entity's search columns (case-insensitive). One `?` per column.
  const search = (params.search ?? '').trim();
  const searchParams: string[] = [];
  let searchFilter = '';
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    const clauses = cfg.searchCols.map((c) => `LOWER(CAST(${c} AS VARCHAR)) LIKE ?`);
    for (let i = 0; i < cfg.searchCols.length; i += 1) searchParams.push(like);
    searchFilter = `AND (${clauses.join(' OR ')})`;
  }

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // (1) total for pagination — same filters. BRAND_PREDICATE LAST → the seam binds brand after searchParams.
    const countRows = await scope.runScoped<{ n: string | number }>(
      `SELECT count(*) AS n
         FROM ${cfg.from}
        WHERE ${dateFilter}
          ${searchFilter}
          AND ${BRAND_PREDICATE}`,
      [...searchParams],
    );
    const total = Number(countRows[0]?.n ?? 0);

    // (2) the page — newest first. LIMIT/OFFSET are sanitized integers (literals). Keep the same param order.
    const rows =
      total === 0
        ? []
        : await scope.runScoped<Record<string, string | number | null>>(
            `SELECT ${cfg.selectCols.join(', ')}
               FROM ${cfg.from}
              WHERE ${dateFilter}
                ${searchFilter}
                AND ${BRAND_PREDICATE}
              ORDER BY ${cfg.dateCol} DESC
              OFFSET ${offset} LIMIT ${limit}`,
            [...searchParams],
          );

    return {
      entity: params.entity as RecordEntity,
      page,
      limit,
      total,
      columns: cfg.columns,
      // Stringify every value: money → the BIGINT minor-unit string (no float), date → ISO, null preserved.
      rows: rows.map((r) => {
        const out: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(r)) {
          out[k] = v === null || v === undefined ? null : String(v);
        }
        return out;
      }),
    };
  });
}
