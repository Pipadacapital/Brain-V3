'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { createBrandSchema, type CreateBrandFormValues } from '@/lib/api/schemas';
import { useCreateBrand, useWorkspaceList } from '@/lib/hooks/use-workspace';
import { sessionApi } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import { Skeleton } from '@/components/ui/skeleton';

export function CreateBrandForm() {
  const router = useRouter();
  const { data: workspaces, isLoading: wsLoading } = useWorkspaceList();
  const { mutate: createBrand, isPending, error } = useCreateBrand();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateBrandFormValues>({
    resolver: zodResolver(createBrandSchema),
    defaultValues: { display_name: '', domain: '' },
  });

  const workspaceId = workspaces?.workspaces?.[0]?.id;

  function onSubmit(data: CreateBrandFormValues) {
    if (!workspaceId) return;

    createBrand(
      {
        workspace_id: workspaceId,
        display_name: data.display_name,
        domain: data.domain || undefined,
        region_code: 'IN',
      },
      {
        onSuccess: async (brand) => {
          toast({ title: 'Brand created', description: `"${brand.display_name}" is ready.` });
          // Refresh session so the cookie picks up the new brand/role without re-login
          try {
            await sessionApi.refresh();
          } catch {
            // Non-fatal: user can still proceed; stale session will re-mint on next request
          }
          router.push('/dashboard');
        },
      },
    );
  }

  if (wsLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your brand</CardTitle>
        <CardDescription>
          A brand represents a store or product line. You can add multiple brands to your workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {error && <ErrorCard error={error} />}

            <div className="space-y-1.5">
              <Label htmlFor="display_name">Brand name</Label>
              <Input
                id="display_name"
                placeholder="My Brand"
                aria-required="true"
                aria-invalid={!!errors.display_name}
                aria-describedby={errors.display_name ? 'brand-name-error' : undefined}
                data-testid="input-brand-name"
                {...register('display_name')}
              />
              {errors.display_name && (
                <p id="brand-name-error" className="text-xs text-destructive" role="alert">
                  {errors.display_name.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="domain">
                Website URL{' '}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="domain"
                type="url"
                placeholder="https://mystore.com"
                aria-invalid={!!errors.domain}
                aria-describedby={errors.domain ? 'brand-domain-error' : 'brand-domain-hint'}
                data-testid="input-brand-domain"
                {...register('domain')}
              />
              <p id="brand-domain-hint" className="text-xs text-muted-foreground">
                Used to verify your Brain Pixel installation.
              </p>
              {errors.domain && (
                <p id="brand-domain-error" className="text-xs text-destructive" role="alert">
                  {errors.domain.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isPending || !workspaceId}
              data-testid="btn-create-brand"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Creating…' : 'Create brand'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
