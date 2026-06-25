'use client';

/**
 * DashboardCreateBrandDialog — create a second (or Nth) brand from the dashboard (B5/AC-4).
 *
 * MA-08 CRITICAL: This component MUST NOT import CreateBrandForm, call its onSuccess,
 * call resolveOnboardingRoute, or push to any /onboarding/* route. Those paths are for
 * the initial onboarding wizard only. A second brand created from the dashboard must
 * stay on /dashboard — routing the user into the wizard would orphan the session.
 *
 * onSuccess flow (explicit, per arch plan §5 B5):
 *   1. brandApi.create(...) resolves → new BrandResponse
 *   2. queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY }) — refresh brand list
 *   3. brandApi.switchBrand(newBrand.id) — set the new brand as active
 *   4. queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY }) — refresh after switch
 *   5. window.location.href = '/dashboard' — stay on dashboard, pick up new session cookie
 *
 * Fields mirror create-brand-form.tsx validation (same Zod schema — createBrandSchema).
 * Role gate: Owner / Brand-Admin only — backend enforces; this component is mounted from
 * BrandSwitcher which already gates the CTA. Backend will 403 unauthorized attempts.
 */

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorCard } from '@/components/ui/error-card';
import { toast } from '@/components/ui/toaster';
import { brandApi, BffApiError, userFacingMessage } from '@/lib/api/client';
import { DASHBOARD_QUERY_KEY } from '@/lib/hooks/use-dashboard';
import { createBrandSchema, type CreateBrandFormValues } from '@/lib/api/schemas';

// ── Locale allowlists (mirrors create-brand-form.tsx) ───────────────────────

const CURRENCY_LABELS: Record<string, string> = {
  INR: 'INR — Indian Rupee',
  AED: 'AED — UAE Dirham',
  SAR: 'SAR — Saudi Riyal',
  QAR: 'QAR — Qatari Riyal',
  KWD: 'KWD — Kuwaiti Dinar',
  BHD: 'BHD — Bahraini Dinar',
  OMR: 'OMR — Omani Rial',
};

const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Kolkata': 'Asia/Kolkata (IST, UTC+5:30)',
  'Asia/Dubai': 'Asia/Dubai (GST, UTC+4)',
  'Asia/Riyadh': 'Asia/Riyadh (AST, UTC+3)',
  'Asia/Qatar': 'Asia/Qatar (AST, UTC+3)',
  'Asia/Kuwait': 'Asia/Kuwait (AST, UTC+3)',
  'Asia/Bahrain': 'Asia/Bahrain (AST, UTC+3)',
  'Asia/Muscat': 'Asia/Muscat (GST, UTC+4)',
};

/** Default timezone per currency (mirrors create-brand-form.tsx) — GCC + India. */
const CURRENCY_TIMEZONE: Record<string, string> = {
  INR: 'Asia/Kolkata',
  AED: 'Asia/Dubai',
  SAR: 'Asia/Riyadh',
  QAR: 'Asia/Qatar',
  KWD: 'Asia/Kuwait',
  BHD: 'Asia/Bahrain',
  OMR: 'Asia/Muscat',
};

// ── Types ────────────────────────────────────────────────────────────────────

interface DashboardCreateBrandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function DashboardCreateBrandDialog({ open, onOpenChange }: DashboardCreateBrandDialogProps) {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [currencyMismatch, setCurrencyMismatch] = useState(false);
  const [pendingValues, setPendingValues] = useState<CreateBrandFormValues | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
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

  const selectedCurrency = watch('currency_code');
  const selectedTimezone = watch('timezone');

  function isMismatch(currency: string, timezone: string): boolean {
    const expectedTz = CURRENCY_TIMEZONE[currency];
    return !!expectedTz && expectedTz !== timezone;
  }

