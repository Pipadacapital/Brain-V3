'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { loginSchema, type LoginFormValues } from '@/lib/api/schemas';
import { useLogin } from '@/lib/hooks/use-auth';
import type { OnboardingStatus, LoginResponse } from '@/lib/api/types';

/**
 * Deterministic lookup table: onboarding_status → resume URL.
 * Covers every enum value + null (no org membership).
 * Keyed off the authoritative enum — no boolean branch.
 */
export const ONBOARDING_RESUME: Record<OnboardingStatus | 'null', string> = {
  pending: '/workspace/new',
  org_created: '/brand/new',
  brand_created: '/onboarding/integrations',
  integration_selected: '/onboarding/done',
  complete: '/dashboard',
  null: '/workspace/new',
};

export function resolveOnboardingRoute(status: OnboardingStatus | null): string {
  if (status === null) return ONBOARDING_RESUME['null'];
  return ONBOARDING_RESUME[status] ?? '/dashboard';
}

export function LoginForm() {
  const router = useRouter();
  const { mutate: login, isPending, error } = useLogin();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  function onSubmit(data: LoginFormValues) {
    login(data, {
      onSuccess: (result: LoginResponse) => {
        // If user belongs to >1 org, send to org picker.
        if (result.orgs && result.orgs.length > 1) {
          router.push('/select-org');
          return;
        }
        // httpOnly cookie set by BFF; route by onboarding_status enum (MA-05).
        router.push(resolveOnboardingRoute(result.onboarding_status));
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to Brain</CardTitle>
        <CardDescription>Enter your email and password to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {error && <ErrorCard error={error} />}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'login-email-error' : undefined}
                data-testid="input-email"
                {...register('email')}
              />
              {errors.email && (
                <p id="login-email-error" className="text-xs text-destructive" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-required="true"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
                data-testid="input-password"
                {...register('password')}
              />
              {errors.password && (
                <p id="login-password-error" className="text-xs text-destructive" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isPending}
              data-testid="btn-login"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Signing in…' : 'Sign in'}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/register" className="text-primary underline-offset-4 hover:underline">
                Create account
              </Link>
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
