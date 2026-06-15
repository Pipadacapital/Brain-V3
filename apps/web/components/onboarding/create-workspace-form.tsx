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
import { createWorkspaceSchema, type CreateWorkspaceFormValues } from '@/lib/api/schemas';
import { useCreateWorkspace } from '@/lib/hooks/use-workspace';
import { toast } from '@/components/ui/toaster';

export function CreateWorkspaceForm() {
  const router = useRouter();
  const { mutate: createWorkspace, isPending, error } = useCreateWorkspace();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateWorkspaceFormValues>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: '', slug: '' },
  });

  const nameValue = watch('name');

  // Auto-generate slug from name
  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const name = e.target.value;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 48);
    setValue('slug', slug);
    register('name').onChange(e);
  }

  function onSubmit(data: CreateWorkspaceFormValues) {
    createWorkspace(
      { name: data.name, slug: data.slug, region_code: 'IN' },
      {
        onSuccess: (workspace) => {
          toast({ title: 'Workspace created', description: `"${workspace.name}" is ready.` });
          router.push('/brand/new');
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your workspace</CardTitle>
        <CardDescription>
          A workspace is your organization&apos;s home in Brain. You can add brands and team members inside it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {error && <ErrorCard error={error} />}

            <div className="space-y-1.5">
              <Label htmlFor="name">Workspace name</Label>
              <Input
                id="name"
                autoComplete="organization"
                placeholder="Acme Inc."
                aria-required="true"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? 'ws-name-error' : undefined}
                data-testid="input-workspace-name"
                {...register('name')}
                onChange={handleNameChange}
              />
              {errors.name && (
                <p id="ws-name-error" className="text-xs text-destructive" role="alert">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="slug">Workspace URL</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground shrink-0">brain.app/</span>
                <Input
                  id="slug"
                  placeholder="acme-inc"
                  aria-required="true"
                  aria-invalid={!!errors.slug}
                  aria-describedby={errors.slug ? 'ws-slug-error' : 'ws-slug-hint'}
                  data-testid="input-workspace-slug"
                  {...register('slug')}
                />
              </div>
              <p id="ws-slug-hint" className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and hyphens only.
              </p>
              {errors.slug && (
                <p id="ws-slug-error" className="text-xs text-destructive" role="alert">
                  {errors.slug.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isPending || !nameValue}
              data-testid="btn-create-workspace"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Creating…' : 'Create workspace'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
