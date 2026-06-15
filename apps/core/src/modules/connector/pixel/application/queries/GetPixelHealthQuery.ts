/**
 * GetPixelHealthQuery — returns the current pixel installation + status for a brand.
 *
 * Data source: pixel_installation + pixel_status (Postgres only — §6.4).
 * Used by the dashboard "Data Status" widget.
 */
import type { IPixelInstallationRepository } from '../../domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../domain/repositories/IPixelStatusRepository.js';

export interface PixelHealthView {
  installed: boolean;
  installationId: string | null;
  installToken: string | null;
  targetHost: string | null;
  installedAt: string | null;
  state: 'connected' | 'syncing' | 'waiting_for_data' | 'error' | 'not_installed';
  verifiedAt: string | null;
  lastError: string | null;
}

export class GetPixelHealthQuery {
  constructor(
    private readonly installationRepo: IPixelInstallationRepository,
    private readonly statusRepo: IPixelStatusRepository,
  ) {}

  async execute(brandId: string): Promise<PixelHealthView> {
    const installation = await this.installationRepo.findByBrandId(brandId);
    if (!installation) {
      return {
        installed: false,
        installationId: null,
        installToken: null,
        targetHost: null,
        installedAt: null,
        state: 'not_installed',
        verifiedAt: null,
        lastError: null,
      };
    }

    const status = await this.statusRepo.findByInstallationId(installation.id, brandId);

    return {
      installed: installation.installedAt !== null,
      installationId: installation.id,
      installToken: installation.installToken,
      targetHost: installation.targetHost,
      installedAt: installation.installedAt?.toISOString() ?? null,
      state: status?.state ?? 'waiting_for_data',
      verifiedAt: status?.verifiedAt?.toISOString() ?? null,
      lastError: status?.lastError ?? null,
    };
  }
}
