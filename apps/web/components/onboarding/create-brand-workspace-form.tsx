'use client';

/**
 * Merged "create your brand" step (feat-onboarding-ux Deliverable 3/4).
 *
 * Folds the old two steps (create-workspace + create-brand) into ONE form that provisions
 * the workspace AND its first brand in a single atomic server transaction
 * (POST /v1/bff/onboarding/provision). The data model is unchanged (org→brand 1:1); only
 * the UI collapses.
 *
 * What carries over from the prior steps:
 *   - The slug input is GONE — the server derives the workspace slug from the name
 *     (it's an implementation detail; never shown to the user).
 *   - The website field + live normalized-host preview + the first-class "skip website"
 *     affordance are preserved verbatim (feat-onboarding-website non-regression). A website
 *     auto-provisions this brand's tracking pixel server-side; skipping is honest (no pixel).
 *   - Currency/timezone/revenue config with the currency↔timezone mismatch confirm.
 *
 * After provisioning we re-mint the session context (sessionApi.setOrg → new brand/role +
 * onboarding_status), then route to the tracking interstitial (?w=1 captured / ?w=0 skipped),
 * matching the existing post-brand-create flow.
 */

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
import {
  createBrandWorkspaceSchema,
  type CreateBrandWorkspaceFormValues,
} from '@/lib/api/schemas';
import { useProvisionOnboarding } from '@/lib/hooks/use-workspace';
import { sessionApi } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import { normalizeBrandHost } from '@brain/pixel-sdk';

/** Default timezone per currency (mirrors backend CURRENCY_TIMEZONE). */
const CURRENCY_TIMEZONE: Record<string, 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh'> = {
  INR: 'Asia/Kolkata',
  AED: 'Asia/Dubai',
  SAR: 'Asia/Riyadh',
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

export function CreateBrandWorkspaceForm() {
  const router = useRouter();
  const { mutate: provision, isPending, error } = useProvisionOnboarding();
  const [currencyMismatch, setCurrencyMismatch] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<CreateBrandWorkspaceFormValues | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateBrandWorkspaceFormValues>({
    resolver: zodResolver(createBrandWorkspaceSchema),
    defaultValues: {
      workspace_name: '',
      display_name: '',
      domain: '',
      currency_code: 'INR',
      timezone: 'Asia/Kolkata',
      revenue_definition: 'realized',
    },
  });

  const selectedCurrency = watch('currency_code');
  const selectedTimezone = watch('timezone');
  const domainValue = watch('domain');

  // Cosmetic preview of the canonical host the SERVER will derive + track. Server is
  // authoritative; this only sets expectations as the user types.
  const hostPreview = normalizeBrandHost(domainValue);

  const busy = isPending || finalizing;

  function handleCurrencyChange(val: 'INR' | 'AED' | 'SAR') {
    setValue('currency_code', val);
    const suggestedTz = CURRENCY_TIMEZONE[val];
    if (suggestedTz) setValue('timezone', suggestedTz);
    setCurrencyMismatch(false);
  }

  function isMismatch(currency: string, timezone: string): boolean {
    const expectedTz = CURRENCY_TIMEZONE[currency];
    return !!expectedTz && expectedTz !== timezone;
  }

  function doSubmit(
    data: CreateBrandWorkspaceFormValues,
    opts?: { skipWebsite?: boolean },
  ) {
    const mismatch = isMismatch(data.currency_code ?? 'INR', data.timezone ?? 'Asia/Kolkata');
    if (mismatch && !currencyMismatch) {
      setPendingSubmit(data);
      setCurrencyMismatch(true);
      return;
    }
    setCurrencyMismatch(false);
    setPendingSubmit(null);

    // Skip-for-now stays first-class: submit with no website → no pixel provision.
    const submittedDomain = opts?.skipWebsite ? undefined : data.domain?.trim() || undefined;

    provision(
      {
        workspace_name: data.workspace_name,
        brand_display_name: data.display_name,
        domain: submittedDomain,
        currency_code: data.currency_code,
        timezone: data.timezone,
        revenue_definition: data.revenue_definition,
      },
      {
        onSuccess: async (res) => {
          toast({
            title: 'Brand created',
            description: `"${data.display_name}" is ready.`,
          });
          // Re-mint the session so the cookie carries the new brand/role context +
          // onboarding_status, then route to the tracking interstitial. The server's
          // website_provided flag is authoritative for the snippet vs add-website state.
          setFinalizing(true);
          try {
            await sessionApi.setOrg({ organization_id: res.organization_id });
          } catch {
            // Non-fatal: the tracking page re-reads session on Continue. Proceed.
          }
          const w = res.website_provided ? '1' : '0';
          router.push(`/onboarding/tracking?w=${w}`);
        },
      },
    );
  }

  function onSubmit(data: CreateBrandWorkspaceFormValues) {
    doSubmit(data);
  }

  function handleSkipWebsite() {
    void handleSubmit((data) => doSubmit(data, { skipWebsite: true }))();
  }

  function confirmMismatch() {
    if (pendingSubmit) {
      setCurrencyMismatch(false);
      doSubmit(pendingSubmit);
    }
  }

  function cancelMismatch() {
    setCurrencyMismatch(false);
    setPendingSubmit(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your brand</CardTitle>
        <CardDescription>
          Name your workspace and set up your first brand. We&apos;ll provision both — you can add
          more brands and team members later.
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

            {/* Workspace name — slug is derived server-side; no slug input (Deliverable 4). */}
            <div className="space-y-1.5">
              <Label htmlFor="workspace_name">Workspace name</Label>
              <Input
                id="workspace_name"
                autoComplete="organization"
                placeholder="Acme Inc."
                aria-required="true"
                aria-invalid={!!errors.workspace_name}
                aria-describedby={
                  errors.workspace_name ? 'ws-name-error' : 'ws-name-hint'
                }
                data-testid="input-workspace-name"
                {...register('workspace_name')}
              />
              <p id="ws-name-hint" className="text-xs text-muted-foreground">
                Your organisation&apos;s home in Brain.
              </p>
              {errors.workspace_name && (
                <p id="ws-name-error" className="text-xs text-destructive" role="alert">
                  {errors.workspace_name.message}
                </p>
              )}
            </div>

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

            {/* Website → tracking pixel (feat-onboarding-website preserved verbatim) */}
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

            <div className="space-y-1.5">
              <Label htmlFor="currency_code">Currency</Label>
              <Controller
                name="currency_code"
                control={control}
                render={() => (
                  <Select
                    value={selectedCurrency}
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

            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <Controller
                name="timezone"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(val) => field.onChange(val)}>
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
                disabled={busy || currencyMismatch}
                data-testid="btn-create-brand"
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {busy ? 'Creating…' : 'Create brand'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={handleSkipWebsite}
                disabled={busy || currencyMismatch}
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
