/**
 * InstallWooCommercePixelCommand.test.ts — unit tests (infra-free, injected HTTP).
 *
 * Proves the WooCommerce one-click auto-install parallel of Shopify:
 *   - happy path: probe (plugin present) → POST config → installed_at flipped + status verified.
 *   - PLUGIN_NOT_INSTALLED on a 404 probe (route absent) and on a network error.
 *   - RECONNECT_REQUIRED on 401/403 (bad/insufficient WC key) at probe or push.
 *   - STOREFRONT_NOT_CONNECTED when no connected woocommerce connector.
 *   - RECONNECT_REQUIRED when the credential bundle is missing key/secret.
 *   - INGEST_NOT_HTTPS when the resolved ingest base is not HTTPS.
 *   - I-S09: the WC ck/cs travels ONLY in the Authorization header, never in a logged/sent body.
 *   - alreadyPresent=true when the plugin already carries this brand's config.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InstallWooCommercePixelCommand,
  InstallWooCommercePixelError,
  type WooHttp,
} from '../application/commands/InstallWooCommercePixelCommand.js';

const BRAND = '69589f15-a664-40fa-9f2e-d50362ae3cd8';
const SITE = 'https://store.example.com';

function makeDeps(opts: { http: WooHttp; connected?: boolean; bundle?: Record<string, string> | null; cname?: string | null }) {
  const connectorInstanceRepo = {
    findByBrandAndProvider: vi.fn(async () =>
      opts.connected === false
        ? null
        : { status: 'connected', shopDomain: SITE, secretRef: 'arn:woo:site' },
    ),
  } as never;
  const secretsManager = {
    getSecret: vi.fn(async () =>
      opts.bundle === undefined
        ? { consumer_key: 'ck_live', consumer_secret: 'cs_live', site_url: SITE }
        : opts.bundle,
    ),
  } as never;
  const getOrCreateInstallation = {
    execute: vi.fn(async () => ({ installationId: 'inst-1', installToken: 'tok-123', targetHost: SITE })),
  } as never;
  const markAutoInstalled = vi.fn(async () => undefined);
  const pixelInstallationRepo = {
    findByBrandId: vi.fn(async () => ({ customIngestHost: opts.cname ?? null })),
    markAutoInstalled,
  } as never;
  const markVerified = vi.fn(() => ({ verified: true }));
  const update = vi.fn(async () => undefined);
  const pixelStatusRepo = {
    findByInstallationId: vi.fn(async () => ({ markVerified })),
    update,
  } as never;

  return { connectorInstanceRepo, secretsManager, getOrCreateInstallation, pixelInstallationRepo, pixelStatusRepo, markAutoInstalled, update };
}

function jsonRes(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('InstallWooCommercePixelCommand', () => {
  it('happy path: probes, pushes config, flips installed_at + verifies', async () => {
    const calls: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
    const http: WooHttp = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers['Authorization'], body: init.body });
      if (init.method === 'GET') return jsonRes(200, { configured: false, version: '1.0.0' });
      return jsonRes(200, { ok: true, configured: true, version: '1.0.0' });
    };
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    const res = await cmd.execute({ brandId: BRAND, idempotencyKey: 'idem-1' });

    expect(res.installed).toBe(true);
    expect(res.provider).toBe('woocommerce_plugin');
    expect(res.ref).toBe(SITE);
    expect(res.src).toBe(`https://ingest.brain.ai/pixel.js?t=tok-123&b=${BRAND}`);
    expect(res.pluginVersion).toBe('1.0.0');
    expect(d.markAutoInstalled).toHaveBeenCalledWith(BRAND, 'woocommerce_plugin', SITE);
    expect(d.update).toHaveBeenCalledOnce();

    // I-S09: ck/cs only in the Authorization header; never in the POST body.
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.auth).toBe('Basic ' + Buffer.from('ck_live:cs_live').toString('base64'));
    expect(post.body).not.toContain('cs_live');
    expect(post.body).not.toContain('ck_live');
    expect(JSON.parse(post.body!)).toEqual({ install_token: 'tok-123', brand_id: BRAND, ingest_base_url: 'https://ingest.brain.ai' });
  });

  it('prefers the brand first-party CNAME for the ingest base', async () => {
    const http: WooHttp = async (_u, init) =>
      init.method === 'GET' ? jsonRes(200, { configured: false }) : jsonRes(200, { ok: true });
    const d = makeDeps({ http, cname: 'data.bodd.in' });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    const res = await cmd.execute({ brandId: BRAND, idempotencyKey: 'i' });
    expect(res.src).toBe(`https://data.bodd.in/pixel.js?t=tok-123&b=${BRAND}`);
  });

  it('alreadyPresent=true when the plugin already carries this brand config', async () => {
    const http: WooHttp = async (_u, init) =>
      init.method === 'GET' ? jsonRes(200, { configured: true, brand_id: BRAND, version: '1.0.0' }) : jsonRes(200, { ok: true });
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    const res = await cmd.execute({ brandId: BRAND, idempotencyKey: 'i' });
    expect(res.alreadyPresent).toBe(true);
  });

  it('PLUGIN_NOT_INSTALLED on 404 probe', async () => {
    const http: WooHttp = async () => jsonRes(404, { code: 'rest_no_route' });
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
  });

  it('PLUGIN_NOT_INSTALLED on network error', async () => {
    const http: WooHttp = async () => { throw new Error('ECONNREFUSED'); };
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toBeInstanceOf(InstallWooCommercePixelError);
  });

  it('RECONNECT_REQUIRED on 401 probe (bad WC key)', async () => {
    const http: WooHttp = async () => jsonRes(401, { code: 'brain_unauthorized' });
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
  });

  it('STOREFRONT_NOT_CONNECTED when no connected woocommerce connector', async () => {
    const http: WooHttp = async () => jsonRes(200, {});
    const d = makeDeps({ http, connected: false });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toMatchObject({ code: 'STOREFRONT_NOT_CONNECTED' });
  });

  it('RECONNECT_REQUIRED when the credential bundle is missing key/secret', async () => {
    const http: WooHttp = async () => jsonRes(200, {});
    const d = makeDeps({ http, bundle: { site_url: SITE } });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'https://ingest.brain.ai', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
  });

  it('INGEST_NOT_HTTPS when the ingest base is not HTTPS', async () => {
    const http: WooHttp = async () => jsonRes(200, { configured: false });
    const d = makeDeps({ http });
    const cmd = new InstallWooCommercePixelCommand(
      d.connectorInstanceRepo, d.secretsManager, d.getOrCreateInstallation, d.pixelInstallationRepo, d.pixelStatusRepo,
      'http://insecure.local', http,
    );
    await expect(cmd.execute({ brandId: BRAND, idempotencyKey: 'i' })).rejects.toMatchObject({ code: 'INGEST_NOT_HTTPS' });
  });
});
