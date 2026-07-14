// SPEC:C.2.4
/**
 * product-costs.ts — CSV ingest + versioned per-SKU cost sheet (gold_product_costs, 0126).
 *
 * SPEC:C.2.4 — the brand-uploaded COGS source that feeds Wave C's gold_measurement_costs /
 * gold_order_economics when the connector catalog carries no cost field. `cost_input` (0055) is the
 * RATE-config ancestor; THIS is the per-SKU UNIT-cost sheet with bi-temporal validity.
 *
 * INVARIANTS enforced here (validation is the deliverable):
 *   • MONEY = integer minor units (bigint-as-string) + explicit ISO-4217 currency. Non-negative.
 *     Reject a non-integer / negative cost_minor, or a malformed currency (via @brain/money).
 *   • GCC 3-decimal currencies (BHD/KWD/OMR) carry 3-decimal minor units — the value is stored
 *     already-minor; we never multiply/divide, so ZERO rounding loss.
 *   • BI-TEMPORAL validity: reject valid_to <= valid_from, and reject OVERLAPPING validity for one
 *     (sku, currency) — both within the batch AND against already-stored versions.
 *   • Tenant-scoped: brand comes from the session (D-1) and every read/write runs under
 *     withBrandTxn (RLS; brand GUC set; SET LOCAL ROLE brain_app). Never a manual brand WHERE.
 *   • IDEMPOTENT: the version key is deterministic sha256(brand‖sku‖currency‖valid_from); re-posting
 *     the same version UPDATES in place (no duplicate). source_event_id is deterministic per upload
 *     content so a replay of the same file is a byte-for-byte no-op.
 */
import { createHash } from 'node:crypto';
import { isValidCurrency } from '@brain/money';
import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

// ── DTOs ────────────────────────────────────────────────────────────────────────
export interface ProductCostRow {
  sku: string;
  /** Unit cost in integer minor units, as a decimal string of digits (I-S07). */
  cost_minor: string;
  currency_code: string;
  /** ISO date (YYYY-MM-DD) — valid-time lower bound (inclusive). */
  valid_from: string;
  /** ISO date (YYYY-MM-DD) — valid-time upper bound (exclusive); null/absent = open-ended. */
  valid_to?: string | null;
}

export interface ProductCostDto extends ProductCostRow {
  valid_to: string | null;
  source_system: string;
  source_event_id: string;
}

export interface CostRowError {
  /** 1-based row index (CSV line number excluding header), or -1 for file-level errors. */
  row: number;
  sku?: string;
  message: string;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  /** Total accepted rows (inserted + updated). */
  accepted: number;
  rejected: CostRowError[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_RE = /^\d+$/;

// ── CSV parsing ───────────────────────────────────────────────────────────────
/**
 * Parse a cost-sheet CSV into raw rows. Header is required and case-insensitive; columns:
 *   sku, cost_minor, currency_code, valid_from[, valid_to]
 * Minimal RFC-4180-ish parser (no quoted-field commas — cost sheets are numeric/sku, not prose).
 * Throws on a missing/invalid header; per-row shape errors are surfaced by validateRows, not here.
 */
export function parseCostSheetCsv(csv: string): ProductCostRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('empty CSV (no header)');

  const header = (lines[0] as string).split(',').map((h) => h.trim().toLowerCase());
  const idx = {
    sku: header.indexOf('sku'),
    cost_minor: header.indexOf('cost_minor'),
    currency_code: header.indexOf('currency_code'),
    valid_from: header.indexOf('valid_from'),
    valid_to: header.indexOf('valid_to'),
  };
  const required: Array<keyof typeof idx> = ['sku', 'cost_minor', 'currency_code', 'valid_from'];
  const missing = required.filter((k) => idx[k] < 0);
  if (missing.length > 0) {
    throw new Error(`CSV header missing required column(s): ${missing.join(', ')}`);
  }

  const rows: ProductCostRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(',').map((c) => c.trim());
    const validTo = idx.valid_to >= 0 ? cells[idx.valid_to] ?? '' : '';
    rows.push({
      sku: cells[idx.sku] ?? '',
      cost_minor: cells[idx.cost_minor] ?? '',
      currency_code: cells[idx.currency_code] ?? '',
      valid_from: cells[idx.valid_from] ?? '',
      valid_to: validTo === '' ? null : validTo,
    });
  }
  return rows;
}

