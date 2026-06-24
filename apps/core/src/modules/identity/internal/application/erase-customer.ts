/**
 * eraseCustomer — DPDP / GDPR right-to-deletion for one customer (P0-C).
 *
 * Delegates the privileged mutation to the SECURITY DEFINER `erase_customer(brand_id, brain_id)`
 * function (migration 0038): hard-delete the contact_pii vault rows, tombstone identity_link,
 * mark the customer 'erased', and write an identity_audit row (counts only — no raw PII).
 *
 * brandId is the caller's SESSION brand (never client-supplied). The function is scoped to
 * (brand_id, brain_id), so a brain_id belonging to another brand matches 0 rows → erased:false.
 * No raw PII is read or returned here.
 */
import type { Neo4jIdentityReader } from '../infrastructure/neo4j-identity-reader.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ErasureResult {
  erased: boolean;
  contact_pii_deleted: number;
  links_tombstoned: number;
}

// MEDALLION REALIGNMENT (Epic 3 / ADR-0004): erase tombstones the identifier edges + marks the customer
// 'erased' in the Neo4j SoR, and hard-deletes the contact_pii vault rows + writes the identity_audit row
// in PostgreSQL (both stay PG). Counts only — no raw PII read or returned.
export async function eraseCustomer(
  brandId: string,
  brainId: string,
  reader: Neo4jIdentityReader,
): Promise<ErasureResult> {
  if (!UUID_RE.test(brainId)) {
    return { erased: false, contact_pii_deleted: 0, links_tombstoned: 0 };
  }
  return reader.eraseCustomer(brandId, brainId);
}
