/**
 * pixel.api.v1 — Zod contracts for Pixel API endpoints.
 *
 * GET  /api/v1/pixel/installation
 * POST /api/v1/pixel/verify
 * GET  /api/v1/pixel/health
 *
 * INVARIANTS:
 *  - Pixel verify = HTTP HEAD/GET presence check on target_host (not a full SDK).
 *  - pixel_installation.install_token is a public per-brand identifier (not a secret).
 *  - All mutations require Idempotency-Key (I-ST04).
 */
import { z } from 'zod';

// ── Pixel Installation ────────────────────────────────────────────────────────

export const PixelInstallationSchema = z.object({
  id: z.string().uuid(),
  brand_id: z.string().uuid(),
  /** Per-brand pixel tag identifier embedded in the embed snippet. NOT a secret. */
  install_token: z.string().uuid(),
  target_host: z.string().max(253),
  installed_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  /** The embed snippet HTML to copy-paste. */
  snippet_html: z.string(),
});
export type PixelInstallation = z.infer<typeof PixelInstallationSchema>;

// ── Get Pixel Installation ────────────────────────────────────────────────────

export const GetPixelInstallationResponseSchema = z.object({
  request_id: z.string().uuid(),
  installation: PixelInstallationSchema.nullable(),
});
export type GetPixelInstallationResponse = z.infer<typeof GetPixelInstallationResponseSchema>;

// ── Pixel Verify ──────────────────────────────────────────────────────────────

export const VerifyPixelRequestSchema = z.object({
  brand_id: z.string().uuid(),
});
export type VerifyPixelRequest = z.infer<typeof VerifyPixelRequestSchema>;

export const VerifyPixelResponseSchema = z.object({
  request_id: z.string().uuid(),
  verified: z.boolean(),
  state: z.enum(['connected', 'syncing', 'waiting_for_data', 'error']),
  message: z.string(),
});
export type VerifyPixelResponse = z.infer<typeof VerifyPixelResponseSchema>;

// ── Pixel Health ──────────────────────────────────────────────────────────────

export const PixelHealthResponseSchema = z.object({
  request_id: z.string().uuid(),
  state: z.enum(['connected', 'syncing', 'waiting_for_data', 'error']).nullable(),
  verified_at: z.string().datetime({ offset: true }).nullable(),
  last_error: z.string().nullable(),
});
export type PixelHealthResponse = z.infer<typeof PixelHealthResponseSchema>;
