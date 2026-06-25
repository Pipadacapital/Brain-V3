'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs — accessible, dependency-free tab control (no extra Radix package).
 * Keyboard: Left/Right/Home/End move focus + selection (automatic activation).
 * Use for in-page section switching; for URL-driven tabs, control `value`.
 */

type TabsContextValue = {
  value: string;
  setValue: (v: string) => void;
  baseId: string;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(component: string) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used within <Tabs>`);
  return ctx;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ value, defaultValue, onValueChange, className, children, ...props }, ref) => {
    const isControlled = value !== undefined;
    const [internal, setInternal] = React.useState(defaultValue ?? '');
    const current = isControlled ? (value as string) : internal;
    const baseId = React.useId();

    const setValue = React.useCallback(
      (v: string) => {
        if (!isControlled) setInternal(v);
        onValueChange?.(v);
      },
      [isControlled, onValueChange],
    );

    return (
      <TabsContext.Provider value={{ value: current, setValue, baseId }}>
        <div ref={ref} className={cn('flex flex-col gap-4', className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        'inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, onClick, onKeyDown, ...props }, ref) => {
    const { value: active, setValue, baseId } = useTabs('TabsTrigger');
    const selected = active === value;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      const list = e.currentTarget.parentElement;
      if (!list) return;
      const tabs = Array.from(
        list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
      );
      const idx = tabs.indexOf(e.currentTarget);
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={`${baseId}-trigger-${value}`}
        aria-selected={selected}
        aria-controls={`${baseId}-content-${value}`}
        tabIndex={selected ? 0 : -1}
        data-state={selected ? 'active' : 'inactive'}
        onClick={(e) => {
          setValue(value);
          onClick?.(e);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:pointer-events-none disabled:opacity-50',
          selected
            ? 'bg-surface text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, className, ...props }, ref) => {
    const { value: active, baseId } = useTabs('TabsContent');
    if (active !== value) return null;
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`${baseId}-content-${value}`}
        aria-labelledby={`${baseId}-trigger-${value}`}
        tabIndex={0}
        className={cn(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
