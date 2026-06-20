/**
 * entitlements.api.v1.ts — readiness-driven progressive unlock contract (P2).
 *
 * The server's source of truth for what a brand can access given its data readiness: gated product
 * centers + connector-category eligibility. Connector-general (keyed on category, not per-app). The
 * web parses this so gating is server-driven, never hardcoded in the client. snake_case at the wire.
 */
import { z } from 'zod';

export const EntitlementEntrySchema = z.object({
  /** Center key (identity|journey|attribution|decision) or connector category (storefront|ads|…). */
  key: z.string(),
  /** True → unlocked/usable. False → locked until the requirement is met. */
  eligible: z.boolean(),
  /** Why it's locked (null when eligible). */
  reason: z.string().nullable(),
  /** What the brand must do to unlock it (null when eligible). */
  unlock_hint: z.string().nullable(),
});
export type EntitlementEntry = z.infer<typeof EntitlementEntrySchema>;

export const EntitlementsSchema = z.object({
  centers: z.array(EntitlementEntrySchema),
  connector_categories: z.array(EntitlementEntrySchema),
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;
