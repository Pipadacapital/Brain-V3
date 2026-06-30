'use client';

/**
 * SegmentsContent — visual customer-segment builder (P2).
 *
 * A rule builder for the RFM / lifecycle / affinity / churn-risk conditions that define a customer
 * segment, with a LIVE debounced preview count and the brand's saved segments (create / delete).
 *
 * BFF-only (D-1): every read/write goes through the saved-segments hooks (use-segments.ts) over
 *   GET/POST/DELETE /api/v1/segments + POST /api/v1/segments/preview. brand_id is ALWAYS session-
 *   derived server-side (RLS) — never sent from here.
 *
 * The `definition` is an OPAQUE rule tree ({ version, match, rules[] }) persisted verbatim in
 * ops.saved_segment and re-evaluated at run time over the Silver/Gold serving spine (Brain has NO
 * permanent member list). The preview endpoint returns the brand's ADDRESSABLE customer base today
 * (the rule evaluator runs at segment-evaluation time) — so the preview is labelled honestly as the
 * addressable base, NEVER presented as a fabricated rule-narrowed count.
 *
 * Honesty: counts are bigint-as-string from the BFF (formatted with Intl, not money). no_data →
 * EmptyState, never a fake zero. CSV export is 100% client-side over the already-loaded saved list.
 *
 * A11y: each condition row is a labelled group; the live preview region is aria-live; the save flow
 * is a Radix Dialog (focus-trapped, Esc-closable).
 */

import * as React from 'react';
import Link from 'next/link';
import {
  SlidersHorizontal,
  Plus,
  Trash2,
  Save,
  Download,
  Users,
  FolderOpen,
  X,
  ArrowRight,
} from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import {
  useSavedSegments,
  useCreateSegment,
  useDeleteSegment,
  usePreviewSegment,
} from '@/lib/hooks/use-segments';
import type { SavedSegmentDto, SegmentPreviewResult } from '@brain/contracts';

// ── Condition vocabulary ───────────────────────────────────────────────────────
// Each field maps to a field-specific operator set + value input. The labels mirror the canonical
// RFM/lifecycle segment values the Gold scoring uses (db/iceberg/spark/gold/_segment_rules.py) so a
// rule the user authors here lines up with how Brain already buckets customers.
type FieldKey = 'recency' | 'frequency' | 'monetary' | 'lifecycle' | 'affinity' | 'churn_risk';

interface FieldDef {
  label: string;
  help: string;
  input: 'number' | 'select' | 'text';
  unit?: string;
  placeholder?: string;
  operators: { value: string; label: string }[];
  options?: { value: string; label: string }[];
  defaultOperator: string;
  defaultValue: string;
}

const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  recency: {
    label: 'Recency — days since last order',
    help: 'How recently the customer last purchased.',
    input: 'number',
    unit: 'days',
    placeholder: '30',
    operators: [
      { value: 'lte', label: 'within the last' },
      { value: 'gte', label: 'more than' },
    ],
    defaultOperator: 'lte',
    defaultValue: '30',
  },
  frequency: {
    label: 'Frequency — lifetime orders',
    help: 'Number of orders the customer has placed.',
    input: 'number',
    unit: 'orders',
    placeholder: '2',
    operators: [
      { value: 'gte', label: 'at least' },
      { value: 'lte', label: 'at most' },
      { value: 'eq', label: 'exactly' },
    ],
    defaultOperator: 'gte',
    defaultValue: '2',
  },
  monetary: {
    label: 'Monetary — lifetime value',
    help: 'Lifetime spend threshold (in your brand currency, major units).',
    input: 'number',
    unit: '',
    placeholder: '5000',
    operators: [
      { value: 'gte', label: 'at least' },
      { value: 'lte', label: 'at most' },
    ],
    defaultOperator: 'gte',
    defaultValue: '5000',
  },
  lifecycle: {
    label: 'Lifecycle / RFM segment',
    help: 'The business segment Brain assigns from RFM scoring.',
    input: 'select',
    operators: [
      { value: 'is', label: 'is' },
      { value: 'is_not', label: 'is not' },
    ],
    options: [
      { value: 'VIP', label: 'VIP' },
      { value: 'loyal', label: 'Loyal' },
      { value: 'at_risk', label: 'At-Risk' },
      { value: 'churned', label: 'Churned' },
      { value: 'first_time_buyer', label: 'One-time' },
      { value: 'window_shopper', label: 'Window-shopper' },
    ],
    defaultOperator: 'is',
    defaultValue: 'VIP',
  },
  affinity: {
    label: 'Affinity — product or category',
    help: 'Customers who have engaged with a product or category.',
    input: 'text',
    placeholder: 'e.g. running shoes',
    operators: [
      { value: 'includes', label: 'includes' },
      { value: 'excludes', label: 'excludes' },
    ],
    defaultOperator: 'includes',
    defaultValue: '',
  },
  churn_risk: {
    label: 'Churn risk',
    help: 'Brain’s predicted likelihood the customer lapses.',
    input: 'select',
    operators: [
      { value: 'is', label: 'is' },
      { value: 'is_not', label: 'is not' },
    ],
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    defaultOperator: 'is',
    defaultValue: 'high',
  },
};

