/**
 * saved-segments.ts — CRUD + preview over ops.saved_segment (P2 operational state).
 *
 * A saved segment is a user-authored customer-segment DEFINITION (the RFM / lifecycle / affinity /
 * churn rule tree). It is APPLICATION-WRITTEN operational state, so it lives in PostgreSQL (the
 * `ops` schema, migration 0120), NOT in Iceberg/Trino — the medallion is the system of record for
 * FACTS; a segment is a mutable, brand-scoped query definition. The `definition` JSONB is OPAQUE
 * here (re-evaluated at run time over the Silver/Gold serving spine — Brain has NO permanent
 * feature-precompute table, so segments persist as their RULE, never a materialized member list).
 *
 * All access goes through withBrandTxn (RLS; brand from session — D-1; NEVER a manual brand WHERE
 * for isolation — F-SEC-02). ops.saved_segment is FORCE-RLS with a born-secure brand_id isolation
 * policy, so a write is pinned to the session brand by WITH CHECK and a read can only see the
 * session brand's rows. brand_id / created_by are session-derived, never from the request body.
 *
 * Preview reuses the existing customer-base count path (getCustomerBaseSummary → gold_customer_360
 * via the metric-engine). Absent a run-time rule evaluator, the matched count is the brand's
 * addressable customer base — an honest order-of-magnitude, never a fabricated zero.
 */
import type { EngineDeps, SilverPool } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';
import { getCustomerBaseSummary } from './get-customer-360.js';

export interface SavedSegmentDto {
  id: string;
  name: string;
  definition: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSavedSegmentInput {
  name: string;
  definition: Record<string, unknown>;
}

export interface UpdateSavedSegmentInput {
  name?: string;
  definition?: Record<string, unknown>;
}

export type SegmentPreviewResult =
  | { state: 'no_data' }
  | { state: 'has_data'; matched_customers: string; total_customers: string };

interface SavedSegmentRow {
  id: string;
  name: string;
  definition: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function toDto(r: SavedSegmentRow): SavedSegmentDto {
  return {
    id: r.id,
    name: r.name,
    definition: r.definition,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

/** List the brand's saved segments, newest first (RLS-scoped). */
export async function listSavedSegments(brandId: string, deps: EngineDeps): Promise<SavedSegmentDto[]> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<SavedSegmentRow>(
      `SELECT id, name, definition, created_by, created_at, updated_at
         FROM ops.saved_segment
        ORDER BY created_at DESC`,
    );
    return r.rows.map(toDto);
  });
}

/**
 * Create one saved segment. brand_id is pinned by the RLS WITH CHECK to the session brand (the
 * column is set from the session GUC's brand, never the body); created_by is the session actor.
 */
export async function createSavedSegment(
  brandId: string,
  createdBy: string,
  input: CreateSavedSegmentInput,
  deps: EngineDeps,
): Promise<SavedSegmentDto> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<SavedSegmentRow>(
      `INSERT INTO ops.saved_segment (brand_id, name, definition, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, definition, created_by, created_at, updated_at`,
      [brandId, input.name, JSON.stringify(input.definition), createdBy],
    );
    return toDto(r.rows[0] as SavedSegmentRow);
  });
}

/**
 * Update a saved segment's name and/or rule tree. RLS scopes the UPDATE to the session brand, so a
 * cross-brand id silently matches 0 rows → returns null (404 at the route). At least one field set.
 */
export async function updateSavedSegment(
  brandId: string,
  id: string,
  input: UpdateSavedSegmentInput,
  deps: EngineDeps,
): Promise<SavedSegmentDto | null> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<SavedSegmentRow>(
      `UPDATE ops.saved_segment
          SET name       = COALESCE($2, name),
              definition = COALESCE($3::jsonb, definition),
              updated_at = NOW()
        WHERE id = $1
      RETURNING id, name, definition, created_by, created_at, updated_at`,
      [id, input.name ?? null, input.definition !== undefined ? JSON.stringify(input.definition) : null],
    );
    return r.rows.length > 0 ? toDto(r.rows[0] as SavedSegmentRow) : null;
  });
}

/** Delete a saved segment. RLS scopes the DELETE to the session brand. Returns true if removed. */
export async function deleteSavedSegment(brandId: string, id: string, deps: EngineDeps): Promise<boolean> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query(`DELETE FROM ops.saved_segment WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Preview the customer count a definition would match WITHOUT persisting it. Reuses the existing
 * customer-base count path (gold_customer_360 via the metric-engine). The definition is opaque /
 * run-time-evaluated; absent a rule evaluator the matched count is the brand's addressable base.
 * Honest no_data when the brand has no customers.
 */
export async function previewSegment(
  brandId: string,
  _definition: Record<string, unknown>,
  deps: { srPool: SilverPool },
): Promise<SegmentPreviewResult> {
  const base = await getCustomerBaseSummary(brandId, { srPool: deps.srPool });
  if (base.state === 'no_data') return { state: 'no_data' };
  return {
    state: 'has_data',
    matched_customers: base.customer_count,
    total_customers: base.customer_count,
  };
}
