/**
 * PixelInstallerRegistry.test.ts — the storefront-extensibility contract.
 *
 * Proves a NEW storefront is added by registering ONE installer, with no change to existing ones:
 *   - register/get/list round-trip.
 *   - duplicate provider registration throws (no silent shadowing).
 *   - describeForBrand resolves per-brand availability + uninstall support, and a throwing
 *     isAvailable degrades to available=false (never breaks the listing).
 *   - install options are connected-storefront-driven (available mirrors isAvailable).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PixelInstallerRegistry,
  type PixelInstaller,
} from '../application/install/PixelInstaller.js';

function fakeInstaller(provider: string, opts: { available: boolean; withUninstall?: boolean; throwsAvail?: boolean }): PixelInstaller {
  const base: PixelInstaller = {
    provider,
    displayName: provider.toUpperCase(),
    isAvailable: opts.throwsAvail ? vi.fn(async () => { throw new Error('boom'); }) : vi.fn(async () => opts.available),
    install: vi.fn(async () => ({ installed: true, provider, ref: 'r', installToken: 't', src: 's', alreadyPresent: false })),
  };
  if (opts.withUninstall) {
    base.uninstall = vi.fn(async () => ({ removed: true, provider, alreadyAbsent: false }));
  }
  return base;
}

describe('PixelInstallerRegistry', () => {
  it('registers, gets, and lists installers', () => {
    const reg = new PixelInstallerRegistry()
      .register(fakeInstaller('shopify', { available: true, withUninstall: true }))
      .register(fakeInstaller('woocommerce', { available: false }));
    expect(reg.get('shopify')?.provider).toBe('shopify');
    expect(reg.get('woocommerce')?.provider).toBe('woocommerce');
    expect(reg.get('bigcommerce')).toBeUndefined();
    expect(reg.list().map((i) => i.provider).sort()).toEqual(['shopify', 'woocommerce']);
  });

  it('throws on duplicate provider registration (no silent shadowing)', () => {
    const reg = new PixelInstallerRegistry().register(fakeInstaller('shopify', { available: true }));
    expect(() => reg.register(fakeInstaller('shopify', { available: true }))).toThrow(/already registered/);
  });

  it('describeForBrand reports availability + uninstall support, connected-storefront-driven', async () => {
    const reg = new PixelInstallerRegistry()
      .register(fakeInstaller('shopify', { available: true, withUninstall: true }))
      .register(fakeInstaller('woocommerce', { available: false }));
    const desc = await reg.describeForBrand('brand-1');
    const shop = desc.find((d) => d.provider === 'shopify')!;
    const woo = desc.find((d) => d.provider === 'woocommerce')!;
    expect(shop).toMatchObject({ available: true, supportsUninstall: true, displayName: 'SHOPIFY' });
    expect(woo).toMatchObject({ available: false, supportsUninstall: false });
  });

  it('a throwing isAvailable degrades to available=false (listing never breaks)', async () => {
    const reg = new PixelInstallerRegistry().register(fakeInstaller('flaky', { available: true, throwsAvail: true }));
    const desc = await reg.describeForBrand('brand-1');
    expect(desc[0]!.available).toBe(false);
  });

  it('extensibility: a brand-new storefront installer is usable immediately, others untouched', async () => {
    const reg = new PixelInstallerRegistry()
      .register(fakeInstaller('shopify', { available: true }))
      .register(fakeInstaller('woocommerce', { available: true }));
    // Add a future platform — no edit to shopify/woocommerce installers required.
    reg.register(fakeInstaller('bigcommerce', { available: true, withUninstall: true }));
    const out = await reg.get('bigcommerce')!.install({ brandId: 'b', idempotencyKey: 'i' });
    expect(out.provider).toBe('bigcommerce');
    expect(reg.list()).toHaveLength(3);
  });
});