  function handleCurrencyChange(val: 'INR' | 'AED' | 'SAR') {
    setValue('currency_code', val);
    const suggestedTz = CURRENCY_TIMEZONE[val];
    if (suggestedTz) setValue('timezone', suggestedTz as 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh');
    setCurrencyMismatch(false);
  }

  function handleClose() {
    reset();
    setCurrencyMismatch(false);
    setPendingValues(null);
    setSubmitError(null);
    onOpenChange(false);
  }

  async function doCreate(values: CreateBrandFormValues) {
    setIsPending(true);
    setSubmitError(null);
    try {
      // Step 1: create the brand.
      // SEC MB-1/MB-3: workspace_id is derived server-side from the session JWT
      // (auth.workspaceId on POST /v1/brands). Do NOT send it from the client —
      // sending a client-controlled workspace_id allows cross-org brand creation
      // by spoofing a different org's id while holding a different-org session.
      const newBrand = await brandApi.create({
        display_name: values.display_name,
        domain: values.domain || undefined,
        currency_code: values.currency_code,
        timezone: values.timezone,
        revenue_definition: values.revenue_definition,
      });

      toast({ title: 'Brand created', description: `"${newBrand.display_name}" is ready.` });

      // Step 2: invalidate dashboard cache so the brand list refreshes.
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });

      // Step 3: switch to the new brand (makes it the active brand in the session).
      // MA-08: NEVER resolveOnboardingRoute, NEVER router.push('/onboarding/*').
      await brandApi.switchBrand(newBrand.id);

      // Step 4: invalidate again after switch so brand-scoped member_count + active_brand_id
      // reflect the new brand (B3/MA-06).
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });

      handleClose();

      // Step 5: stay on /dashboard — hard reload to pick up the new session cookie.
      window.location.href = '/dashboard';
    } catch (err) {
      const msg =
        err instanceof BffApiError
          ? userFacingMessage(err)
          : 'Could not create brand. Please try again.';
      setSubmitError(msg);
      setIsPending(false);
    }
  }

  function onSubmit(values: CreateBrandFormValues) {
    if (isMismatch(values.currency_code ?? 'INR', values.timezone ?? 'Asia/Kolkata') && !currencyMismatch) {
      // Surface mismatch confirm before proceeding (mirrors create-brand-form.tsx pattern).
      setPendingValues(values);
      setCurrencyMismatch(true);
      return;
    }
    setCurrencyMismatch(false);
    setPendingValues(null);
    void doCreate(values);
  }

  function confirmMismatch() {
    if (pendingValues) {
      setCurrencyMismatch(false);
      void doCreate(pendingValues);
    }
  }

  function cancelMismatch() {
    setCurrencyMismatch(false);
    setPendingValues(null);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent aria-describedby="create-brand-dialog-desc" data-testid="create-brand-dialog">
        <DialogHeader>
          <DialogTitle>Create a new brand</DialogTitle>
          <DialogDescription id="create-brand-dialog-desc">
            Add another brand to your workspace. You can switch between brands from the sidebar.
          </DialogDescription>
        </DialogHeader>

        {/* Currency / timezone mismatch warning (mirrors create-brand-form.tsx) */}
        {currencyMismatch && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800"
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cancelMismatch}
                  data-testid="btn-create-brand-dialog-mismatch-cancel"
                >
                  Go back
                </Button>
                <Button
                  size="sm"
                  onClick={confirmMismatch}
                  data-testid="btn-create-brand-dialog-mismatch-confirm"
                >
                  Confirm and continue
                </Button>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            {submitError && <ErrorCard error={new Error(submitError)} />}

            {/* Brand name */}
            <div className="space-y-1.5">
              <Label htmlFor="dialog-display_name">Brand name</Label>
              <Input
                id="dialog-display_name"
                placeholder="My Brand"
                aria-required="true"
                aria-invalid={!!errors.display_name}
                aria-describedby={errors.display_name ? 'dialog-brand-name-error' : undefined}
                data-testid="input-dialog-brand-name"
                {...register('display_name')}
              />
              {errors.display_name && (
                <p id="dialog-brand-name-error" className="text-xs text-destructive" role="alert">
                  {errors.display_name.message}
                </p>
              )}
            </div>

            {/* Currency */}
            <div className="space-y-1.5">
              <Label htmlFor="dialog-currency_code">Currency</Label>
              <Controller
                name="currency_code"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(val) => handleCurrencyChange(val as 'INR' | 'AED' | 'SAR')}
                  >
                    <SelectTrigger
                      id="dialog-currency_code"
                      aria-required="true"
                      aria-invalid={!!errors.currency_code}
                      aria-describedby={errors.currency_code ? 'dialog-brand-currency-error' : 'dialog-brand-currency-hint'}
                      data-testid="select-dialog-currency-code"
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
              <p id="dialog-brand-currency-hint" className="text-xs text-muted-foreground">
                Cannot be changed after financial data is recorded.
              </p>
              {errors.currency_code && (
                <p id="dialog-brand-currency-error" className="text-xs text-destructive" role="alert">
                  {errors.currency_code.message}
                </p>
              )}
            </div>

            {/* Timezone */}
            <div className="space-y-1.5">
              <Label htmlFor="dialog-timezone">Timezone</Label>
              <Controller
                name="timezone"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="dialog-timezone"
                      aria-required="true"
                      aria-invalid={!!errors.timezone}
                      aria-describedby={errors.timezone ? 'dialog-brand-tz-error' : undefined}
                      data-testid="select-dialog-timezone"
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
                <p id="dialog-brand-tz-error" className="text-xs text-destructive" role="alert">
                  {errors.timezone.message}
                </p>
              )}
            </div>

            {/* Revenue definition */}
            <div className="space-y-1.5">
              <Label htmlFor="dialog-revenue_definition">Revenue recognition</Label>
              <Controller
                name="revenue_definition"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="dialog-revenue_definition"
                      aria-required="true"
                      aria-invalid={!!errors.revenue_definition}
                      aria-describedby={
                        errors.revenue_definition ? 'dialog-brand-rev-error' : 'dialog-brand-rev-hint'
                      }
                      data-testid="select-dialog-revenue-definition"
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
              <p id="dialog-brand-rev-hint" className="text-xs text-muted-foreground">
                Realized is recommended for COD-heavy markets (India, GCC).
              </p>
              {errors.revenue_definition && (
                <p id="dialog-brand-rev-error" className="text-xs text-destructive" role="alert">
                  {errors.revenue_definition.message}
                </p>
              )}
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isPending}
              data-testid="btn-create-brand-dialog-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || currencyMismatch}
              data-testid="btn-create-brand-dialog-submit"
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? 'Creating…' : 'Create brand'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// SEC MB-3: getActiveWorkspaceId() removed. The backend derives workspace_id from the
// session JWT (auth.workspaceId) on POST /v1/brands — no client-side workspace resolution
// is needed or safe. Sending workspace_id from the client would allow cross-org spoofing.
