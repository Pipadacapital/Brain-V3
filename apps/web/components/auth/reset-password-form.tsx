'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
      <Card>
        <CardContent className="py-8">
          <p className="text-center text-sm text-destructive">
            Invalid or missing reset token. Please request a new password reset.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
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

            <Button type="submit" className="w-full" disabled={isPending} data-testid="btn-reset-password">
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
