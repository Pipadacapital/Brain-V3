'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorCard } from '@/components/ui/error-card';
import { createBrandSchema, type CreateBrandFormValues } from '@/lib/api/schemas';
import { useCreateBrand, useWorkspaceList } from '@/lib/hooks/use-workspace';
import { sessionApi } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import { Skeleton } from '@/components/ui/skeleton';
import { normalizeBrandHost } from '@brain/pixel-sdk';

/** Currency → region map (mirrors backend CURRENCY_TO_REGION). */
const CURRENCY_REGION: Record<string, string> = {
  INR: 'IN',
  AED: 'AE',
  SAR: 'SA',
};

const CURRENCY_LABELS: Record<string, string> = {
  INR: 'INR — Indian Rupee',
  AED: 'AED — UAE Dirham',
  SAR: 'SAR — Saudi Riyal',
};

const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Kolkata': 'Asia/Kolkata (IST, UTC+5:30)',
  'Asia/Dubai': 'Asia/Dubai (GST, UTC+4)',
  'Asia/Riyadh': 'Asia/Riyadh (AST, UTC+3)',
};

/** Default timezone per currency. */
const CURRENCY_TIMEZONE: Record<string, string> = {
  INR: 'Asia/Kolkata',
  AED: 'Asia/Dubai',
  SAR: 'Asia/Riyadh',
};

