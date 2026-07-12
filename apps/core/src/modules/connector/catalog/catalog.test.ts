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

  // ── Shopify generic per-brand connect (owner requirement 2026-07-12) ──────────
  // The catalog method is 'credential' (custom-app Client ID/Secret + store URL); the
  // authorization-code OAuth flow survives only as the env-gated fallback in writeRoutes.
  describe('shopify generic per-brand credential connect', () => {
    const shopify = getDefinition('shopify')!;

    it('connectMethod is credential', () => {
      expect(shopify.connectMethod).toBe('credential');
    });

    it('requires shop_domain + client_id + client_secret (all non-optional)', () => {
      const required = (shopify.authFields ?? []).filter((f) => !f.optional).map((f) => f.key);
      expect(required).toEqual(['shop_domain', 'client_id', 'client_secret']);
    });

    it('client_secret is the ONLY secret field (NN-2: goes to the Secrets Manager bundle)', () => {
      const secrets = (shopify.authFields ?? []).filter((f) => f.secret).map((f) => f.key);
      expect(secrets).toEqual(['client_secret']);
    });

    it('carries the custom-app how-to hint incl. the Admin API scopes', () => {
      const clientId = (shopify.authFields ?? []).find((f) => f.key === 'client_id');
      expect(clientId?.hint).toContain('Develop apps');
      expect(clientId?.hint).toContain('read_orders');
      expect(clientId?.hint).toContain('read_customers');
    });

    it('has NO generic credentialConnect spec (bespoke command handles the connect)', () => {
      expect(shopify.credentialConnect).toBeUndefined();
    });
  });

  // ── GA4 generic per-brand connect (GA4 rebuild, 2026-07-12) ───────────────────
  // Service-account JSON key + numeric property id; SA JWT-bearer grant server-side —
  // no OAuth redirect, no shared GOOGLE_CLIENT_ID env app.
  describe('ga4 generic per-brand credential connect', () => {
    const ga4 = getDefinition('ga4')!;

    it('connectMethod is credential (the oauth tile was never wired end-to-end)', () => {
      expect(ga4.connectMethod).toBe('credential');
      expect(ga4.availability).toBe('available');
    });

    it('requires property_id + service_account_json; currency_code is optional', () => {
      const required = (ga4.authFields ?? []).filter((f) => !f.optional).map((f) => f.key);
      expect(required).toEqual(['property_id', 'service_account_json']);
      const currency = (ga4.authFields ?? []).find((f) => f.key === 'currency_code');
      expect(currency?.optional).toBe(true);
    });

    it('service_account_json is the ONLY secret field (NN-2: goes to the Secrets Manager bundle)', () => {
      const secrets = (ga4.authFields ?? []).filter((f) => f.secret).map((f) => f.key);
      expect(secrets).toEqual(['service_account_json']);
    });

    it('carries the service-account how-to hint (create SA, grant Viewer on the property)', () => {
      const saField = (ga4.authFields ?? []).find((f) => f.key === 'service_account_json');
      expect(saField?.hint).toContain('service account');
      expect(saField?.hint).toContain('Viewer');
    });

    it('has NO generic credentialConnect spec (bespoke HandleGa4ConnectCommand handles the connect)', () => {
      expect(ga4.credentialConnect).toBeUndefined();
    });
  });
});
