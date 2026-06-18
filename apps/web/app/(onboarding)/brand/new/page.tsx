import { redirect } from 'next/navigation';

/**
 * feat-onboarding-ux: the standalone /brand/new step is folded into the merged create step
 * (/onboarding/start). This legacy onboarding route redirects forward so browser-Back from a
 * later step never re-shows the standalone brand form (forward-only). Note: the dashboard
 * "add a brand" flow uses the create-brand dialog (CreateBrandForm), not this onboarding route.
 */
export default function NewBrandPage() {
  redirect('/onboarding/start');
}
