import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Table — calm, scannable data table primitives.
 * Numeric cells should use `numeric` (right-aligned + tabular figures).
 * Wrap in a Card/SectionCard for elevation; the table itself is borderless
 * except for row separators.
 */

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <thead ref={ref} className={cn('', className)} {...props} />);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn('border-t border-border bg-muted/40 font-medium', className)}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b border-border transition-colors hover:bg-muted/40 data-[state=selected]:bg-accent',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

interface TableCellLikeProps {
  /** Right-align + tabular figures for numbers/money. */
  numeric?: boolean;
}

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & TableCellLikeProps
>(({ className, numeric, ...props }, ref) => (
  <th
    ref={ref}
    scope="col"
    className={cn(
      'h-9 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground',
      numeric && 'text-right tabular-nums',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & TableCellLikeProps
>(({ className, numeric, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'px-3 py-2.5 align-middle text-foreground',
      numeric && 'text-right tabular-nums',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn('mt-3 text-xs text-muted-foreground', className)} {...props} />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
