import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge — small categorical/label chip.
 * For live system status (healthy / degraded / down / syncing) prefer
 * StatusBadge, which adds a status dot + semantics.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        // Subtle semantic chips — the default for status/quality signals.
        success: 'border-transparent bg-success-subtle text-success-subtle-foreground',
        warning: 'border-transparent bg-warning-subtle text-warning-subtle-foreground',
        destructive: 'border-transparent bg-destructive-subtle text-destructive-subtle-foreground',
        info: 'border-transparent bg-info-subtle text-info-subtle-foreground',
        // Solid destructive kept for emphasis (back-compat aware).
        'destructive-solid': 'border-transparent bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
