import { CreateWorkspaceForm } from '@/components/onboarding/create-workspace-form';

export const metadata = { title: 'Create Workspace — Brain' };

export default function NewWorkspacePage() {
  return (
    <div>
      <div className="mb-8">
        <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-1">
          Step 1 of 3
        </p>
        <h2 className="text-2xl font-bold text-foreground">Set up your workspace</h2>
      </div>
      <CreateWorkspaceForm />
    </div>
  );
}
