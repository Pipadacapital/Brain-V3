/**
 * IPixelInstallationRepository — domain repository interface.
 */
import type { PixelInstallation } from '../entities/PixelInstallation.js';

export interface IPixelInstallationRepository {
  findByBrandId(brandId: string): Promise<PixelInstallation | null>;
  findById(id: string, brandId: string): Promise<PixelInstallation | null>;
  save(installation: PixelInstallation): Promise<PixelInstallation>;
  update(installation: PixelInstallation): Promise<PixelInstallation>;
  /**
   * Record a successful auto-injection (production install path) and flip installed_at.
   * Idempotent: installed_at is preserved if already set (re-install keeps the first time).
   * @param provider 'shopify_script_tag' | 'shopify_web_pixel'
   * @param ref       provider-side handle (Shopify ScriptTag id / Web Pixel id)
   */
  markAutoInstalled(brandId: string, provider: string, ref: string): Promise<void>;
}
