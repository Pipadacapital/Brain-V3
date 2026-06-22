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
  /**
   * Reverse markAutoInstalled: clear installed_at + the auto-install provider/ref so the UI reflects
   * "not installed". Idempotent; custom_ingest_host is preserved. RLS-scoped to the brand.
   */
  clearAutoInstall(brandId: string): Promise<void>;
  /**
   * Set (or clear, with null) the brand's first-party CNAME ingest host. Returns the updated
   * installation, or null if no installation exists for the brand. RLS-scoped to the brand.
   */
  setCustomIngestHost(brandId: string, host: string | null): Promise<PixelInstallation | null>;
}
