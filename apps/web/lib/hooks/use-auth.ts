'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/lib/api/client';
import type {
  RegisterRequest,
  LoginRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
} from '@/lib/api/types';

export const AUTH_QUERY_KEY = ['auth', 'me'] as const;

export function useCurrentUser() {
  return useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: () => authApi.me(),
    retry: false,
    staleTime: 5 * 60_000, // 5 min — re-validate session every 5 min
  });
}

/**
 * feat-onboarding-ux: reads the current user's email_verified flag via the BFF /me.
 * Used to show the soft-gate reason hint on sensitive-action buttons (connect store, invite).
 * UI guidance ONLY — the server-side requireVerifiedEmail guard is authoritative (returns
 * 403 EMAIL_NOT_VERIFIED). Defaults to `true` until known so we never block optimistically.
 */
export function useEmailVerified(): { emailVerified: boolean; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['bff', 'me', 'email-verified'],
    queryFn: () => authApi.bffMe(),
    staleTime: 60_000,
    retry: false,
  });
  return { emailVerified: data?.user?.email_verified ?? true, isLoading };
}

export function useRegister() {
  return useMutation({
    mutationFn: (data: RegisterRequest) => authApi.register(data),
  });
}

export function useVerifyEmail() {
  return useMutation({
    mutationFn: (data: VerifyEmailRequest) => authApi.verifyEmail(data),
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LoginRequest) => authApi.login(data),
    onSuccess: () => {
      // Invalidate current-user cache so next navigation re-fetches
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      queryClient.clear(); // Clear all cached data on logout
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (data: ForgotPasswordRequest) => authApi.forgotPassword(data),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (data: ResetPasswordRequest) => authApi.resetPassword(data),
  });
}
