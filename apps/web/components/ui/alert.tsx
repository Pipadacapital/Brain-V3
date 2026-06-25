import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Alert — an inline, non-blocking message banner (info / success / warning /
 * error). Use for contextual notices inside a page. For transient feedback use
 * `toast`; for a failed data fetch use ErrorCard.
 *
 * `role` is set appropriately: assertive for destructive, polite otherwise.
 */
const alertVariants = cva(
  'relative flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2',
  {
    variants: {
      variant: {
        info: 'border-info/25 bg-info-subtle text-info-subtle-foreground',
        success: 'border-success/25 bg-success-subtle text-success-subtle-foreground',
        warning: 'border-warning/30 bg-warning-subtle text-warning-subtle-foreground',
        destructive: 'border-destructive/30 bg-destructive-subtle text-destructive-subtle-foreground',
        neutral: 'border-border bg-muted/50 text-foreground',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const iconFor = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
  neutral: Info,
} as const;

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof alertVariants> {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  /** Hide the leading icon entirely. */
  hideIcon?: boolean;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'info', title, icon, hideIcon = false, children, ...props }, ref) => {
    const Icon = iconFor[variant ?? 'info'];
    return (
      <div
        ref={ref}
        role={variant === 'destructive' ? 'alert' : 'status'}
        aria-live={variant === 'destructive' ? 'assertive' : 'polite'}
        className={cn(alertVariants({ variant }), className)}
        {...props}
      >
        {!hideIcon && (
          <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-hidden="true">
            {icon ?? <Icon className="size-4" />}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className="text-sm opacity-90">{children}</div>}
        </div>
      </div>
    );
  },
);
Alert.displayName = 'Alert';
