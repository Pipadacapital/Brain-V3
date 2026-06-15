import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Set New Password — Brain' };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
