/**
 * AssembleIdentityTimelineUseCase — read-side: build a brain_id's chronological identity history.
 *
 * Thin application orchestration: pull the (brand+brain scoped) timeline records from the
 * `IdentityTimelineSource` port (an adapter over the identity_audit decision log) and run the pure
 * `buildIdentityTimeline` projection (sort + sequence). brand_id is supplied by the caller (never a
 * request body) — tenant(brand_id)-first. Hash-only (I-S02): records carry identifier TYPES + the
 * structured hash-only identifier_combo, never raw PII.
 */
import { buildIdentityTimeline, type IdentityTimeline, type IdentityTimelineSource } from '../domain/identity/IdentityTimeline.js';

export class AssembleIdentityTimelineUseCase {
  constructor(private readonly source: IdentityTimelineSource) {}

  async execute(brandId: string, brainId: string): Promise<IdentityTimeline> {
    const records = await this.source.readTimelineRecords(brandId, brainId);
    return buildIdentityTimeline(brandId, brainId, records);
  }
}
