/**
 * VerifyPixelCommand — performs a REAL backend HTTP HEAD/GET check for pixel installation.
 *
 * This is NOT a simulation. The command fetches the brand's target_host over HTTP
 * and checks whether the Brain pixel snippet is present (install_token in the HTML).
 *
 * Status written to pixel_status reflects the ACTUAL result. (§8 Demo 5 criterion).
 *
 * Emits pixel.verified event on success.
 *
 * Note: For M1, first-signal status is read from pixel_status (set here on verify).
 * The full brain.js ingestion pipeline is M1-data-spine (separate run).
 */
import type { IPixelInstallationRepository } from '../../domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../domain/repositories/IPixelStatusRepository.js';

export interface VerifyPixelInput {
  brandId: string;
  idempotencyKey: string;
}

export interface VerifyPixelResult {
  verified: boolean;
  state: 'connected' | 'error' | 'waiting_for_data';
  message: string;
}

export class PixelInstallationNotFoundError extends Error {
  constructor(brandId: string) {
    super(`Pixel installation not found for brand ${brandId}. Call GET /pixel/installation first.`);
    this.name = 'PixelInstallationNotFoundError';
  }
}

/**
 * Port: authoritative presence check for an auto-installed (ScriptTag) pixel, via the storefront's own
 * admin API (e.g. Shopify listScriptTags). Returns { present } when the brand has a connected
 * auto-install storefront, or null when not applicable (no connected storefront / can't check) — in
 * which case verify falls back to the public HTML check (manual-snippet installs). Injected by the
 * composition root so this command stays decoupled from any specific connector.
 */
export type AutoInstallPixelChecker = (
  brandId: string,
) => Promise<{ present: boolean; src: string | null } | null>;

export class VerifyPixelCommand {
  constructor(
    private readonly installationRepo: IPixelInstallationRepository,
    private readonly statusRepo: IPixelStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    /** Optional authoritative check for auto-installed (ScriptTag) pixels. */
    private readonly autoInstallCheck?: AutoInstallPixelChecker,
  ) {}

  async execute(input: VerifyPixelInput): Promise<VerifyPixelResult> {
    const { brandId, idempotencyKey } = input;

    // Load installation record
    const installation = await this.installationRepo.findByBrandId(brandId);
    if (!installation) {
      throw new PixelInstallationNotFoundError(brandId);
    }

    // Load or locate status record
    const existingStatus = await this.statusRepo.findByInstallationId(
      installation.id,
      brandId,
    );
    if (!existingStatus) {
      throw new Error(`[VerifyPixelCommand] pixel_status row missing for installation ${installation.id}`);
    }

    // ── Verification: authoritative auto-install check FIRST, then HTML fallback ──────────────
    // Auto-installed (Shopify ScriptTag) pixels are injected by the storefront's own JS loader, so
    // they NEVER appear in the static HTML — the public-HTML grep gives a false negative. When the
    // brand has a connected auto-install storefront, the admin API (listScriptTags) is authoritative.
    // For manual-snippet installs (no connected storefront), we fall back to the real HTML check.
    let verificationResult: { found: boolean; reason: string };
    const autoInstall = this.autoInstallCheck ? await this.autoInstallCheck(brandId) : null;
    if (autoInstall && autoInstall.present) {
      verificationResult = {
        found: true,
        reason: `Brain pixel ScriptTag is installed on ${installation.targetHost} (verified via the storefront admin API).`,
      };
    } else {
      // Fetch the target host and look for the install_token in the response HTML (manual snippet).
      const htmlResult = await this.checkPixelPresence(
        installation.targetHost,
        installation.installToken,
      );
      // If this brand auto-installs (ScriptTag) but no Brain tag was found, say so clearly.
      verificationResult =
        autoInstall && !autoInstall.present && !htmlResult.found
          ? { found: false, reason: `No Brain pixel ScriptTag found on ${installation.targetHost}. Click "Install on Shopify" to add it.` }
          : htmlResult;
    }

    if (verificationResult.found) {
      // Mark installation as verified
      const updatedInstallation = installation.installedAt
        ? installation
        : installation.markInstalled();
      if (!installation.installedAt) {
        await this.installationRepo.update(updatedInstallation);
      }

      // Mark pixel status as connected
      const updatedStatus = existingStatus.markVerified();
      await this.statusRepo.update(updatedStatus);

      // Emit pixel.verified event
      await this.emitEvent('pixel.verified', {
        brand_id: brandId,
        pixel_installation_id: installation.id,
        install_token: installation.installToken,
        target_host: installation.targetHost,
        idempotency_key: idempotencyKey,
      });

      return {
        verified: true,
        state: 'connected',
        message: `Pixel tag found on ${installation.targetHost}`,
      };
    } else {
      // Mark as error — pixel not detected
      const updatedStatus = existingStatus.markError(verificationResult.reason);
      await this.statusRepo.update(updatedStatus);

      return {
        verified: false,
        state: 'error',
        message: verificationResult.reason,
      };
    }
  }

  /**
   * Performs an HTTP HEAD/GET to the brand's target host and checks for the pixel tag.
   * This is a real network request (not mocked).
   *
   * C5 note: In local dev without a public domain, this will fail — expected.
   * The verify endpoint requires the brand's storefront to be accessible.
   */
  private async checkPixelPresence(
    targetHost: string,
    installToken: string,
  ): Promise<{ found: boolean; reason: string }> {
    // Construct URL — use HTTPS for all real targets.
    const url = `https://${targetHost}`;

    let responseText = '';
    let statusCode = 0;

    try {
      // Try HEAD first (faster)
      const headResp = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000), // 10s timeout
        headers: { 'User-Agent': 'Brain-Pixel-Verifier/1.0' },
      });
      statusCode = headResp.status;

      // For HEAD responses, we can't read the body — upgrade to GET
      const getResp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Brain-Pixel-Verifier/1.0' },
      });
      statusCode = getResp.status;
      responseText = await getResp.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        found: false,
        reason: `Failed to reach ${url}: ${message}`,
      };
    }

    if (statusCode < 200 || statusCode >= 400) {
      return {
        found: false,
        reason: `Target host returned HTTP ${statusCode}`,
      };
    }

    // Check if the install_token appears in the page (as embedded by the snippet)
    if (responseText.includes(installToken)) {
      return { found: true, reason: 'Pixel tag detected' };
    }

    return {
      found: false,
      reason: `Pixel tag (install_token: ${installToken}) not found on ${targetHost}. Ensure the snippet is added to the storefront <head>.`,
    };
  }
}
