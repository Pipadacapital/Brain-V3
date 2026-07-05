import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * WizardSteps — the shared onboarding progress stepper.
 *
 * One source of truth for the 3-step onboarding wizard's progress affordance, replacing the
 * ad-hoc "Step N of 3" eyebrow each page used to hand-roll. Communicates progress with both a
 * filled bar and a labelled, numbered dot per step — never colour-only (the active/complete
 * state carries an icon + text label for a11y).
 *
 * NOTE (consolidation): this is a LOCAL onboarding primitive. If a second flow needs a wizard
 * stepper, promote it to packages/ui. Flagged in followups.
 */

const ONBOARDING_STEPS = ['Set up your brand', 'Connect your store', 'You’re ready'] as const;

export interface WizardStepsProps {
  /** 1-based index of the current step. */
  current: number;
  className?: string;
}

export function WizardSteps({ current, className }: WizardStepsProps) {
  const total = ONBOARDING_STEPS.length;
  return (
    <nav
      aria-label={`Onboarding progress: step ${current} of ${total}`}
      data-testid="step-indicator"
      className={cn('w-full', className)}
    >
      <ol className="flex items-center gap-2">
        {ONBOARDING_STEPS.map((label, i) => {
          const stepNo = i + 1;
          const isComplete = stepNo < current;
          const isCurrent = stepNo === current;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                  isComplete && 'bg-primary text-primary-foreground',
                  isCurrent && 'bg-primary text-primary-foreground ring-2 ring-ring ring-offset-2 ring-offset-background',
                  !isComplete && !isCurrent && 'bg-muted text-muted-foreground',
                )}
              >
                {isComplete ? <Check className="size-3.5" aria-hidden="true" /> : stepNo}
              </span>
              <span
                className={cn(
                  'hidden truncate text-sm font-medium sm:inline',
                  isCurrent ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
              {stepNo < total && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'ml-1 h-px flex-1 rounded-full',
                    isComplete ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="sr-only">
        Step {current} of {total}: {ONBOARDING_STEPS[current - 1]}
      </p>
    </nav>
  );
}

/**
 * WizardHeader — the consistent title block for an onboarding step. One h1 + supporting copy,
 * sitting under the WizardSteps bar. Keeps hierarchy identical across every step page.
 */
export function WizardHeader({
  title,
  description,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
