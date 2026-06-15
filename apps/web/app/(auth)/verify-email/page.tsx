import { Suspense } from 'react';
import { VerifyEmailForm } from '@/components/auth/verify-email-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Verify Email — Brain' };

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full" />}>
      <VerifyEmailForm />
    </Suspense>
  );
}
