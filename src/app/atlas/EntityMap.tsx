'use client';

import type { Entity } from './types';

/**
 * The map: every entity as a chip, grouped in bands, with the relationships
 * that matter shown on selection.
 *
 * WHY NOT MERMAID: the prose atlas draws this as a mermaid flowchart, hand-typed
 * with 23 nodes and ~20 edges. That diagram was already wrong the day it was
 * written — it lists "Network & Telecom" and "E&C" as boxes, which stopped being
 * entities in Fase C. A drawing maintained separately from the catalog drifts
 * exactly like the org charts the atlas itself warns about.
 *
 * So the layout is generated: bands come from `group`, arrows from `parent`,
 * old names from `aliases`, and the dotted boundaries from `notThis` — all
 * fields the catalog screen already edits.
 *
 * Selection, rather than drawing every edge at once: with 23 nodes a full edge
 * mesh is unreadable. Clicking one entity is the question people actually have
 * ("what is this, and what does it get confused with"), and the answer is the
 * only thing drawn.
 */

const BANDS: { key: string; label: string; hint: string }[] = [
  { key: 'GIO', label: 'GIO', hint: 'Infrastructure service lines' },
  { key: 'GDS', label: 'GDS', hint: 'Global Delivery Services' },
  { key: 'Functional', label: 'Functional groups', hint: 'Parent not confirmed' },
  { key: 'Region', label: 'Regions', hint: 'Geographic hubs' },
  { key: 'Business', label: 'Business units', hint: 'GBUs, divisions, subsidiaries' },
];

const BAND_TONE: Record<string, string> = {
  GIO: 'var(--tone-gio-fg)',
  GDS: 'var(--tone-tech-fg)',
  Functional: 'var(--tone-neutral-fg)',
  Region: 'var(--tone-dds-fg)',
  Business: 'var(--tone-vendor-fg)',
};

export default function EntityMap({
  all, selected, onSelect,
}: {
  all: Entity[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const sel = all.find(e => e.name === selected) ?? null;

  // Relationships of the selected entity, all derived from the catalog.
  const related = new Map<string, string>();
  if (sel) {
    if (sel.parent) related.set(sel.parent, 'parent');
    for (const e of all) if (e.parent === sel.name) related.set(e.name, 'child');
    // "not this" names the neighbouring entity inside the prose; matching on
    // that name is what turns the sentence into a drawable edge.
    for (const n of sel.notThis ?? []) {
      for (const e of all) {
        if (e.name !== sel.name && n.includes(e.name)) related.set(e.name, 'boundary');
      }
    }
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Map</span>
        {sel && (
          <button onClick={() => onSelect(null)} className="text-[11px] text-accent-text underline">
            clear selection
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-3">
        {BANDS.map(band => {
          const items = all.filter(e => (e.group ?? 'Business') === band.key);
          if (!items.length) return null;
          return (
            <div key={band.key}>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-[11px] font-bold" style={{ color: BAND_TONE[band.key] }}>
                  {band.label}
                </span>
                <span className="text-[10px] text-ink-faint">{band.hint}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {items.map(e => {
                  const rel = related.get(e.name);
                  const isSel = e.name === sel?.name;
                  // Visual weight by usage: an entity with 42 claims and one
                  // with none must not look equally central.
                  const weight = e.usage.claims >= 20 ? 'font-bold'
                    : e.usage.claims >= 5 ? 'font-semibold' : 'font-normal';
                  const style =
                    isSel ? 'border-accent-border bg-accent-soft text-accent-text'
                    : rel === 'parent' ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                    : rel === 'child' ? 'border-emerald-500/40 bg-emerald-500/5 text-ink-2'
                    : rel === 'boundary' ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
                    : sel ? 'border-line bg-surface-2 text-ink-faint opacity-50'
                    : 'border-line bg-surface-2 text-ink-2 hover:border-line-strong';
                  return (
                    <button
                      key={e.name}
                      onClick={() => onSelect(isSel ? null : e.name)}
                      title={e.scope || e.description}
                      className={`px-2.5 py-1 rounded-lg border text-[12px] transition-all ${style} ${weight}`}
                    >
                      {e.name}
                      {e.usage.claims > 0 && (
                        <span className="ml-1.5 text-[10px] opacity-70 font-mono">
                          {e.usage.claims}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {sel ? (
        <Legend sel={sel} related={related} />
      ) : (
        <p className="text-[11px] text-ink-faint mt-2">
          Number on a chip = anchored claims. Click one to see its parent, its
          children and the entities it gets confused with.
        </p>
      )}
    </div>
  );
}

function Legend({ sel, related }: { sel: Entity; related: Map<string, string> }) {
  const of = (kind: string) => [...related.entries()].filter(([, k]) => k === kind).map(([n]) => n);
  const parents = of('parent');
  const children = of('child');
  const boundaries = of('boundary');

  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
      {parents.length > 0 && (
        <span className="text-emerald-300">part of {parents.join(', ')}</span>
      )}
      {children.length > 0 && (
        <span className="text-emerald-300/80">contains {children.join(', ')}</span>
      )}
      {boundaries.length > 0 && (
        <span className="text-amber-300">confused with {boundaries.join(', ')}</span>
      )}
      {sel.aliases?.length ? (
        <span className="text-ink-muted font-mono">
          old names: {sel.aliases.join(', ')}
        </span>
      ) : null}
      {parents.length + children.length + boundaries.length === 0 && (
        <span className="text-ink-faint">no declared parent, children or boundary</span>
      )}
    </div>
  );
}
