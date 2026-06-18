/**
 * Form-side Zod schemas — mirrors the backend contract Zod schemas from packages/contracts.
 * These drive React Hook Form validation on the frontend.
 *
 * Cross-track gap: When Track 0 ships packages/contracts M1 schemas,
 * these should be replaced with direct imports from @brain/contracts.
 */
import { z } from 'zod';

// ── Auth ──────────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  full_name: z
    .string()
    .min(1, 'Full name is required')
    .max(100, 'Full name must be under 100 characters'),
  email: z.string().email('Enter a valid email address'),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(128, 'Password must be under 128 characters'),
});
export type RegisterFormValues = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginFormValues = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
});
export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be under 128 characters'),
    confirm_password: z.string(),
  })
  .refine((data) => data.password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });
export type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

// ── Workspace ─────────────────────────────────────────────────────────────────

export const createWorkspaceSchema = z.object({
  name: z
    .string()
    .min(1, 'Workspace name is required')
    .max(80, 'Workspace name must be under 80 characters'),
  /**
   * feat-onboarding-ux: slug is now an implementation detail — derived server-side from the
   * name (the standalone /v1/workspaces contract makes `slug` optional). The slug input is no
   * longer shown to the user, so this field is optional here too (the merged onboarding step
   * uses createBrandWorkspaceSchema below and sends no slug at all).
   */
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(48, 'Slug must be under 48 characters')
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must be lowercase letters, numbers, and hyphens only',
    )
    .optional(),
});
export type CreateWorkspaceFormValues = z.infer<typeof createWorkspaceSchema>;

// ── Brand ─────────────────────────────────────────────────────────────────────

export const createBrandSchema = z.object({
  display_name: z
    .string()
    .min(1, 'Brand name is required')
    .max(80, 'Brand name must be under 80 characters'),
  /**
   * Brand website — recommended (powers the tracking pixel), NOT required (Skip-for-now
   * stays first-class, ADR-5). The server is authoritative for normalization
   * (`normalizeBrandHost` in @brain/pixel-sdk): it canonicalizes whatever the user types
   * (bare host, full URL, www-prefixed) to one host and provisions the pixel from it.
   *
   * Client-side we accept either a bare host (`mystore.com`) or a full URL — we only
   * reject obvious garbage (a value with no dot) so the field stays forgiving; the server
   * does the strict parse + 422 on a non-empty-but-invalid value.
   */
  domain: z
    .string()
    .trim()
    .refine((v) => v === '' || v.includes('.'), {
      message: 'Enter a valid website (e.g. mystore.com or https://mystore.com)',
    })
    .optional()
    .or(z.literal('')),
  /** ISO 4217 bounded allowlist — MA-12: matches backend CHECK constraint. */
  currency_code: z
    .enum(['INR', 'AED', 'SAR'] as const, {
      errorMap: () => ({ message: 'Select a supported currency' }),
    })
    .default('INR'),
  /** IANA timezone bounded allowlist. */
  timezone: z
    .enum(['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh'] as const, {
      errorMap: () => ({ message: 'Select a supported timezone' }),
    })
    .default('Asia/Kolkata'),
  /** Revenue recognition definition — MA-12: 'placed' excluded. */
  revenue_definition: z
    .enum(['realized', 'delivered'] as const, {
      errorMap: () => ({ message: 'Select a recognition method' }),
    })
    .default('realized'),
});
export type CreateBrandFormValues = z.infer<typeof createBrandSchema>;

// ── Merged workspace + brand (feat-onboarding-ux Deliverable 3/4) ──────────────
//
// One step that provisions both the organization (workspace) and its first brand. There is
// NO slug field — the server derives the slug from the workspace name. All brand-config
// fields (website/currency/timezone/revenue) carry over from createBrandSchema so the
// website→pixel UX (preview + skip) from feat-onboarding-website is preserved unchanged.
export const createBrandWorkspaceSchema = z.object({
  workspace_name: z
    .string()
    .min(1, 'Workspace name is required')
    .max(80, 'Workspace name must be under 80 characters'),
  display_name: z
    .string()
    .min(1, 'Brand name is required')
    .max(80, 'Brand name must be under 80 characters'),
  domain: z
    .string()
    .trim()
    .refine((v) => v === '' || v.includes('.'), {
      message: 'Enter a valid website (e.g. mystore.com or https://mystore.com)',
    })
    .optional()
    .or(z.literal('')),
  currency_code: z
    .enum(['INR', 'AED', 'SAR'] as const, {
      errorMap: () => ({ message: 'Select a supported currency' }),
    })
    .default('INR'),
  timezone: z
    .enum(['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh'] as const, {
      errorMap: () => ({ message: 'Select a supported timezone' }),
    })
    .default('Asia/Kolkata'),
  revenue_definition: z
    .enum(['realized', 'delivered'] as const, {
      errorMap: () => ({ message: 'Select a recognition method' }),
    })
    .default('realized'),
});
export type CreateBrandWorkspaceFormValues = z.infer<typeof createBrandWorkspaceSchema>;

// ── Members ───────────────────────────────────────────────────────────────────

export const inviteMemberSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role_code: z.enum(['owner', 'brand_admin', 'manager', 'analyst'] as const, {
    errorMap: () => ({ message: 'Select a role' }),
  }),
});
export type InviteMemberFormValues = z.infer<typeof inviteMemberSchema>;

export const updateRoleSchema = z.object({
  role_code: z.enum(['owner', 'brand_admin', 'manager', 'analyst'] as const),
});
export type UpdateRoleFormValues = z.infer<typeof updateRoleSchema>;

// ── Ask Brain (Phase 8 — feat-decision-intelligence-inputs) ────────────────────
//
// The natural-language question form. The question is sent in-memory only; the server
// persists a deterministically REDACTED form (PII/free-text stripped) — the raw question
// is NEVER written to disk or logs (requirement §"NLQ stored REDACTED only"). We bound the
// length to keep the single resolver call within the cost cap (≤~1.5k input tokens).
export const askBrainSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, 'Ask a question (at least 3 characters)')
    .max(500, 'Keep the question under 500 characters'),
});
export type AskBrainFormValues = z.infer<typeof askBrainSchema>;
