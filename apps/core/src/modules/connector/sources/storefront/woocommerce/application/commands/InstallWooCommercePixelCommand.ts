/**
 * InstallWooCommercePixelCommand — the WooCommerce parallel of Shopify's InstallPixelCommand:
 * one-click auto-install of the Brain Pixel onto a connected WooCommerce store, no merchant paste.
 *
 * Mechanism (see WooCommercePixelPlugin.ts for the WHY): WordPress has no remote ScriptTag API, so
 * the one-time step is activating the Brain Pixel plugin (the parallel of Shopify's OAuth app
 * authorization). After that, this command CONFIGURES the plugin in one click using the SAME WC
 * consumer key/secret the merchant already gave Brain at connect time:
 *
 *   1. Require a CONNECTED woocommerce connector + resolve its credential bundle.
 *   2. Ensure the pixel installation exists → install_token.
 *   3. Resolve the HTTPS ingest base (brand first-party CNAME preferred, else PIXEL_INGEST_BASE_URL).
 *   4. Probe GET <site>/wp-json/brain/v1/pixel (Basic ck:cs):
 *        404 / route-missing → PLUGIN_NOT_INSTALLED (UI offers the plugin download).
 *        401/403            → RECONNECT_REQUIRED (WC key invalid or lacks write).
 *   5. POST the config {install_token, brand_id, ingest_base_url} → plugin starts injecting.
 *   6. Flip installed_at (markAutoInstalled 'woocommerce_plugin') + mark status verified.
 *
 * SECURITY: the WC ck/cs (I-S09) is used only for these API calls, never logged. Only the
 * non-secret install token + brand id + ingest URL are sent to the store.
 */
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import { log } from '../../../../../../../log.js';
import type { GetOrCreatePixelInstallationCommand } from '../../../../../pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import type { IPixelInstallationRepository } from '../../../../../pixel/domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../../../../pixel/domain/repositories/IPixelStatusRepository.js';

/** Stable error codes the route maps to HTTP + user-facing copy. */
export type InstallWooCommercePixelErrorCode =
  | 'STOREFRONT_NOT_CONNECTED'
  | 'RECONNECT_REQUIRED'
  | 'PLUGIN_NOT_INSTALLED'
  | 'INGEST_NOT_HTTPS';

export class InstallWooCommercePixelError extends Error {
  constructor(public readonly code: InstallWooCommercePixelErrorCode, message: string) {
    super(message);
    this.name = 'InstallWooCommercePixelError';
  }
}

/** Defensive bare-hostname check before interpolating a brand's CNAME into the pixel src. */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface InstallWooCommercePixelInput {
  brandId: string;
  idempotencyKey: string;
}

export interface InstallWooCommercePixelResult {
  installed: true;
  provider: 'woocommerce_plugin';
  /** The WooCommerce site URL the pixel was configured on. */
  ref: string;
  installToken: string;
  /** The injected pixel src (no secrets). */
  src: string;
  /** True when the plugin already carried this exact config (idempotent re-run). */
  alreadyPresent: boolean;
  /** Plugin version reported by the store. */
  pluginVersion: string | null;
}

/** Minimal HTTP surface — injectable so tests don't hit the network. */
export type WooHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;

const defaultHttp: WooHttp = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, json: () => res.json() };
};

export class InstallWooCommercePixelCommand {
  constructor(
    private readonly connectorInstanceRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly getOrCreateInstallation: GetOrCreatePixelInstallationCommand,
    private readonly pixelInstallationRepo: IPixelInstallationRepository,
    private readonly pixelStatusRepo: IPixelStatusRepository,
    private readonly ingestBaseUrl: string,
    /** Injectable for tests; defaults to global fetch. */
    private readonly http: WooHttp = defaultHttp,
  ) {}

