import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * VerifyLink — the standard "click a number to see the records behind it" affordance. Every
 * headline figure (revenue at risk, orders affected, RTO rate) should let the reader drill
 * through to the underlying rows — this is Brain's "capture truth → build trust" made clickable.
 *
 * Renders a subtle inline "{label} →" link (text-primary, hover underline). Internal targets use
 * next/link with a trailing ArrowRight; when `external` is set, it opens in a new tab with an
 * ExternalLink icon and rel="noreferrer" for safety.
 *
 * A11y: the icon is aria-hidden (the label carries the meaning); external links get an explicit
 * "(opens in a new tab)" via aria-label. Meaning is text+icon, never colour alone.
 */
export interface VerifyLinkProps {
  href: string;
  /** Link text. Default "Verify". */
  label?: string;
  /** Open in a new tab with an external-link icon. */
  external?: boolean;
  className?: string;
}

export function VerifyLink({ href, label = 'Verify', external = false, className }: VerifyLinkProps) {
  const classes = cn(
    'inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded',
    className,
  );

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={classes}
        aria-label={`${label} (opens in a new tab)`}
      >
        {label}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {label}
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}
