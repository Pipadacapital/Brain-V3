'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { loginSchema, type LoginFormValues } from '@/lib/api/schemas';
import { useLogin } from '@/lib/hooks/use-auth';
import type { LoginResponse } from '@/lib/api/types';
import { resolveOnboardingRoute } from '@/lib/onboarding-route';

// feat-onboarding-ux: the resolver moved to the canonical lib/onboarding-route.ts (the merged
// create step replaced /workspace/new + /brand/new with /onboarding/start). Re-exported here so
// existing imports (`@/components/auth/login-form`) keep resolving — single source of truth.
export { resolveOnboardingRoute } from '@/lib/onboarding-route';

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
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-lg">Sign in</CardTitle>
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
              loading={isPending}
              data-testid="btn-login"
            >
              {isPending ? 'Signing in…' : 'Sign in'}
            </Button>

            <p className="pt-1 text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
                Create account
              </Link>
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
