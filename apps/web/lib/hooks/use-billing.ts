'use client';

/**
 * Billing hooks — react-query bindings for the realized-GMV meter BFF endpoints (P1).
 *
 * Query key is prefixed with 'billing' so it auto-invalidates on brand switch when
 * brand-switcher.tsx calls queryClient.invalidateQueries({ queryKey: ['billing'] }).
 * Sealing a period invalidates the list so the new sealed row appears immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi } from '@/lib/api/client';

const BILLING_QUERY_KEY = ['billing'] as const;

/** useBillingPeriods — the active brand's sealed billing periods (honest no_data / has_data). */
export function useBillingPeriods() {
  return useQuery({
    queryKey: [...BILLING_QUERY_KEY, 'periods'],
    queryFn: () => billingApi.getPeriods(),
    staleTime: 5 * 60_000,
  });
}

/** useSealPeriod — meter + seal a 'YYYY-MM' period, then refresh the list. */
export function useSealPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period: string) => billingApi.sealPeriod(period),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING_QUERY_KEY });
    },
  });
}

/** useBill — the inspectable bill for a sealed period (fetched only when a period is selected). */
export function useBill(period: string | null) {
  return useQuery({
    queryKey: [...BILLING_QUERY_KEY, 'bill', period],
    queryFn: () => billingApi.getBill(period as string),
    enabled: !!period,
    staleTime: 5 * 60_000,
  });
}

/** useInvoice — the issued GST invoice for a period (fetched only when a period is selected). */
export function useInvoice(period: string | null) {
  return useQuery({
    queryKey: [...BILLING_QUERY_KEY, 'invoice', period],
    queryFn: () => billingApi.getInvoice(period as string),
    enabled: !!period,
    staleTime: 5 * 60_000,
  });
}

/** useIssueInvoice — issue the GST invoice for a sealed period, then refresh the invoice read. */
export function useIssueInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period: string) => billingApi.issueInvoice(period),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING_QUERY_KEY });
    },
  });
}

/** useIssueCreditNote — issue a credit note against a period's invoice, then refresh the invoice read. */
export function useIssueCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { period: string; reason: string; taxableMinor?: string }) =>
      billingApi.issueCreditNote(vars.period, vars.reason, vars.taxableMinor),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING_QUERY_KEY });
    },
  });
}
