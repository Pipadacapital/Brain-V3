/**
 * a11y helper — wraps @axe-core/playwright for use in Playwright specs.
 *
 * Contract:
 *   - Fails the test on any `serious` or `critical` impact violations.
 *   - Logs (but does not fail on) `minor` and `moderate` violations so they
 *     are visible in CI output without blocking on noise from third-party widgets.
 *   - Scoped to the document root by default; callers can narrow scope via opts.
 *
 * Usage:
 *   import { expectNoA11yViolations } from './helpers/a11y';
 *   await expectNoA11yViolations(page);
 *   // or with options:
 *   await expectNoA11yViolations(page, { include: [['main']] });
 */

import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export interface A11yOptions {
  /** axe include selectors — passed to AxeBuilder.include(). Default: whole document. */
  include?: string[][];
  /** axe exclude selectors — passed to AxeBuilder.exclude(). */
  exclude?: string[][];
}

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

export async function expectNoA11yViolations(page: Page, opts?: A11yOptions): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);

  if (opts?.include) {
    for (const selector of opts.include) {
      builder = builder.include(selector);
    }
  }
  if (opts?.exclude) {
    for (const selector of opts.exclude) {
      builder = builder.exclude(selector);
    }
  }

  const results = await builder.analyze();

  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
  const nonBlocking = results.violations.filter((v) => !BLOCKING_IMPACTS.has(v.impact ?? ''));

  if (nonBlocking.length > 0) {
    console.warn(
      `[a11y] ${nonBlocking.length} minor/moderate violation(s) (not blocking):\n` +
        nonBlocking
          .map((v) => `  [${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} node(s))`)
          .join('\n'),
    );
  }

  if (blocking.length > 0) {
    const detail = blocking
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.description}\n` +
          v.nodes
            .slice(0, 3)
            .map((n) => `    - ${n.html}`)
            .join('\n'),
      )
      .join('\n');

    expect(
      blocking,
      `Found ${blocking.length} serious/critical a11y violation(s):\n${detail}`,
    ).toHaveLength(0);
  }
}
