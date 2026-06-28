/**
 * brand.api.v1 — Zod contracts for Brand API endpoints.
 *
 * POST   /api/v1/brands
 * GET    /api/v1/brands
 * GET    /api/v1/brands/:id
 * PATCH  /api/v1/brands/:id
 * POST   /api/v1/brands/:id/switch
 *
 * INVARIANTS:
 *  - All mutations require Idempotency-Key (I-ST04).
 *  - Lists use keyset/cursor pagination — no OFFSET.
 *  - brand.switch re-mints the access JWT with new brand_id claim.
 */
import { z } from 'zod';

// ── Brand ─────────────────────────────────────────────────────────────────────

// AC-4: locale columns — currency, timezone, revenue definition.
// Supported brand-PRIMARY currencies/timezones: GCC + India (expandable — the DB source of truth is
// tenancy.ref_currency / ref_timezone, migration 0107). These enums gate the brand-create API to the
// supported set; the DISPLAY layer (@brain/money) separately tolerates ANY currency an order carries.
export const CurrencyCodeSchema = z.enum(['INR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR']);
export const BrandTimezoneSchema = z.enum([
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Qatar',
]);
export const RevenueDefinitionSchema = z.enum(['realized', 'delivered']); // MA-12: 'placed' excluded

export const BrandSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  display_name: z.string().min(1).max(255),
  domain: z.string().max(253).nullable(),
  status: z.enum(['active', 'archived']),
  region_code: z.string().length(2).default('IN'),
  currency_code: CurrencyCodeSchema.default('INR'),
  timezone: BrandTimezoneSchema.default('Asia/Kolkata'),
  revenue_definition: RevenueDefinitionSchema.default('realized'),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type Brand = z.infer<typeof BrandSchema>;

// ── Create Brand ──────────────────────────────────────────────────────────────

export const CreateBrandRequestSchema = z.object({
  // SEC MB-1: workspace_id is now derived server-side from the session JWT
  // (auth.workspaceId). The body value is IGNORED by the route handler — made
  // optional here so clients that omit it pass validation, and clients that
  // still send it are not rejected (backward compat, value is discarded).
  workspace_id: z.string().uuid().optional(),
  display_name: z.string().min(1).max(255),
  // Brand website. The SERVER canonicalizes this to a registrable host via
  // normalizeBrandHost (@brain/pixel-sdk): lowercase, scheme/path/port/www stripped,
  // punycode for IDN. The persisted brand.domain is the canonical value, not the raw
  // input. null/absent = skip-for-now (no pixel provisioned). A non-empty value that
  // does not resolve to a valid host → 422 INVALID_WEBSITE. A non-empty value triggers
  // server-side auto-provision of the per-brand pixel_installation (server-minted
  // install_token; client never supplies a brand_id or token).
  domain: z.string().max(253).nullable().optional(),
  currency_code: CurrencyCodeSchema.optional(),
  timezone: BrandTimezoneSchema.optional(),
  revenue_definition: RevenueDefinitionSchema.optional(),
});
export type CreateBrandRequest = z.infer<typeof CreateBrandRequestSchema>;

export const CreateBrandResponseSchema = z.object({
  request_id: z.string().uuid(),
  brand: BrandSchema,
});
export type CreateBrandResponse = z.infer<typeof CreateBrandResponseSchema>;

// ── Get Brand ─────────────────────────────────────────────────────────────────

export const GetBrandResponseSchema = z.object({
  request_id: z.string().uuid(),
  brand: BrandSchema,
});
export type GetBrandResponse = z.infer<typeof GetBrandResponseSchema>;

// ── Update Brand ──────────────────────────────────────────────────────────────

export const UpdateBrandRequestSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  domain: z.string().max(253).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  currency_code: CurrencyCodeSchema.optional(),    // MA-11: immutability enforced in service
  timezone: BrandTimezoneSchema.optional(),
  revenue_definition: RevenueDefinitionSchema.optional(),
  region_code: z.string().length(2).optional(),    // ISO-3166-1 alpha-2; safe profile edit (no revenue recompute)
});
export type UpdateBrandRequest = z.infer<typeof UpdateBrandRequestSchema>;

export const UpdateBrandResponseSchema = z.object({
  request_id: z.string().uuid(),
  brand: BrandSchema,
});
export type UpdateBrandResponse = z.infer<typeof UpdateBrandResponseSchema>;

// ── List Brands ───────────────────────────────────────────────────────────────

export const ListBrandsQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListBrandsQuery = z.infer<typeof ListBrandsQuerySchema>;

export const ListBrandsResponseSchema = z.object({
  request_id: z.string().uuid(),
  brands: z.array(BrandSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type ListBrandsResponse = z.infer<typeof ListBrandsResponseSchema>;

// ── Switch Brand ──────────────────────────────────────────────────────────────
// Re-mints the access JWT with the selected brand_id claim.

export const SwitchBrandResponseSchema = z.object({
  request_id: z.string().uuid(),
  access_token: z.string(),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().positive(),
  brand_id: z.string().uuid(),
});
export type SwitchBrandResponse = z.infer<typeof SwitchBrandResponseSchema>;
