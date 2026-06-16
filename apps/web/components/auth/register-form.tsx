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
import { registerSchema, type RegisterFormValues } from '@/lib/api/schemas';
import { useRegister } from '@/lib/hooks/use-auth';
import { toast } from '@/components/ui/toaster';
import type { RegisterResponse } from '@/lib/api/types';

export function RegisterForm() {
  const router = useRouter();
  const { mutate: register, isPending, error } = useRegister();

  const {
    register: field,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
  });

  function onSubmit(data: RegisterFormValues) {
    register(
      { email: data.email, password: data.password, full_name: data.full_name },
      {
        onSuccess: (result: RegisterResponse) => {
          // AC-7: Backend returns INVITE_PENDING when the email has a pending invite.
          if (result.code === 'INVITE_PENDING') {
            toast({
              title: 'Invite pending',
              description:
                'An invite was sent to this email. Accept the invite to join the workspace.',
            });
            router.push(`/invite/accept?email=${encodeURIComponent(data.email)}`);
            return;
          }
          toast({
            title: 'Account created',
            description: 'Check your email to verify your account.',
          });
          router.push(`/verify-email?email=${encodeURIComponent(data.email)}`);
        },
        onError: (err) => {
          // AC-7: Duplicate verified email — timing-safe 2xx from backend means this
          // path shows only on actual API errors. The backend returns success for
          // duplicates with the "check your email" message.
          // Handle explicit DUPLICATE_EMAIL code if backend ever surfaces it.
          const anyErr = err as { code?: string };
          if (anyErr?.code === 'EMAIL_EXISTS') {
            toast({
              title: 'Account already exists',
              description:
                'An account with this email exists. Sign in or reset your password.',
              variant: 'destructive',
            });
          }
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Enter your details to get started.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {error && <ErrorCard error={error} />}

            <div className="space-y-1.5">
              <Label htmlFor="full_name">Full name</Label>
              <Input
                id="full_name"
                autoComplete="name"
                aria-required="true"
                aria-invalid={!!errors.full_name}
                aria-describedby={errors.full_name ? 'full_name-error' : undefined}
                data-testid="input-full-name"
                {...field('full_name')}
              />
              {errors.full_name && (
                <p id="full_name-error" className="text-xs text-destructive" role="alert">
                  {errors.full_name.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
                data-testid="input-email"
                {...field('email')}
              />
              {errors.email && (
                <p id="email-error" className="text-xs text-destructive" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                aria-required="true"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : 'password-hint'}
                data-testid="input-password"
                {...field('password')}
              />
              <p id="password-hint" className="text-xs text-muted-foreground">
                Minimum 12 characters
              </p>
              {errors.password && (
                <p id="password-error" className="text-xs text-destructive" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isPending}
              data-testid="btn-register"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Creating account…' : 'Create account'}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
