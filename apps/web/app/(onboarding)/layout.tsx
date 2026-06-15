/**
 * Onboarding layout — progress-oriented, minimal chrome.
 * Routes: /workspace/new, /brand/new, /invite
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
