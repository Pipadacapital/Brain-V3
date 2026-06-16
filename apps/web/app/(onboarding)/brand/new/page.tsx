import { CreateBrandForm } from '@/components/onboarding/create-brand-form';

export const metadata = { title: 'Create Brand — Brain' };

export default function NewBrandPage() {
  return (
    <div>
      <div className="mb-8">
        <p
          className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1"
          aria-label="Step 2 of 4"
          data-testid="step-indicator"
        >
          Step 2 of 4
        </p>
        <h2 className="text-2xl font-bold text-foreground">Set up your brand</h2>
        <p className="text-muted-foreground mt-1">
          Configure your brand&apos;s currency, timezone, and revenue recognition.
        </p>
      </div>
      <CreateBrandForm />
    </div>
  );
}
