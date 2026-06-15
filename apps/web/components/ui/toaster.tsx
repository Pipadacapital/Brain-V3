'use client';

import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const ToastProvider = ToastPrimitive.Provider;
const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      'fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]',
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & { variant?: 'default' | 'destructive' }
>(({ className, variant = 'default', ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(
      'group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all',
      variant === 'destructive'
        ? 'border-destructive bg-destructive text-destructive-foreground'
        : 'border bg-background text-foreground',
      className,
    )}
    {...props}
  />
));
Toast.displayName = ToastPrimitive.Root.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn('absolute right-2 top-2 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2', className)}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" aria-hidden="true" />
    <span className="sr-only">Close notification</span>
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description ref={ref} className={cn('text-sm opacity-90', className)} {...props} />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

// Simple toast state management
type ToastState = {
  id: string;
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
  open: boolean;
};

const toastQueue: ToastState[] = [];
let toastListeners: Array<(toasts: ToastState[]) => void> = [];

function notifyListeners() {
  toastListeners.forEach((l) => l([...toastQueue]));
}

export function toast({
  title,
  description,
  variant = 'default',
}: {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
}) {
  const id = Math.random().toString(36).slice(2);
  toastQueue.push({ id, title, description, variant, open: true });
  notifyListeners();
  setTimeout(() => {
    const idx = toastQueue.findIndex((t) => t.id === id);
    if (idx > -1) {
      toastQueue[idx]!.open = false;
      notifyListeners();
      setTimeout(() => {
        const i = toastQueue.findIndex((t) => t.id === id);
        if (i > -1) toastQueue.splice(i, 1);
        notifyListeners();
      }, 300);
    }
  }, 4000);
}

export function Toaster() {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);

  React.useEffect(() => {
    const handler = (t: ToastState[]) => setToasts([...t]);
    toastListeners.push(handler);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== handler);
    };
  }, []);

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, variant, open }) => (
        <Toast key={id} open={open} variant={variant}>
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