// ── Validation ──────────────────────────────────────────────────────────────────
interface CleanRow {
  sku: string;
  cost_minor: string;
  currency_code: string;
  valid_from: string;
  valid_to: string | null;
}

/**
 * Validate rows independently (money/currency/date shape) AND collectively (batch-internal overlap).
 * Returns the clean rows plus per-row errors. NEVER throws — a bad row is reported, not fatal.
 */
export function validateRows(rows: ProductCostRow[]): { clean: CleanRow[]; rejected: CostRowError[] } {
  const clean: CleanRow[] = [];
  const rejected: CostRowError[] = [];
  // Track accepted intervals per (sku, currency) for batch-internal overlap detection.
  const seen = new Map<string, Array<{ from: string; to: string | null; rowNum: number }>>();

  rows.forEach((r, i) => {
    const rowNum = i + 1; // 1-based, header excluded
    const sku = (r.sku ?? '').trim();
    const currency = (r.currency_code ?? '').trim().toUpperCase();
    const costStr = (r.cost_minor ?? '').trim();
    const from = (r.valid_from ?? '').trim();
    const to = r.valid_to == null || String(r.valid_to).trim() === '' ? null : String(r.valid_to).trim();

    if (!sku) return void rejected.push({ row: rowNum, message: 'sku is required' });
    if (!isValidCurrency(currency)) {
      return void rejected.push({ row: rowNum, sku, message: `invalid currency "${r.currency_code}" (expected ISO-4217 alpha-3)` });
    }
    if (!DIGITS_RE.test(costStr)) {
      return void rejected.push({ row: rowNum, sku, message: `cost_minor must be a non-negative integer (minor units); got "${r.cost_minor}"` });
    }
    if (!ISO_DATE_RE.test(from) || Number.isNaN(Date.parse(from))) {
      return void rejected.push({ row: rowNum, sku, message: `valid_from must be an ISO date (YYYY-MM-DD); got "${r.valid_from}"` });
    }
    if (to !== null && (!ISO_DATE_RE.test(to) || Number.isNaN(Date.parse(to)))) {
      return void rejected.push({ row: rowNum, sku, message: `valid_to must be an ISO date (YYYY-MM-DD); got "${r.valid_to}"` });
    }
    if (to !== null && to <= from) {
      return void rejected.push({ row: rowNum, sku, message: `valid_to (${to}) must be after valid_from (${from})` });
    }

    // Batch-internal overlap: same (sku, currency) intervals must be disjoint.
    const key = `${sku}␟${currency}`;
    const priors = seen.get(key) ?? [];
    const overlap = priors.find((p) => intervalsOverlap(from, to, p.from, p.to));
    if (overlap) {
      return void rejected.push({
        row: rowNum,
        sku,
        message: `overlapping validity for sku ${sku}/${currency} with row ${overlap.rowNum} ([${overlap.from}, ${overlap.to ?? '∞'}))`,
      });
    }
    priors.push({ from, to, rowNum });
    seen.set(key, priors);
    clean.push({ sku, cost_minor: costStr, currency_code: currency, valid_from: from, valid_to: to });
  });

  return { clean, rejected };
}

/** Half-open interval overlap [a1,a2) ∩ [b1,b2) ≠ ∅, treating null upper bound as +∞. */
function intervalsOverlap(a1: string, a2: string | null, b1: string, b2: string | null): boolean {
  const aLtB = a2 === null || a2 > b1; // a1..a2 extends past b1
  const bLtA = b2 === null || b2 > a1; // b1..b2 extends past a1
  return aLtB && bLtA;
}

function productCostId(brandId: string, sku: string, currency: string, validFrom: string): string {
  return createHash('sha256').update(`${brandId}\0${sku}\0${currency}\0${validFrom}`).digest('hex');
}

