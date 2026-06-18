/**
 * Onboarding layout — 3-step wizard (feat-onboarding-ux), progress-oriented, minimal chrome.
 *
 * Steps:
 *   Step 1: /onboarding/start        — merged Create Workspace + Brand (slug auto-derived)
 *           /onboarding/tracking     — pixel-ready / add-website interstitial (post-create)
 *   Step 2: /onboarding/integrations — Connect Integrations
 *   Step 3: /onboarding/done         — Done
 *
 * Legacy /workspace/new + /brand/new redirect forward to /onboarding/start. The OnboardingGate
 * forward-redirects past completed steps (forward-only). Pixel is NOT a wizard step (settings).
 * Progress indicator is rendered by each step page (data-testid="step-indicator").
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-foreground">Brain</span>
          <span className="text-muted-foreground text-sm">/ Setup</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-12">{children}</main>
    </div>
  );
}
