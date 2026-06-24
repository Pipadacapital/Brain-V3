/**
 * InstallPixelCommand — the production pixel-install path: auto-inject the Brain pixel onto the
 * brand's connected Shopify storefront via the Admin API and flip pixel_installation.installed_at.
 * No manual snippet paste.
 *
 * Mechanism (feat-pixel-production-install): ScriptTag API now (online-store coverage, verifiable
 * with the existing OAuth token + write_script_tags scope). The Web Pixels API path (checkout +
 * storefront coverage) is laid in ShopifyAdminClient.webPixelCreate + extensions/brain-web-pixel,
 * activated once the app's web-pixel extension is deployed.
 *
 * Idempotent: if a Brain ScriptTag already points at our pixel asset, reuse it (no duplicate).
 * SECURITY: the Shopify token (from secretRef) is used only for the API call, never logged (I-S09).
 */
import type { ISecretsManager } from '@brain/connector-secrets';
import { log } from '../../../../../../../log.js';
import { ShopifyAdminClient, ShopifyApiError } from '../../infrastructure/api/ShopifyAdminClient.js';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { GetOrCreatePixelInstallationCommand } from '../../../../../pixel/application/commands/GetOrCreatePixelInstallationCommand.js';
import type { IPixelInstallationRepository } from '../../../../../pixel/domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../../../../pixel/domain/repositories/IPixelStatusRepository.js';

/** Stable error codes the route maps to HTTP + user-facing copy. */
export type InstallPixelErrorCode =
  | 'STOREFRONT_NOT_CONNECTED'
  | 'RECONNECT_REQUIRED'
  | 'RECONNECT_REQUIRED_SCOPE'
  | 'INGEST_NOT_HTTPS';

export class InstallPixelError extends Error {
  constructor(public readonly code: InstallPixelErrorCode, message: string) {
    super(message);
    this.name = 'InstallPixelError';
  }
}

/**
 * Defensive bare-hostname check before interpolating a brand's first-party CNAME into the ScriptTag
 * src. The value is already validated at write time (PATCH /pixel/ingest-host) — this is belt-and-
 * suspenders against a malformed stored host reaching Shopify.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface InstallPixelInput {
  brandId: string;
  idempotencyKey: string;
}

export interface InstallPixelResult {
  installed: true;
  provider: 'shopify_script_tag';
  /** Shopify ScriptTag id (provider-side handle). */
  ref: string;
  installToken: string;
  /** The injected pixel src (no secrets). */
  src: string;
  /** True when a Brain ScriptTag was already present (idempotent re-run). */
  alreadyPresent: boolean;
  /**
   * Checkout (Web Pixel) coverage outcome — set by the best-effort webPixelCreate. The ScriptTag
   * (above) covers the online store; the Web Pixel adds CHECKOUT. The UI surfaces this so the merchant
   * sees whether checkout tracking is live, or what one-time step unblocks it.
   *   enabled   — the Web Pixel registered (or was already registered): checkout tracking is live.
   *   pending   — needs a one-time Shopify-side step (deploy the app extension / reconnect for
   *               write_pixels); the ScriptTag (storefront) keeps working meanwhile.
   */
  webPixel: { status: 'enabled' | 'pending'; message: string };
}

export class InstallPixelCommand {
  constructor(
    private readonly connectorInstanceRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly getOrCreateInstallation: GetOrCreatePixelInstallationCommand,
    private readonly pixelInstallationRepo: IPixelInstallationRepository,
    private readonly pixelStatusRepo: IPixelStatusRepository,
    private readonly ingestBaseUrl: string,
    /** Injectable for tests; defaults to the real Admin client. */
    private readonly makeClient: (shopDomain: string, token: string) => ShopifyAdminClient = (d, t) =>
      new ShopifyAdminClient(d, t),
  ) {}

