// SPEC: B.3
/**
 * @brain/metric-engine — computeIdentityEvidence (the B.3 trace explainability surface).
 *
 * For ONE resolved customer (brain_id), the set of hashed identifiers that resolve to it and
 * WHEN each was first seen — the "why is this touchpoint attributed to this person" evidence the
 * `GET /v1/journeys/trace` endpoint attaches per resolved journey. Read over the sanctioned
 * bi-temporal identity map serving projection (brain_serving.mv_silver_identity_map — a thin
 * projection of iceberg.brain_silver.silver_identity_map) through the brand-scoped seam
 * (withSilverBrand injects brand_id = ? — I-ST01).
 *
 * PII: identifier_type is a TYPE label only (email/phone/anon/device/...), never the value; the
 * map stores identifier_hash (64-hex) only — this read NEVER selects the hash. Honest-empty when
 * the customer has no mapping rows (or the serving tier is cold — the seam degrades to []).
 *
 * `source` provenance: the serving map has no first-seeing-connector column, so source is the
 * resolution provenance = 'silver_identity_map' (the deterministic identity SoR projection).
 * When a mapping carries a merge_event_id the row was folded by a merge → source 'merge'. This
 * is honest evidence of HOW the identifier reached the person, additive to the identifier_type +
 * first_seen; a per-connector origin is a future enrichment (a new column on the map, not here).
 *
 * @see db/trino/views/mv_silver_identity_map.sql (the served projection)
 * @see db/trino/views/identity_current_v.sql (the current-only sanctioned accessor)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface IdentityEvidenceRow {
  /** The identifier TYPE (email/phone/anon/device/...). NEVER the value. */
  identifierType: string;
  /** First effective_from across this identifier's intervals (UTC timestamp string). */
  firstSeen: string;
  /** Resolution provenance: 'merge' when folded by an identity merge, else 'silver_identity_map'. */
  source: string;
}

export interface IdentityEvidenceResult {
  /** True iff the customer has ANY identity-map rows (honest no_data). */
  hasData: boolean;
  /** One row per identifier_type, oldest first_seen first. */
  evidence: IdentityEvidenceRow[];
}

/** Null-safe string. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

interface EvidenceDbRow {
  identifier_type: string;
  first_seen: string;
  has_merge: number | boolean;
}

/**
 * computeIdentityEvidence — the per-customer identity evidence for the journey-trace surface.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (srPool).
 * @param brainId - the resolved customer key whose identifiers to explain.
 */
export async function computeIdentityEvidence(
  brandId: string,
  deps: { srPool: SilverPool },
  brainId: string,
): Promise<IdentityEvidenceResult> {
  if (!brainId || brainId.length === 0) {
    return { hasData: false, evidence: [] };
  }

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // One row per identifier_type: earliest effective_from + whether ANY interval carried a
    // merge_event_id. ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally
    // (brainId binds first). identifier_hash is NEVER selected (hash-only PII rule).
    return scope.runScoped<EvidenceDbRow>(
      `SELECT identifier_type,
              MIN(effective_from) AS first_seen,
              MAX(CASE WHEN merge_event_id IS NOT NULL THEN 1 ELSE 0 END) AS has_merge
         FROM brain_serving.mv_silver_identity_map
        WHERE brain_id = ?
          AND ${BRAND_PREDICATE}
        GROUP BY identifier_type
        ORDER BY first_seen ASC`,
      [brainId],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, evidence: [] };
  }

  const evidence: IdentityEvidenceRow[] = rows.map((r) => ({
    identifierType: String(r.identifier_type),
    firstSeen: String(r.first_seen),
    source: r.has_merge === true || r.has_merge === 1 ? 'merge' : 'silver_identity_map',
  }));

  return { hasData: true, evidence: evidence.filter((e) => str(e.identifierType) !== null) };
}
