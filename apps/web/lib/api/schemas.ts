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
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(48, 'Slug must be under 48 characters')
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must be lowercase letters, numbers, and hyphens only',
    ),
});
export type CreateWorkspaceFormValues = z.infer<typeof createWorkspaceSchema>;

// ── Brand ─────────────────────────────────────────────────────────────────────

export const createBrandSchema = z.object({
  display_name: z
    .string()
    .min(1, 'Brand name is required')
    .max(80, 'Brand name must be under 80 characters'),
  domain: z
    .string()
    .url('Enter a valid URL (e.g. https://yourstore.com)')
    .optional()
    .or(z.literal('')),
});
export type CreateBrandFormValues = z.infer<typeof createBrandSchema>;

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
