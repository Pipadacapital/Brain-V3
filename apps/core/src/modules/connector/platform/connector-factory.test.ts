import { describe, it, expect } from 'vitest';
import { buildConnectorFactory } from './connector-factory.js';
import { ShopifyConnectorAdapter } from './ShopifyConnectorAdapter.js';

describe('connector platform factory (reference registration)', () => {
  it('resolves the Shopify reference connector by provider id', () => {
    const factory = buildConnectorFactory();
    expect(factory.has('shopify')).toBe(true);
    const connector = factory.resolve('shopify');
    expect(connector.provider).toBe('shopify');
    expect(connector).toBeInstanceOf(ShopifyConnectorAdapter);
  });

  it('validate() applies the Shopify host rule (NN-4) without side effects', async () => {
    const connector = buildConnectorFactory().resolve('shopify') as ShopifyConnectorAdapter;
    const bad = await connector.validate('brand-1', { shop: 'evil.example.com', code: 'c', state: 's' });
    expect(bad.valid).toBe(false);
    const good = await connector.validate('brand-1', { shop: 'acme.myshopify.com', code: 'c', state: 's' });
    expect(good.valid).toBe(true);
  });

  it('throws for an unregistered provider', () => {
    expect(() => buildConnectorFactory().resolve('hubspot')).toThrow(/No connector registered/);
  });
});
