/**
 * IPixelStatusRepository — domain repository interface.
 */
import type { PixelStatus } from '../entities/PixelStatus.js';

export interface IPixelStatusRepository {
  findByInstallationId(
    pixelInstallationId: string,
    brandId: string,
  ): Promise<PixelStatus | null>;

  findByBrandId(brandId: string): Promise<PixelStatus | null>;

  save(status: PixelStatus): Promise<PixelStatus>;
  update(status: PixelStatus): Promise<PixelStatus>;
}
