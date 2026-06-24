/**
 * formatMoneyDisplay — multi-currency render safety.
 *
 * Regression: a KWD order crashed the dashboard because the old formatter threw on any currency
 * outside a 3-item allowlist. A render must NEVER throw on a real-world currency.
 */
import { describe, it, expect } from 'vitest';
import { formatMoneyDisplay } from './money-display.js';

describe('formatMoneyDisplay', () => {
  it('renders the 2-decimal currencies', () => {
    expect(formatMoneyDisplay('123450', 'INR')).toContain('1,234.50');
    expect(formatMoneyDisplay('50000', 'AED')).toContain('500.00');
  });

  it('renders KWD with 3 decimals (1000 fils per dinar) — the crash currency', () => {
    // 12500 fils = 12.500 KWD. Must NOT throw, must show 3 decimals.
    const out = formatMoneyDisplay('12500', 'KWD');
    expect(out).toContain('12.500');
  });

  it('renders a currency outside the supported set without throwing (USD)', () => {
    expect(() => formatMoneyDisplay('8900', 'USD')).not.toThrow();
    expect(formatMoneyDisplay('8900', 'USD')).toContain('89');
  });

  it('falls back gracefully (no throw) on an unknown/ICU-unrecognised code', () => {
    const out = formatMoneyDisplay('12300', 'ZZZ');
    expect(out).toContain('ZZZ');
    expect(out).toContain('123');
  });

  it('handles fractional minor-unit strings (CAC/LTV ratios) without crashing', () => {
    expect(() => formatMoneyDisplay('0.0000', 'INR')).not.toThrow();
    expect(() => formatMoneyDisplay('12345.6789', 'KWD')).not.toThrow();
  });
});
