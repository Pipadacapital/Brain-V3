import { CreateBrandForm } from '@/components/onboarding/create-brand-form';

export const metadata = { title: 'Create Brand — Brain' };

export default function NewBrandPage() {
  return (
    <div>
      <div className="mb-8">
        <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1">
          Step 2 of 3
        </p>
        <h2 className="text-2xl font-bold text-foreground">Set up your brand</h2>
      </div>
      <CreateBrandForm />
    </div>
  );
}
