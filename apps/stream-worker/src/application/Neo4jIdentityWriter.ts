/**
 * Neo4jIdentityWriter — writes the customer identity graph to Neo4j off Bronze (re-platform Phase D tail).
 *
 * The Neo4j analogue of ResolveIdentityUseCase's PG write: it reuses the EXACT identifier extraction +
 * per-brand salted hashing (@brain/identity-core) so the hashes are byte-identical to the PG path
 * (rebuild-from-Bronze parity), then resolves/stitches a brain_id in the graph (@brain/identity-graph).
 * Raw PII is hashed at this boundary and never stored. Idempotent: replaying an event yields the same
 * brain_id. Async off Bronze — never a synchronous edge gate.
 */
import { IdentityGraph, type HashedIdentifier, type ResolveResult } from '@brain/identity-graph';
import { hashIdentifier, normalizePhone, normalizeIdentifier } from '@brain/identity-core';

function strProp(props: Record<string, unknown>, key: string): string | null {
  const v = props[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export class Neo4jIdentityWriter {
  constructor(private readonly graph: IdentityGraph) {}

  /**
   * Extract → hash → resolve a brain_id for one Bronze event's properties.
   * Identical extraction/hashing to ResolveIdentityUseCase (email/$email, phone/phone_number/$phone,
   * customer_id/storefront_customer_id) so graph hashes match the PG path exactly.
   */
  async resolveFromProperties(
    brandId: string,
    props: Record<string, unknown>,
    saltHex: string,
    regionCode: string,
  ): Promise<ResolveResult> {
    const identifiers: HashedIdentifier[] = [];

    const rawEmail = strProp(props, 'email') ?? strProp(props, '$email');
    if (rawEmail) {
      identifiers.push({ type: 'email', hash: hashIdentifier(rawEmail, 'email', saltHex, regionCode) });
    }

    const rawPhone =
      strProp(props, 'phone') ?? strProp(props, 'phone_number') ?? strProp(props, '$phone');
    if (rawPhone) {
      const { normalized } = normalizePhone(rawPhone, regionCode);
      identifiers.push({ type: 'phone', hash: hashIdentifier(normalized, 'phone', saltHex, regionCode) });
    }

    const custId = strProp(props, 'customer_id') ?? strProp(props, 'storefront_customer_id');
    if (custId) {
      const normalized = normalizeIdentifier(custId, 'external_id', regionCode);
      identifiers.push({ type: 'external_id', hash: hashIdentifier(normalized, 'external_id', saltHex, regionCode) });
    }

    return this.graph.resolve(brandId, identifiers);
  }
}

export { IdentityGraph };
