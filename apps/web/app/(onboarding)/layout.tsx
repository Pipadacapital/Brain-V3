/**
 * Onboarding layout — 4-step wizard, progress-oriented, minimal chrome.
 *
 * Steps:
 *   Step 1: /workspace/new  — Create Workspace
 *   Step 2: /brand/new      — Create Brand (currency/timezone/revenue)
 *   Step 3: /onboarding/integrations — Connect Integrations
 *   Step 4: /onboarding/done         — Done
 *
 * Ghost /invite step REMOVED (MA-10). Pixel is NOT a wizard step (stays in settings).
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
