'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { ErrorCard } from '@/components/ui/error-card';
import { resetPasswordSchema, type ResetPasswordFormValues } from '@/lib/api/schemas';
import { useResetPassword } from '@/lib/hooks/use-auth';
import { toast } from '@/components/ui/toaster';

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { mutate: resetPassword, isPending, error } = useResetPassword();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
  });

  function onSubmit(data: ResetPasswordFormValues) {
    resetPassword(
      { token, password: data.password },
      {
        onSuccess: () => {
          toast({ title: 'Password updated', description: 'Please sign in with your new password.' });
          router.push('/login');
        },
      },
    );
  }

  if (!token) {
    return (
      <Card className="shadow-md">
        <CardContent className="space-y-4 py-8">
          <Alert variant="destructive" title="Invalid or missing reset token">
            This password reset link is no longer valid. Request a new one to continue.
          </Alert>
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-lg">Set a new password</CardTitle>
        <CardDescription>Enter and confirm your new password.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {error && <ErrorCard error={error} />}

            <div className="space-y-1.5">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                aria-required="true"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'rp-password-error' : 'rp-password-hint'}
                data-testid="input-password"
                {...register('password')}
              />
              <p id="rp-password-hint" className="text-xs text-muted-foreground">
                Minimum 12 characters
              </p>
              {errors.password && (
                <p id="rp-password-error" className="text-xs text-destructive" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm_password">Confirm new password</Label>
              <Input
                id="confirm_password"
                type="password"
                autoComplete="new-password"
                aria-required="true"
                aria-invalid={!!errors.confirm_password}
                aria-describedby={errors.confirm_password ? 'rp-confirm-error' : undefined}
                data-testid="input-confirm-password"
                {...register('confirm_password')}
              />
              {errors.confirm_password && (
                <p id="rp-confirm-error" className="text-xs text-destructive" role="alert">
                  {errors.confirm_password.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" loading={isPending} data-testid="btn-reset-password">
              {isPending ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
