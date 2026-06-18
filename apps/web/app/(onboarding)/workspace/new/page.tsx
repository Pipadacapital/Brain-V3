import { redirect } from 'next/navigation';

/**
 * feat-onboarding-ux: the standalone /workspace/new step is folded into the merged create step
 * (/onboarding/start). This legacy route now permanently redirects forward so any bookmark,
 * deep link, or browser-Back never lands on the old standalone workspace form (forward-only).
 */
export default function NewWorkspacePage() {
  redirect('/onboarding/start');
}