export function CreateBrandForm() {
  const router = useRouter();
  const { data: workspaces, isLoading: wsLoading } = useWorkspaceList();
  const { mutate: createBrand, isPending, error } = useCreateBrand();
  const [currencyMismatch, setCurrencyMismatch] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<CreateBrandFormValues | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateBrandFormValues>({
    resolver: zodResolver(createBrandSchema),
    defaultValues: {
      display_name: '',
      domain: '',
      currency_code: 'INR',
      timezone: 'Asia/Kolkata',
      revenue_definition: 'realized',
    },
  });

  const workspaceId = workspaces?.workspaces?.[0]?.id;
  const selectedCurrency = watch('currency_code');
  const selectedTimezone = watch('timezone');
  const domainValue = watch('domain');

  // Cosmetic preview of the canonical host the SERVER will derive + track.
  // Server value is authoritative; this only sets expectations as the user types.
  const hostPreview = normalizeBrandHost(domainValue);

  /** Auto-suggest timezone when currency changes. */
  function handleCurrencyChange(val: 'INR' | 'AED' | 'SAR') {
    setValue('currency_code', val);
    // Suggest matching timezone if user has default/unmodified tz
    const suggestedTz = CURRENCY_TIMEZONE[val];
    if (suggestedTz) setValue('timezone', suggestedTz as 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh');
    setCurrencyMismatch(false);
  }

  /** Check if chosen currency contradicts chosen timezone region. */
  function isMismatch(currency: string, timezone: string): boolean {
    const expectedTz = CURRENCY_TIMEZONE[currency];
    return !!expectedTz && expectedTz !== timezone;
  }

  function doSubmit(data: CreateBrandFormValues, opts?: { skipWebsite?: boolean }) {
    if (!workspaceId) return;

    const mismatch = isMismatch(data.currency_code ?? 'INR', data.timezone ?? 'Asia/Kolkata');
    if (mismatch && !currencyMismatch) {
      // Surface confirm prompt before allowing mismatched currency/timezone
      setPendingSubmit(data);
      setCurrencyMismatch(true);
      return;
    }

    // Reset confirm state and proceed
    setCurrencyMismatch(false);
    setPendingSubmit(null);

    // Skip-for-now stays first-class: submit with no website → no pixel provision.
    const submittedDomain = opts?.skipWebsite ? undefined : data.domain?.trim() || undefined;
    const websiteProvided = !!submittedDomain;

    createBrand(
      {
        workspace_id: workspaceId,
        display_name: data.display_name,
        domain: submittedDomain,
        // region_code is derived server-side from currency_code; omit to let server derive.
        currency_code: data.currency_code,
        timezone: data.timezone,
        revenue_definition: data.revenue_definition,
      },
      {
        onSuccess: (brand) => {
          toast({ title: 'Brand created', description: `"${brand.display_name}" is ready.` });
          // Refresh the session so the cookie picks up the new brand/role, then route to the
          // onboarding "tracking ready / add website" interstitial. `w` tells that surface
          // whether a website was captured (snippet state) or skipped (add-website state).
          // The server's onboarding_status still advances to brand_created; this interstitial
          // sits in front of Step 3 and continues to whatever resolveOnboardingRoute returns.
          const w = websiteProvided ? '1' : '0';
          void sessionApi
            .refresh()
            .catch(() => undefined)
            .finally(() => {
              router.push(`/onboarding/tracking?w=${w}`);
            });
        },
      },
    );
  }

  function onSubmit(data: CreateBrandFormValues) {
    doSubmit(data);
  }

  function handleSkipWebsite() {
    // Validate the rest of the form, then submit with website cleared.
    void handleSubmit((data) => doSubmit(data, { skipWebsite: true }))();
  }

  function confirmMismatch() {
    if (pendingSubmit) {
      // User confirmed the mismatch — bypass the check and submit.
      setCurrencyMismatch(false);
      doSubmit(pendingSubmit);
    }
  }

  function cancelMismatch() {
    setCurrencyMismatch(false);
    setPendingSubmit(null);
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
        {currencyMismatch && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="flex-1">
              <p className="font-medium">Currency and timezone may not match</p>
              <p className="mt-1 text-amber-700">
                The selected currency ({selectedCurrency}) is typically used with{' '}
                {CURRENCY_TIMEZONE[selectedCurrency ?? 'INR']}, but you chose {selectedTimezone}.
                This is allowed — confirm only if intentional.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" onClick={cancelMismatch} data-testid="btn-mismatch-cancel">
                  Go back
                </Button>
                <Button size="sm" onClick={confirmMismatch} data-testid="btn-mismatch-confirm">
                  Confirm and continue
                </Button>
              </div>
            </div>
          </div>
        )}

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

            <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-4">
              <Label htmlFor="domain" className="flex items-center gap-2">
                Website
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-primary">
                  Recommended
                </span>
              </Label>
              <Input
                id="domain"
                type="text"
                inputMode="url"
                placeholder="mystore.com"
                aria-invalid={!!errors.domain}
                aria-describedby={
                  errors.domain
                    ? 'brand-domain-error'
                    : hostPreview
                      ? 'brand-domain-preview brand-domain-hint'
                      : 'brand-domain-hint'
                }
                data-testid="input-brand-domain"
                {...register('domain')}
              />
              {hostPreview && !errors.domain && (
                <p
                  id="brand-domain-preview"
                  className="text-xs text-primary"
                  data-testid="brand-domain-preview"
                >
                  We&apos;ll set up tracking for <strong>{hostPreview}</strong>.
                </p>
              )}
              <p id="brand-domain-hint" className="text-xs text-muted-foreground">
                Powers your tracking pixel — we&apos;ll generate an install snippet for this
                site right after. You can still add it later.
              </p>
              {errors.domain && (
                <p id="brand-domain-error" className="text-xs text-destructive" role="alert">
                  {errors.domain.message}
                </p>
              )}
            </div>

            {/* Currency code — bounded allowlist (INR / AED / SAR) */}
            <div className="space-y-1.5">
              <Label htmlFor="currency_code">Currency</Label>
              <Controller
                name="currency_code"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(val) => handleCurrencyChange(val as 'INR' | 'AED' | 'SAR')}
                  >
                    <SelectTrigger
                      id="currency_code"
                      aria-required="true"
                      aria-invalid={!!errors.currency_code}
                      aria-describedby={errors.currency_code ? 'brand-currency-error' : 'brand-currency-hint'}
                      data-testid="select-currency-code"
                    >
                      <SelectValue placeholder="Select currency" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(CURRENCY_LABELS).map(([code, label]) => (
                        <SelectItem key={code} value={code}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p id="brand-currency-hint" className="text-xs text-muted-foreground">
                Cannot be changed after financial data is recorded.
              </p>
              {errors.currency_code && (
                <p id="brand-currency-error" className="text-xs text-destructive" role="alert">
                  {errors.currency_code.message}
                </p>
              )}
            </div>

            {/* Timezone — bounded IANA allowlist */}
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Controller
                name="timezone"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(val) => field.onChange(val)}
                  >
                    <SelectTrigger
                      id="timezone"
                      aria-required="true"
                      aria-invalid={!!errors.timezone}
                      aria-describedby={errors.timezone ? 'brand-tz-error' : undefined}
                      data-testid="select-timezone"
                    >
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(TIMEZONE_LABELS).map(([tz, label]) => (
                        <SelectItem key={tz} value={tz}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.timezone && (
                <p id="brand-tz-error" className="text-xs text-destructive" role="alert">
                  {errors.timezone.message}
                </p>
              )}
            </div>

            {/* Revenue definition — MA-12: 'placed' excluded */}
            <div className="space-y-1.5">
              <Label htmlFor="revenue_definition">Revenue recognition</Label>
              <Controller
                name="revenue_definition"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="revenue_definition"
                      aria-required="true"
                      aria-invalid={!!errors.revenue_definition}
                      aria-describedby={
                        errors.revenue_definition ? 'brand-rev-error' : 'brand-rev-hint'
                      }
                      data-testid="select-revenue-definition"
                    >
                      <SelectValue placeholder="Select recognition" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="realized">Realized (settled)</SelectItem>
                      <SelectItem value="delivered">Delivered (on delivery)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              <p id="brand-rev-hint" className="text-xs text-muted-foreground">
                Realized is recommended for COD-heavy markets (India, GCC).
              </p>
              {errors.revenue_definition && (
                <p id="brand-rev-error" className="text-xs text-destructive" role="alert">
                  {errors.revenue_definition.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Button
                type="submit"
                className="w-full"
                disabled={isPending || !workspaceId || currencyMismatch}
                data-testid="btn-create-brand"
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {isPending ? 'Creating…' : 'Create brand'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={handleSkipWebsite}
                disabled={isPending || !workspaceId || currencyMismatch}
                data-testid="btn-skip-website"
              >
                Create without a website — add it later
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
