/**
 * IPixelInstallationRepository — domain repository interface.
 */
import type { PixelInstallation } from '../entities/PixelInstallation.js';

export interface IPixelInstallationRepository {
  findByBrandId(brandId: string): Promise<PixelInstallation | null>;
  findById(id: string, brandId: string): Promise<PixelInstallation | null>;
  save(installation: PixelInstallation): Promise<PixelInstallation>;
  update(installation: PixelInstallation): Promise<PixelInstallation>;
}