  async execute(input: InstallWooCommercePixelInput): Promise<InstallWooCommercePixelResult> {
    const { brandId, idempotencyKey } = input;

    // 1. Require a CONNECTED woocommerce storefront.
    const conn = await this.connectorInstanceRepo.findByBrandAndProvider(brandId, 'woocommerce');
    if (!conn || conn.status !== 'connected') {
      throw new InstallWooCommercePixelError(
        'STOREFRONT_NOT_CONNECTED',
        'Connect a WooCommerce store before auto-installing the pixel.',
      );
    }

    // 2. Resolve the credential bundle (I-S09: never logged).
    const bundle = await this.secretsManager.getSecret(conn.secretRef);
    const consumerKey = bundle?.['consumer_key'];
    const consumerSecret = bundle?.['consumer_secret'];
    const siteUrl = (bundle?.['site_url'] ?? conn.shopDomain ?? '').replace(/\/+$/, '');
    if (!consumerKey || !consumerSecret || !siteUrl) {
      throw new InstallWooCommercePixelError(
        'RECONNECT_REQUIRED',
        'WooCommerce credentials missing — reconnect the store and try again.',
      );
    }
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    // 3. Ensure the pixel installation exists → install_token (idempotent on brand_id).
    const inst = await this.getOrCreateInstallation.execute({
      brandId,
      targetHost: siteUrl,
      idempotencyKey,
    });

    // 4. HTTPS ingest base — brand first-party CNAME preferred (first-party, ITP-resilient).
    const installation = await this.pixelInstallationRepo.findByBrandId(brandId);
    const cname = installation?.customIngestHost ?? null;
    const ingestBase = cname && HOSTNAME_RE.test(cname) ? `https://${cname}` : this.ingestBaseUrl;
    if (!ingestBase.startsWith('https://')) {
      throw new InstallWooCommercePixelError(
        'INGEST_NOT_HTTPS',
        'A public HTTPS pixel URL is required. Set a first-party domain (Tracking Center → First-party ' +
          'domain) or PIXEL_INGEST_BASE_URL to an HTTPS host, then retry.',
      );
    }
    const src = `${ingestBase}/pixel.js?t=${inst.installToken}&b=${brandId}`;

    // 5. Probe the plugin presence + current config.
    const probeUrl = `${siteUrl}/wp-json/brain/v1/pixel`;
    let alreadyPresent = false;
    let pluginVersion: string | null = null;
    try {
      const probe = await this.http(probeUrl, {
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (probe.status === 401 || probe.status === 403) {
        throw new InstallWooCommercePixelError(
          'RECONNECT_REQUIRED',
          'WooCommerce rejected the API key (needs read/write). Reconnect the store, then retry.',
        );
      }
      if (probe.status === 404) {
        throw new InstallWooCommercePixelError(
          'PLUGIN_NOT_INSTALLED',
          'Install the Brain Pixel plugin on your WooCommerce store first (one-time): download it below, ' +
            'upload via Plugins → Add New → Upload, activate, then retry.',
        );
      }
      if (probe.ok) {
        const body = (await probe.json()) as { configured?: boolean; brand_id?: string | null; version?: string };
        pluginVersion = body?.version ?? null;
        alreadyPresent = body?.configured === true && body?.brand_id === brandId;
      }
    } catch (err) {
      if (err instanceof InstallWooCommercePixelError) throw err;
      // Network failure / non-JSON / route absent on a non-standard error → treat as plugin missing.
      throw new InstallWooCommercePixelError(
        'PLUGIN_NOT_INSTALLED',
        'Could not reach the Brain Pixel plugin on your WooCommerce store. Install + activate it ' +
          '(download below), then retry.',
      );
    }

    // 6. Push the config (idempotent — update_option overwrites).
    const post = await this.http(probeUrl, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ install_token: inst.installToken, brand_id: brandId, ingest_base_url: ingestBase }),
    });
    if (post.status === 401 || post.status === 403) {
      throw new InstallWooCommercePixelError(
        'RECONNECT_REQUIRED',
        'WooCommerce rejected the API key (needs read/write). Reconnect the store, then retry.',
      );
    }
    if (!post.ok) {
      throw new InstallWooCommercePixelError(
        'PLUGIN_NOT_INSTALLED',
        'The Brain Pixel plugin rejected the configuration. Update the plugin to the latest version and retry.',
      );
    }
    try {
      const body = (await post.json()) as { version?: string };
      if (body?.version) pluginVersion = body.version;
    } catch {
      /* response body optional */
    }

    // 7. Flip installed_at + record the provider handle (idempotent — keeps original install time).
    await this.pixelInstallationRepo.markAutoInstalled(brandId, 'woocommerce_plugin', siteUrl);

    // 8. We verifiably configured the pixel → mark the status verified for the UI.
    const status = await this.pixelStatusRepo.findByInstallationId(inst.installationId, brandId);
    if (status) await this.pixelStatusRepo.update(status.markVerified());

    log.info(
      `[InstallWooCommercePixelCommand] pixel auto-installed brand=${brandId} provider=woocommerce_plugin ` +
        `site=${siteUrl} alreadyPresent=${alreadyPresent} pluginVersion=${pluginVersion ?? 'unknown'}`,
    );
    return {
      installed: true,
      provider: 'woocommerce_plugin',
      ref: siteUrl,
      installToken: inst.installToken,
      src,
      alreadyPresent,
      pluginVersion,
    };
  }
}
