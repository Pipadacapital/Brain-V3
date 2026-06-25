'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { forgotPasswordSchema, type ForgotPasswordFormValues } from '@/lib/api/schemas';
import { useForgotPassword } from '@/lib/hooks/use-auth';

export function ForgotPasswordForm() {
  const { mutate: forgotPassword, isPending, error, isSuccess } = useForgotPassword();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  function onSubmit(data: ForgotPasswordFormValues) {
    forgotPassword(data);
  }

  if (isSuccess) {
    return (
      <Card className="shadow-md">
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success-subtle text-success-subtle-foreground" aria-hidden="true">
              <CheckCircle className="h-6 w-6" />
            </span>
            <h2 className="text-base font-semibold">Check your inbox</h2>
            <p className="max-w-xs text-sm text-muted-foreground">
              If an account exists for that email, we&apos;ve sent a password reset link. Check your inbox (and spam folder).
            </p>
            <Button asChild variant="outline" className="mt-2">
              <Link href="/login">Back to sign in</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-lg">Reset your password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a reset link if an account exists.
        </CardDescription>
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
                aria-describedby={errors.email ? 'fp-email-error' : undefined}
                data-testid="input-email"
                {...register('email')}
              />
              {errors.email && (
                <p id="fp-email-error" className="text-xs text-destructive" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" loading={isPending} data-testid="btn-send-reset">
              {isPending ? 'Sending…' : 'Send reset link'}
            </Button>

            <p className="pt-1 text-center text-sm text-muted-foreground">
              <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
