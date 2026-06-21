/**
 * catalog.test.ts — the connector-provider gate (DB-free unit).
 *
 * Migration 0062 dropped the `connector_instance.provider` CHECK constraint; provider validity is now
 * enforced SOLELY in the app connect-gate (apps/core/src/main.ts POST /api/v1/connectors) against
 * CONNECTOR_CATALOG via getDefinition() + isConnectable() (ADR-CM-1: the catalog is the SoT, a code
 * const — not a DB table/CHECK). This test locks that gate so the validation the CHECK used to provide
 * cannot silently regress. Adding a connector = a CONNECTOR_CATALOG row, never a migration.
 */
import { describe, it, expect } from 'vitest';
import { CONNECTOR_CATALOG, getDefinition, isConnectable } from './index.js';

describe('connector catalog gate (sole provider-validity guard after the CHECK was dropped)', () => {
  it('getDefinition returns null for an unknown provider (→ connect endpoint 400)', () => {
    expect(getDefinition('definitely_not_a_real_provider')).toBeNull();
  });

  it('getDefinition resolves a known provider', () => {
    const def = getDefinition('shopify');
    expect(def).not.toBeNull();
    expect(def?.category).toBe('storefront');
  });

  it('isConnectable is false for a coming_soon provider (→ connect endpoint 422)', () => {
    const comingSoon = CONNECTOR_CATALOG.find((d) => d.availability === 'coming_soon');
    expect(comingSoon, 'catalog should have ≥1 coming_soon tile').toBeDefined();
    expect(isConnectable(comingSoon!)).toBe(false);
  });

  it('isConnectable is true for every available provider', () => {
    const available = CONNECTOR_CATALOG.filter((d) => d.availability === 'available');
    expect(available.length).toBeGreaterThan(0);
    for (const def of available) {
      expect(isConnectable(def), `${def.id} should be connectable`).toBe(true);
    }
  });

  it('catalog ids are unique (the registry key that replaces the provider CHECK enum)', () => {
    const ids = CONNECTOR_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
