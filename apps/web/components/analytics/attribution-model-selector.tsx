'use client';

/**
 * AttributionModelSelector — the model selector for the attribution surface.
 *
 * Five deterministic models (position_based is the brand default) + the data-driven model:
 *   - first_touch    — 100% to the first touch.
 *   - last_touch     — 100% to the last touch.
 *   - linear         — even 1/N across all touches.
 *   - position_based — 40% first / 40% last / 20% across the middle (the default).
 *   - time_decay     — recency-weighted: credit halves every half-life of touch positions, so
 *                      touches closer to conversion earn exponentially more.
 *   - data_driven    — Markov removal-effect: credit by each channel's MODELED contribution to
 *                      conversion (learned from the whole journey corpus), not its position.
 *
 * The model is LOCAL UI state lifted into the parent (it drives the BFF query key, so a
 * change re-fetches every attribution read — not Redux, not URL: it's an ephemeral view
 * cut on a single surface, matching the state-ownership split). Each model carries a
 * one-line explanation so the operator understands what the weights mean.
 *
 * A11y: a labelled segmented control (radio group) — each option is keyboard-reachable
 * via arrow keys, aria-pressed reflects selection, and the active option is distinguished
 * by text weight + a visible label (never colour alone). A descriptive caption announces
 * the selected model's weighting rule via aria-live.
 */

import type { AttributionModel } from '@/lib/api/types';

interface ModelOption {
  value: AttributionModel;
  label: string;
  rule: string;
}

const MODELS: ModelOption[] = [
  { value: 'position_based', label: 'Position-based', rule: '40% of the credit to the first touch, 40% to the last, 20% shared in between (default)' },
  { value: 'data_driven', label: 'Data-driven', rule: 'Learned from your own data: channels earn credit by how much they actually drive purchases' },
  { value: 'time_decay', label: 'Time-decay', rule: 'Touches closer to the purchase earn more credit' },
  { value: 'linear', label: 'Linear', rule: 'Every touch gets an equal share of the credit' },
  { value: 'first_touch', label: 'First-touch', rule: 'All credit to the first touch that brought the customer' },
  { value: 'last_touch', label: 'Last-touch', rule: 'All credit to the last touch before the purchase' },
];

/** Human display name for an attribution model id (e.g. position_based → "Position-based"). */
export function attributionModelLabel(model: AttributionModel): string {
  return MODELS.find((m) => m.value === model)?.label ?? model.replace(/_/g, ' ');
}

interface AttributionModelSelectorProps {
  model: AttributionModel;
  onChange: (model: AttributionModel) => void;
  className?: string;
}

export function AttributionModelSelector({
  model,
  onChange,
  className,
}: AttributionModelSelectorProps) {
  const active = MODELS.find((m) => m.value === model) ?? MODELS[0];

  return (
    <div className={className} data-testid="attribution-model-selector">
      <div
        role="radiogroup"
        aria-label="Attribution model"
        className="inline-flex flex-wrap rounded-md border border-border p-0.5"
      >
        {MODELS.map((m) => {
          const selected = m.value === model;
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(m.value)}
              data-testid={`attribution-model-${m.value}`}
              title={m.rule}
              className={
                selected
                  ? 'rounded px-3 py-1 text-xs font-semibold bg-foreground text-background'
                  : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
              }
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {/* Announce the selected model's weighting rule (deterministic — not a model number). */}
      <p
        className="mt-1.5 text-xs text-muted-foreground"
        aria-live="polite"
        data-testid="attribution-model-rule"
      >
        {active.rule}
      </p>
    </div>
  );
}
