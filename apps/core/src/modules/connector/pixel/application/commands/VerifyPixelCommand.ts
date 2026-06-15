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

export class VerifyPixelCommand {
  constructor(
    private readonly installationRepo: IPixelInstallationRepository,
    private readonly statusRepo: IPixelStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
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

    // ── REAL backend HTTP check ──────────────────────────────────────────────
    // Fetch the target host and look for the install_token in the response HTML.
    const verificationResult = await this.checkPixelPresence(
      installation.targetHost,
      installation.installToken,
    );

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
