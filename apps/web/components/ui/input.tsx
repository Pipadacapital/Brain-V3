import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Renders the error treatment + sets aria-invalid. Pair with a message via aria-describedby. */
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    const isInvalid = invalid ?? ariaInvalid;
    return (
      <input
        type={type}
        aria-invalid={isInvalid || undefined}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-surface px-3 py-1 text-sm text-foreground shadow-xs transition-colors',
          'placeholder:text-muted-foreground',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:border-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
