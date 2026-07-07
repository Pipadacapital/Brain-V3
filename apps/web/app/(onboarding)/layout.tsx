/**
 * Onboarding layout — 3-step wizard (feat-onboarding-ux), progress-oriented, minimal chrome.
 *
 * Steps:
 *   Step 1: /onboarding/start        — merged Create Workspace + Brand (slug auto-derived)
 *           /onboarding/tracking     — pixel-ready / add-website interstitial (post-create)
 *   Step 2: /onboarding/integrations — Connect your store
 *   Step 3: /onboarding/done         — Done
 *
 * Legacy /workspace/new + /brand/new redirect forward to /onboarding/start. The OnboardingGate
 * forward-redirects past completed steps (forward-only). Pixel is NOT a wizard step (settings).
 * The per-step progress stepper is rendered by each step page (WizardSteps).
 *
 * Visual language: a calm, focused, single-column setup surface — generous whitespace, a quiet
 * brand mark, one accent. This is the first impression, so it leads with trust, not chrome.
 */
import { OnboardingLogout } from '@/components/onboarding/onboarding-logout';

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              B
            </span>
            <span className="text-sm font-semibold tracking-tight text-foreground">Brain</span>
            <span className="text-sm text-muted-foreground">Setup</span>
          </div>
          <OnboardingLogout />
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">{children}</main>
    </div>
  );
}
