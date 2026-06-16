import { OnboardingDoneStep } from '@/components/onboarding/onboarding-done-step';

export const metadata = { title: 'Setup Complete — Brain' };

export default function OnboardingDonePage() {
  return (
    <div>
      <div className="mb-8">
        <p
          className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
          aria-label="Step 4 of 4"
          data-testid="step-indicator"
        >
          Step 4 of 4
        </p>
        <h2 className="text-2xl font-bold text-foreground">You&apos;re all set!</h2>
        <p className="text-muted-foreground mt-1">
          Your Brain workspace is ready. Here&apos;s a summary of what was set up.
        </p>
      </div>
      <OnboardingDoneStep />
    </div>
  );
}
