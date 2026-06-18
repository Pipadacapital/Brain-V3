/**
 * GetOrCreatePixelInstallationCommand — returns or creates the pixel_installation for a brand.
 *
 * Idempotent: calling multiple times with the same brandId returns the same record.
 * Emits pixel.installed event on first creation.
 */
import { randomUUID } from 'node:crypto';
import { PixelInstallation } from '../../domain/entities/PixelInstallation.js';
import { PixelStatus } from '../../domain/entities/PixelStatus.js';
import type { IPixelInstallationRepository } from '../../domain/repositories/IPixelInstallationRepository.js';
import type { IPixelStatusRepository } from '../../domain/repositories/IPixelStatusRepository.js';

export interface GetOrCreateInstallationInput {
  brandId: string;
  /** Host to embed in the pixel snippet (from brand.domain). */
  targetHost: string;
  idempotencyKey: string;
}

export interface GetOrCreateInstallationResult {
  installationId: string;
  installToken: string;
  targetHost: string;
  isNew: boolean;
}

export class GetOrCreatePixelInstallationCommand {
  constructor(
    private readonly installationRepo: IPixelInstallationRepository,
    private readonly statusRepo: IPixelStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: GetOrCreateInstallationInput): Promise<GetOrCreateInstallationResult> {
    const { brandId, targetHost, idempotencyKey } = input;

    // Check for existing installation (idempotent on brand_id — UNIQUE(brand_id), 0007:26).
    const existing = await this.installationRepo.findByBrandId(brandId);
    if (existing) {
      // Edit-host-in-place (ADR-3): if the brand re-submits a DIFFERENT canonical
      // host (website edit), update target_host on the SAME row, keeping the SAME
      // install_token (the token is the stable per-brand tenant key; the host is a
      // mutable display/verify hint). Re-submitting the SAME host is a pure no-op.
      if (existing.targetHost !== targetHost) {
        const updatedEntity = PixelInstallation.create({
          id: existing.id,
          brandId: existing.brandId,
          installToken: existing.installToken,
          targetHost,
          installedAt: existing.installedAt,
          createdAt: existing.createdAt,
          updatedAt: new Date(),
        });
        const saved = await this.installationRepo.update(updatedEntity);
        return {
          installationId: saved.id,
          installToken: saved.installToken,
          targetHost: saved.targetHost,
          isNew: false,
        };
      }
      return {
        installationId: existing.id,
        installToken: existing.installToken,
        targetHost: existing.targetHost,
        isNew: false,
      };
    }

    // Create new installation record
    const now = new Date();
    const installationId = randomUUID();
    const installation = PixelInstallation.create({
      id: installationId,
      brandId,
      installToken: randomUUID(), // per-brand tag identifier (public, not secret)
      targetHost,
      installedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const saved = await this.installationRepo.save(installation);

    // Create pixel_status row (waiting_for_data initially)
    const status = PixelStatus.create({
      id: randomUUID(),
      brandId,
      pixelInstallationId: saved.id,
      state: 'waiting_for_data',
      verifiedAt: null,
      lastError: null,
      updatedAt: now,
    });
    await this.statusRepo.save(status);

    // Emit pixel.installed event
    await this.emitEvent('pixel.installed', {
      brand_id: brandId,
      pixel_installation_id: saved.id,
      install_token: saved.installToken,
      target_host: saved.targetHost,
      idempotency_key: idempotencyKey,
    });

    return {
      installationId: saved.id,
      installToken: saved.installToken,
      targetHost: saved.targetHost,
      isNew: true,
    };
  }
}