const FIELD_ORDER: FieldKey[] = [
  'recency',
  'frequency',
  'monetary',
  'lifecycle',
  'affinity',
  'churn_risk',
];

interface Rule {
  /** Stable client key — also persisted (opaque); harmless on reload. */
  id: string;
  field: FieldKey;
  operator: string;
  value: string;
}

interface SegmentDefinition {
  version: 1;
  match: 'all' | 'any';
  rules: Omit<Rule, 'id'>[];
}

const SEGMENT_VERSION = 1 as const;

function newRule(field: FieldKey): Rule {
  const def = FIELD_DEFS[field];
  return {
    id: Math.random().toString(36).slice(2),
    field,
    operator: def.defaultOperator,
    value: def.defaultValue,
  };
}

/** Serialise the builder state into the opaque rule tree persisted/previewed. */
function toDefinition(match: 'all' | 'any', rules: Rule[]): SegmentDefinition {
  return {
    version: SEGMENT_VERSION,
    match,
    rules: rules.map((r) => ({ field: r.field, operator: r.operator, value: r.value })),
  };
}

/** Best-effort hydrate a saved definition back into editable builder state. */
function fromDefinition(def: Record<string, unknown>): { match: 'all' | 'any'; rules: Rule[] } {
  const match = def.match === 'any' ? 'any' : 'all';
  const rawRules = Array.isArray(def.rules) ? def.rules : [];
  const rules: Rule[] = [];
  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const field = r.field as FieldKey;
    if (!FIELD_DEFS[field]) continue;
    rules.push({
      id: Math.random().toString(36).slice(2),
      field,
      operator: typeof r.operator === 'string' ? r.operator : FIELD_DEFS[field].defaultOperator,
      value: typeof r.value === 'string' ? r.value : String(r.value ?? ''),
    });
  }
  return { match, rules };
}

const COUNT_FMT = new Intl.NumberFormat();
function formatCount(minor: string): string {
  // Counts are bigint-as-string from the BFF — parse exactly, format for display only.
  try {
    return COUNT_FMT.format(BigInt(minor));
  } catch {
    return '—';
  }
}

