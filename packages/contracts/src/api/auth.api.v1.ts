/**
 * auth.api.v1 — Zod contracts for the Auth API endpoints.
 *
 * POST /api/v1/auth/register
 * POST /api/v1/auth/verify-email
 * POST /api/v1/auth/login
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/forgot-password
 * POST /api/v1/auth/reset-password
 * GET  /api/v1/auth/me
 *
 * INVARIANTS:
 *  - Idempotency-Key header required on all mutation operations (I-ST04).
 *  - Error envelope matches ApiErrorResponseSchema (request_id + error).
 *  - forgot-password always 200 content-identical (NN-5 no-enumeration).
 *  - No plaintext token in any response (NN-5 — only token_hash stored in DB).
 */
import { z } from 'zod';

// ── Common headers ────────────────────────────────────────────────────────────

export const MutationHeadersSchema = z.object({
  'idempotency-key': z.string().uuid('Idempotency-Key must be a UUID (I-ST04)'),
  traceparent: z.string().optional(),
});

export type MutationHeaders = z.infer<typeof MutationHeadersSchema>;

// ── Register ──────────────────────────────────────────────────────────────────

export const RegisterRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters'),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  request_id: z.string().uuid(),
  user_id: z.string().uuid(),
  email: z.string().email(),
  message: z.literal('Registration successful. Please verify your email.'),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// ── Verify Email ──────────────────────────────────────────────────────────────

export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(32).max(128),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const OkResponseSchema = z.object({
  request_id: z.string().uuid(),
  ok: z.literal(true),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;

// ── Login ─────────────────────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  request_id: z.string().uuid(),
  access_token: z.string(),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().positive(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    email_verified: z.boolean(),
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── Logout ────────────────────────────────────────────────────────────────────

export const LogoutRequestSchema = z.object({}).optional();
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

// ── Forgot Password ───────────────────────────────────────────────────────────
// NN-5: response is ALWAYS 200 with content-identical body (no email enumeration).

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email().max(254),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResponseSchema = z.object({
  request_id: z.string().uuid(),
  message: z.literal(
    'If an account exists with this email, a password reset link has been sent.',
  ),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;

// ── Reset Password ────────────────────────────────────────────────────────────

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(32).max(128),
  new_password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters'),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

// ── Current User ──────────────────────────────────────────────────────────────

export const CurrentUserResponseSchema = z.object({
  request_id: z.string().uuid(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    email_verified: z.boolean(),
    status: z.enum(['active', 'suspended']),
    created_at: z.string().datetime({ offset: true }),
  }),
});
export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