  async execute(input: InstallPixelInput): Promise<InstallPixelResult> {
    const { brandId, idempotencyKey } = input;

    // 1. The brand must have a CONNECTED Shopify storefront (the pixel injects onto it).
    const conn = await this.connectorInstanceRepo.findByBrandAndProvider(brandId, 'shopify');
    if (!conn || conn.status !== 'connected') {
      throw new InstallPixelError(
        'STOREFRONT_NOT_CONNECTED',
        'Connect a Shopify storefront before auto-installing the pixel.',
      );
    }

    // 2. Resolve the OAuth token (I-S09: never logged).
    const token = await this.secretsManager.getShopifyToken(conn.secretRef);
    if (!token) {
      throw new InstallPixelError(
        'RECONNECT_REQUIRED',
        'Shopify token missing — reconnect the storefront and try again.',
      );
    }

    // 3. Ensure the pixel installation exists → install_token (idempotent on brand_id).
    const inst = await this.getOrCreateInstallation.execute({
      brandId,
      targetHost: conn.shopDomain,
      idempotencyKey,
    });

    // 4. Per-brand tokenized src — the ScriptTag-injected asset self-configures from the query
    //    string (no window.__brain available when injected by a ScriptTag).
    // Shopify REQUIRES the ScriptTag src to be HTTPS (and it must be publicly reachable by the
    // storefront browser to actually fire). Prefer the brand's configured first-party CNAME ingest
    // host (always HTTPS) when set — that lets a brand auto-install without a global HTTPS ingest URL,
    // and serves the pixel first-party (ITP/ad-blocker resilient). The stored host is already
    // validated at write time (PATCH /pixel/ingest-host); a defensive check guards the interpolation.
    const installation = await this.pixelInstallationRepo.findByBrandId(brandId);
    const cname = installation?.customIngestHost ?? null;
    const ingestBase =
      cname && HOSTNAME_RE.test(cname) ? `https://${cname}` : this.ingestBaseUrl;

    if (!ingestBase.startsWith('https://')) {
      throw new InstallPixelError(
        'INGEST_NOT_HTTPS',
        'Shopify needs a public HTTPS pixel URL. Either set a first-party domain (Tracking Center → ' +
          'First-party domain, a CNAME to Brain) or set PIXEL_INGEST_BASE_URL to an HTTPS host — a ' +
          'tunnel locally (e.g. `pnpm dev:tunnel`) or your CNAME in prod — then retry.',
      );
    }
    const src = `${ingestBase}/pixel.js?t=${inst.installToken}&b=${brandId}`;

    // 5/6. Idempotency + RE-POINT: reuse an existing Brain ScriptTag ONLY if its src already matches
    //      the desired src; otherwise delete the stale tag(s) and create a fresh one. Without this, a
    //      ScriptTag created against an old ingest URL (e.g. a previous tunnel) would never be updated,
    //      so the storefront keeps loading a dead pixel URL. We match on the exact src.
    const client = this.makeClient(conn.shopDomain, token);
    let ref: string;
    let alreadyPresent = false;
    try {
      const brainTags = (await client.listScriptTags()).filter((s) => s.src.includes('/pixel.js'));
      const current = brainTags.find((s) => s.src === src);
      if (current) {
        ref = String(current.id);
        alreadyPresent = true;
      } else {
        // Remove any stale Brain ScriptTag(s) pointing at a different src, then create the fresh one.
        for (const stale of brainTags) {
          await client.deleteScriptTag(stale.id);
        }
        const created = await client.createScriptTag(src);
        ref = String(created.id);
      }
    } catch (err) {
      if (err instanceof ShopifyApiError && (err.status === 403 || err.status === 401)) {
        throw new InstallPixelError(
          'RECONNECT_REQUIRED_SCOPE',
          'Reconnect Shopify to grant pixel-install permission (write_script_tags), then retry.',
        );
      }
      // Shopify rejects a non-HTTPS / unreachable src with 422 — surface the actionable guidance.
      if (err instanceof ShopifyApiError && err.status === 422) {
        throw new InstallPixelError(
          'INGEST_NOT_HTTPS',
          'Shopify rejected the pixel URL (must be public HTTPS). Set PIXEL_INGEST_BASE_URL to an HTTPS ' +
            'host — a tunnel locally (`pnpm dev:tunnel`) or your CNAME in prod — then retry.',
        );
      }
      throw err;
    }

    // 7. Flip installed_at + record the provider handle (idempotent — keeps original install time).
    await this.pixelInstallationRepo.markAutoInstalled(brandId, 'shopify_script_tag', ref);

    // 7.5. ALSO register the Web Pixel — the ScriptTag covers the online store but NOT checkout (a
    //      separate origin), so checkout_started/completed (the funnel checkout stage + the journey→
    //      order stitch) need the sandboxed Web Pixels API. BEST-EFFORT + NON-FATAL: it requires the
    //      `brain-web-pixel` extension deployed (`shopify app deploy`) AND the write_pixels scope
    //      (reconnect). When either is missing, webPixelCreate fails and we log + keep the working
    //      ScriptTag install. An "already taken" userError on re-run is success (idempotent).
    //      See docs/runbooks/enable-shopify-checkout-pixel.md.
    let webPixel: InstallPixelResult['webPixel'] = {
      status: 'pending',
      message: 'Checkout tracking pending — see below.',
    };
    try {
      const wp = await client.webPixelCreate({
        install_token: inst.installToken,
        brand_id: brandId,
        ingest_base_url: ingestBase,
      });
      webPixel = { status: 'enabled', message: 'Checkout tracking is live (Web Pixel registered).' };
      log.info(
        `[InstallPixelCommand] web pixel registered (checkout coverage) brand=${brandId} id=${wp.id} shop=${conn.shopDomain}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already|taken/i.test(msg)) {
        webPixel = { status: 'enabled', message: 'Checkout tracking is live (Web Pixel already registered).' };
        log.info(`[InstallPixelCommand] web pixel already registered brand=${brandId} shop=${conn.shopDomain}`);
      } else if (/403|401|scope|access|pixel/i.test(msg)) {
        webPixel = {
          status: 'pending',
          message: 'Reconnect Shopify to grant the write_pixels scope, then re-run install to enable checkout tracking.',
        };
        log.warn(`[InstallPixelCommand] web pixel needs write_pixels (reconnect) brand=${brandId}: ${msg}`);
      } else {
        webPixel = {
          status: 'pending',
          message: 'Checkout tracking needs a one-time setup: deploy the brain-web-pixel app extension (shopify app deploy). The storefront pixel is active meanwhile.',
        };
        log.warn(`[InstallPixelCommand] web pixel not registered (deploy extension) brand=${brandId}: ${msg}`);
      }
    }

    // 8. We verifiably placed the pixel → mark the status verified/connected for the UI.
    const status = await this.pixelStatusRepo.findByInstallationId(inst.installationId, brandId);
    if (status) await this.pixelStatusRepo.update(status.markVerified());

    log.info(
      `[InstallPixelCommand] pixel auto-installed brand=${brandId} provider=shopify_script_tag ` +
        `ref=${ref} alreadyPresent=${alreadyPresent} shop=${conn.shopDomain}`,
    );
    return { installed: true, provider: 'shopify_script_tag', ref, installToken: inst.installToken, src, alreadyPresent, webPixel };
  }
}