/** Deterministic upload-batch id from the (brand + normalized content) so a replay is a no-op. */
function batchId(brandId: string, clean: CleanRow[]): string {
  const payload = clean
    .map((c) => `${c.sku}|${c.cost_minor}|${c.currency_code}|${c.valid_from}|${c.valid_to ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(`${brandId}\0${payload}`).digest('hex').slice(0, 32);
}

// ── Ingest (versioned, idempotent, RLS-scoped) ──────────────────────────────────
/**
 * Ingest validated cost rows for a brand. Runs inside ONE withBrandTxn (RLS). For each version:
 *   • same deterministic id already present → UPDATE in place (idempotent restate).
 *   • else → check overlap against STORED versions of the same (sku, currency); reject on overlap;
 *            otherwise INSERT.
 * The DB EXCLUDE (gpc_no_overlap) is the hard backstop; the app pre-check gives a friendly error and
 * keeps ON CONFLICT out of the exclusion-constraint interaction.
 */
export async function ingestProductCosts(
  brandId: string,
  rows: ProductCostRow[],
  deps: EngineDeps,
): Promise<IngestResult> {
  const { clean, rejected } = validateRows(rows);
  const source = batchId(brandId, clean);
  let inserted = 0;
  let updated = 0;
  const runtimeRejected: CostRowError[] = [];

  if (clean.length > 0) {
    await withBrandTxn(deps.pool, brandId, async (client) => {
      for (const r of clean) {
        const id = productCostId(brandId, r.sku, r.currency_code, r.valid_from);
        // Does this exact version already exist?
        const existing = await client.query<{ product_cost_id: string }>(
          `SELECT product_cost_id FROM gold_product_costs
            WHERE brand_id = $1 AND product_cost_id = $2 FOR UPDATE`,
          [brandId, id],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          await client.query(
            `UPDATE gold_product_costs
                SET cost_minor = $3, valid_to = $4, source_system = $5, source_event_id = $6, updated_at = NOW()
              WHERE brand_id = $1 AND product_cost_id = $2`,
            [brandId, id, r.cost_minor, r.valid_to, 'cost_sheet_csv', source],
          );
          updated++;
          continue;
        }
        // New version — reject if it overlaps a STORED version of the same (sku, currency).
        const clash = await client.query<{ valid_from: string; valid_to: string | null }>(
          `SELECT valid_from::text, valid_to::text FROM gold_product_costs
            WHERE brand_id = $1 AND sku = $2 AND currency_code = $3
              AND daterange(valid_from, valid_to, '[)') && daterange($4::date, $5::date, '[)')`,
          [brandId, r.sku, r.currency_code, r.valid_from, r.valid_to],
        );
        if (clash.rowCount && clash.rowCount > 0) {
          const c = clash.rows[0]!;
          runtimeRejected.push({
            row: -1,
            sku: r.sku,
            message: `overlapping validity for sku ${r.sku}/${r.currency_code} with stored version [${c.valid_from}, ${c.valid_to ?? '∞'})`,
          });
          continue;
        }
        await client.query(
          `INSERT INTO gold_product_costs
             (brand_id, product_cost_id, sku, cost_minor, currency_code, valid_from, valid_to, source_system, source_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [brandId, id, r.sku, r.cost_minor, r.currency_code, r.valid_from, r.valid_to, 'cost_sheet_csv', source],
        );
        inserted++;
      }
      return null;
    });
  }

  return {
    inserted,
    updated,
    accepted: inserted + updated,
    rejected: [...rejected, ...runtimeRejected],
  };
}

/** List a brand's currently-open (valid_to IS NULL) cost-sheet versions. */
export async function listProductCosts(brandId: string, deps: EngineDeps): Promise<ProductCostDto[]> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{
      sku: string; cost_minor: string; currency_code: string;
      valid_from: string; valid_to: string | null; source_system: string; source_event_id: string;
    }>(
      `SELECT sku, cost_minor::text AS cost_minor, currency_code,
              valid_from::text AS valid_from, valid_to::text AS valid_to,
              source_system, source_event_id
         FROM gold_product_costs
        WHERE brand_id = $1 AND valid_to IS NULL
        ORDER BY sku, currency_code`,
      [brandId],
    );
    return r.rows.map((x) => ({
      sku: x.sku,
      cost_minor: x.cost_minor,
      currency_code: x.currency_code,
      valid_from: x.valid_from,
      valid_to: x.valid_to,
      source_system: x.source_system,
      source_event_id: x.source_event_id,
    }));
  });
}
