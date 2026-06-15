import { Suspense } from 'react';
import { AcceptInviteView } from '@/components/members/accept-invite-view';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Accept Invitation — Brain' };

export default function AcceptInvitePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Brain</h1>
          <p className="text-sm text-muted-foreground mt-1">Brand Intelligence Platform</p>
        </div>
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <AcceptInviteView />
        </Suspense>
      </div>
    </div>
  );
}