// ── One editable condition row ──────────────────────────────────────────────────
function ConditionRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: Rule;
  onChange: (next: Rule) => void;
  onRemove: () => void;
}) {
  const def = FIELD_DEFS[rule.field];

  // Switching field resets operator + value to that field's defaults (keep the row's stable id).
  const handleField = (field: FieldKey) => onChange({ ...newRule(field), id: rule.id });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
      {/* Field */}
      <div className="min-w-0 flex-1">
        <Select value={rule.field} onValueChange={(v) => handleField(v as FieldKey)}>
          <SelectTrigger aria-label="Condition field" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_ORDER.map((f) => (
              <SelectItem key={f} value={f}>
                {FIELD_DEFS[f].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Operator */}
      <div className="w-full sm:w-40">
        <Select value={rule.operator} onValueChange={(v) => onChange({ ...rule, operator: v })}>
          <SelectTrigger aria-label="Condition operator" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.operators.map((op) => (
              <SelectItem key={op.value} value={op.value}>
                {op.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Value */}
      <div className="flex w-full items-center gap-2 sm:w-52">
        {def.input === 'select' ? (
          <Select value={rule.value} onValueChange={(v) => onChange({ ...rule, value: v })}>
            <SelectTrigger aria-label="Condition value" className="w-full">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {(def.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            type={def.input === 'number' ? 'number' : 'text'}
            inputMode={def.input === 'number' ? 'numeric' : undefined}
            min={def.input === 'number' ? 0 : undefined}
            value={rule.value}
            placeholder={def.placeholder}
            aria-label="Condition value"
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            className="w-full"
          />
        )}
        {def.unit ? (
          <span className="shrink-0 text-xs text-muted-foreground">{def.unit}</span>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove condition"
        className="shrink-0 self-end text-muted-foreground hover:text-destructive sm:self-center"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

const EXPLAINER = {
  title: 'Segments — Who do I want to target?',
  description:
    'Build a customer segment from recency, frequency, monetary, lifecycle, affinity and churn-risk conditions, see how many customers it reaches, and save it for re-use.',
  sections: [
    {
      heading: 'How the preview count works',
      body: 'The live count is your brand’s addressable customer base (gold_customer_360). Brain stores a segment as its RULE, not a frozen member list — the conditions are applied when the segment is evaluated, so the preview is an honest order-of-magnitude, never a fabricated narrowed number.',
    },
    {
      heading: 'Where segments live',
      body: 'A saved segment is operational state in PostgreSQL (ops.saved_segment), brand-isolated by row-level security. The rule tree is re-evaluated at run time against the Silver/Gold serving spine.',
    },
  ],
  sources: ['ops.saved_segment', 'gold_customer_360'],
};

export function SegmentsContent() {
  const [match, setMatch] = React.useState<'all' | 'any'>('all');
  const [rules, setRules] = React.useState<Rule[]>([newRule('recency')]);

  const [preview, setPreview] = React.useState<SegmentPreviewResult | null>(null);
  const [previewError, setPreviewError] = React.useState(false);

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [segmentName, setSegmentName] = React.useState('');

  const previewMut = usePreviewSegment();
  const createMut = useCreateSegment();
  const deleteMut = useDeleteSegment();
  const { data: saved, isLoading: savedLoading, error: savedError, refetch } = useSavedSegments();

  const definition = React.useMemo(() => toDefinition(match, rules), [match, rules]);

  // Live debounced preview — re-count whenever the rule tree changes (400ms settle).
  const defKey = React.useMemo(() => JSON.stringify(definition), [definition]);
  const runPreview = previewMut.mutateAsync;
  React.useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      setPreviewError(false);
      runPreview(definition as unknown as Record<string, unknown>)
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch(() => {
          if (!cancelled) setPreviewError(true);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // defKey is the stable serialisation of `definition` — deps-narrowed intentionally.
  }, [defKey, runPreview]);

  const addRule = () => {
    const used = new Set(rules.map((r) => r.field));
    const next = FIELD_ORDER.find((f) => !used.has(f)) ?? 'recency';
    setRules((rs) => [...rs, newRule(next)]);
  };
  const updateRule = (id: string, next: Rule) =>
    setRules((rs) => rs.map((r) => (r.id === id ? next : r)));
  const removeRule = (id: string) => setRules((rs) => rs.filter((r) => r.id !== id));

  const loadSaved = (seg: SavedSegmentDto) => {
    const hydrated = fromDefinition(seg.definition);
    setMatch(hydrated.match);
    setRules(hydrated.rules.length > 0 ? hydrated.rules : [newRule('recency')]);
    setSegmentName(seg.name);
    toast({ title: 'Loaded into builder', description: seg.name });
  };

  const handleCreate = async () => {
    const name = segmentName.trim();
    if (name.length === 0) return;
    try {
      await createMut.mutateAsync({
        name,
        definition: definition as unknown as Record<string, unknown>,
      });
      setSaveOpen(false);
      setSegmentName('');
      toast({ title: 'Segment saved', description: name });
    } catch {
      toast({ variant: 'destructive', title: 'Could not save segment', description: 'Please try again.' });
    }
  };

  const handleDelete = async (seg: SavedSegmentDto) => {
    try {
      await deleteMut.mutateAsync(seg.id);
      toast({ title: 'Segment deleted', description: seg.name });
    } catch {
      toast({ variant: 'destructive', title: 'Could not delete segment' });
    }
  };

  const segments = saved?.segments ?? [];

  // Client-side CSV export of the CURRENTLY-LOADED saved list (no server round-trip).
  const exportCsv = () => {
    if (segments.length === 0) return;
    const header = ['name', 'conditions', 'match', 'created_by', 'created_at', 'definition'];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [header.map(esc).join(',')];
    for (const s of segments) {
      const ruleCount = Array.isArray((s.definition as { rules?: unknown[] }).rules)
        ? ((s.definition as { rules?: unknown[] }).rules as unknown[]).length
        : 0;
      const matchMode = (s.definition as { match?: string }).match ?? 'all';
      lines.push(
        [
          esc(s.name),
          esc(String(ruleCount)),
          esc(matchMode),
          esc(s.created_by),
          esc(s.created_at),
          esc(JSON.stringify(s.definition)),
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `segments-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const isPreviewing = previewMut.isPending;

  return (
    <TabShell
      title="Segments"
      description="Who do I want to target?"
      explainer={EXPLAINER}
      actions={
        <Link
          href="/customers"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          Customers
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Builder ───────────────────────────────────────────────────────── */}
        <SectionCard
          className="lg:col-span-2"
          title="Rule builder"
          description="Combine conditions to define your audience."
          actions={
            <div className="flex items-center gap-2">
              <Label htmlFor="match-mode" className="text-xs text-muted-foreground">
                Match
              </Label>
              <Select value={match} onValueChange={(v) => setMatch(v as 'all' | 'any')}>
                <SelectTrigger id="match-mode" aria-label="Match mode" className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All (AND)</SelectItem>
                  <SelectItem value="any">Any (OR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
        >
          <div className="space-y-3">
            {rules.length === 0 ? (
              <EmptyState
                compact
                icon={<SlidersHorizontal />}
                title="No conditions yet"
                description="Add a condition to start building your segment."
                action={
                  <Button type="button" variant="outline" size="sm" onClick={addRule}>
                    <Plus className="mr-1.5 h-4 w-4" /> Add condition
                  </Button>
                }
              />
            ) : (
              rules.map((rule, i) => (
                <div key={rule.id} className="space-y-2">
                  {i > 0 && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {match === 'all' ? 'and' : 'or'}
                      </span>
                    </div>
                  )}
                  <ConditionRow
                    rule={rule}
                    onChange={(next) => updateRule(rule.id, next)}
                    onRemove={() => removeRule(rule.id)}
                  />
                  <p className="pl-1 text-xs text-muted-foreground">{FIELD_DEFS[rule.field].help}</p>
                </div>
              ))
            )}

            {rules.length > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={addRule}>
                <Plus className="mr-1.5 h-4 w-4" /> Add condition
              </Button>
            )}
          </div>
        </SectionCard>

        {/* ── Live preview ──────────────────────────────────────────────────── */}
        <SectionCard title="Live preview" description="Customers this segment reaches.">
          <div aria-live="polite" aria-busy={isPreviewing}>
            {previewError ? (
              <p className="text-sm text-muted-foreground">Couldn’t estimate the audience right now.</p>
            ) : preview === null ? (
              <Skeleton className="h-10 w-32" />
            ) : preview.state === 'no_data' ? (
              <EmptyState
                compact
                icon={<Users />}
                title="No customers yet"
                description="Connect a store and sync customers to size a segment."
              />
            ) : (
              <div className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'text-4xl font-semibold tabular-nums text-foreground transition-opacity',
                      isPreviewing && 'opacity-50',
                    )}
                  >
                    {formatCount(preview.matched_customers)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    of {formatCount(preview.total_customers)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">addressable customers</p>
              </div>
            )}
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            This is your addressable base. Brain stores the segment as a rule and applies your
            conditions when the segment is evaluated — so the saved segment narrows to the matching
            customers at run time.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <Button
              type="button"
              onClick={() => setSaveOpen(true)}
              disabled={rules.length === 0}
            >
              <Save className="mr-1.5 h-4 w-4" /> Save segment
            </Button>
          </div>
        </SectionCard>
      </div>

      {/* ── Saved segments ──────────────────────────────────────────────────── */}
      <SectionCard
        title="Saved segments"
        description="Re-usable segment definitions for this brand."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={segments.length === 0}
          >
            <Download className="mr-1.5 h-4 w-4" /> Export CSV
          </Button>
        }
      >
        {savedError ? (
          <ErrorCard error={savedError} retry={() => refetch()} />
        ) : savedLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : segments.length === 0 ? (
          <EmptyState
            icon={<FolderOpen />}
            title="No saved segments yet"
            description="Build a rule above and save it to re-use across campaigns and analysis."
          />
        ) : (
          <ul className="divide-y divide-border" role="list">
            {segments.map((seg) => {
              const ruleCount = Array.isArray((seg.definition as { rules?: unknown[] }).rules)
                ? ((seg.definition as { rules?: unknown[] }).rules as unknown[]).length
                : 0;
              return (
                <li
                  key={seg.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{seg.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {ruleCount} condition{ruleCount === 1 ? '' : 's'} ·{' '}
                      {new Date(seg.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => loadSaved(seg)}>
                      <FolderOpen className="mr-1.5 h-4 w-4" /> Load
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete segment ${seg.name}`}
                      onClick={() => handleDelete(seg)}
                      disabled={deleteMut.isPending}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {/* ── Save dialog ─────────────────────────────────────────────────────── */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save segment</DialogTitle>
            <DialogDescription>
              Give this segment a name. The rule you built is saved for re-use; brand scope is
              applied automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="segment-name">Name</Label>
            <Input
              id="segment-name"
              value={segmentName}
              maxLength={200}
              placeholder="e.g. High-value at-risk"
              onChange={(e) => setSegmentName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setSaveOpen(false)}>
              <X className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreate}
              disabled={segmentName.trim().length === 0 || createMut.isPending}
            >
              <Save className="mr-1.5 h-4 w-4" />
              {createMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabShell>
  );
}
