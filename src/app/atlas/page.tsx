'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * The entity atlas.
 *
 * Generated from the catalog and the database, never transcribed. The prose
 * version (ATLAS_ENTIDADES.md) warns that org charts go stale, and proved it:
 * written just before Fase C, it still says the catalog "has the old text" and
 * that three acronym fixes are pending — both untrue by the time anyone reads
 * it. A hand-kept copy here would drift the same way.
 *
 * So: entity text comes from /admin/catalog, usage counts come from the live
 * database, and old-name lookups come from the same alias maps the normaliser
 * uses. Nothing to keep in sync by hand.
 */

import EntityMap from './EntityMap';
import type { Entity } from './types';

interface Atlas {
  gio: Entity[];
  dds: Entity[];
  oldNames: { from: string; to: string; scope: string }[];
}

export default function AtlasPage() {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  // Selecting on the map filters the cards: both halves answer the same
  // question, and keeping them independent would mean searching twice.
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/atlas')
      .then(r => r.json())
      .then(d => (d.error ? setError(d.error) : setAtlas(d)))
      .catch(e => setError(String(e)));
  }, []);

  // Search covers name, signals AND old names — typing "BIS E&C" and landing
  // on InnoTech is this page's main use, not an extra.
  const matches = (e: Entity) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return [e.name, e.scope, e.description, ...(e.signals ?? []), ...(e.aliases ?? [])]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().includes(t));
  };

  const oldHits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !atlas) return [];
    return atlas.oldNames.filter(o => o.from.toLowerCase().includes(t));
  }, [q, atlas]);

  if (error) return <p className="p-6 text-sm text-rose-400">{error}</p>;
  if (!atlas) return <p className="p-6 text-sm text-ink-muted">Loading…</p>;

  const all = [...atlas.gio, ...atlas.dds];
  const visible = (e: Entity) => matches(e) && (!selected || e.name === selected);

  const groups: { kind: string; title: string; sub: string; items: Entity[] }[] = [
    { kind: 'gio', title: 'GIO · Global Infrastructure Operations',
      sub: 'Five service lines. GIO itself owns projects but is never an impact target.',
      items: atlas.gio.filter(visible) },
    { kind: 'dds', title: 'DDS · Digital Delivery Services',
      sub: 'Regions, business divisions and functional groups.',
      items: atlas.dds.filter(visible) },
  ];

  return (
    <div className="min-h-screen bg-bg text-ink-1">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-xl font-extrabold mb-1">Entity atlas</h1>
        <p className="text-[13px] text-ink-muted leading-relaxed mb-5">
          What each GIO service line and DDS entity covers, where it stops, which
          old names still resolve to it, and how much Alumen actually uses it.
          Generated from the catalog and the live database — edit an entity in{' '}
          <a href="/admin/catalog" className="text-accent-text underline">Catalog</a>{' '}
          and this page follows.
        </p>

        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search a name, an old name, or a signal — e.g. BIS E&C, Zscaler, DDS HHC"
          className="w-full mb-6 px-3 py-2.5 rounded-xl bg-surface-1 border border-line
                     text-sm outline-none focus:border-accent-border"
        />

        <EntityMap all={all} selected={selected} onSelect={setSelected} />

        {oldHits.length > 0 && (
          <div className="mb-6 rounded-xl border border-accent-border bg-accent-soft p-4">
            <div className="text-[10px] uppercase tracking-wider text-accent-text mb-2">
              Old name → entity
            </div>
            {oldHits.map(o => (
              <div key={o.from} className="text-[13px] mb-1">
                <span className="font-mono">{o.from}</span>
                <span className="text-ink-faint"> → </span>
                <strong>{o.to}</strong>
                <span className="text-[11px] text-ink-muted"> · {o.scope}</span>
              </div>
            ))}
          </div>
        )}

        {groups.map(g => g.items.length > 0 && (
          <section key={g.kind} className="mb-8">
            <h2 className="text-[13px] font-bold text-ink-1">{g.title}</h2>
            <p className="text-[11px] text-ink-muted mb-3">{g.sub}</p>
            <div className="space-y-3">
              {g.items.map(e => <Card key={e.name} e={e} />)}
            </div>
          </section>
        ))}

        {groups.every(g => g.items.length === 0) && oldHits.length === 0 && (
          <p className="text-sm text-ink-muted">No entity matches “{q}”.</p>
        )}
      </div>
    </div>
  );
}

function Card({ e }: { e: Entity }) {
  const { owners, claims, touched } = e.usage;
  return (
    <div className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-baseline gap-2 flex-wrap mb-1.5">
        <strong className="text-[15px]">{e.name}</strong>
        {e.parent && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-2 text-ink-4">
            part of {e.parent}
          </span>
        )}
        <span className="ml-auto text-[11px] text-ink-faint font-mono">
          {owners} owned · {claims} claims · {touched} touched
        </span>
      </div>

      <p className="text-[13px] text-ink-2 leading-relaxed mb-2">
        {e.scope || e.description}
      </p>

      {e.aliases?.length ? (
        <p className="text-[11px] text-ink-muted mb-1.5">
          <span className="text-ink-faint">also written as </span>
          <span className="font-mono">{e.aliases.join(', ')}</span>
        </p>
      ) : null}

      {/* The boundary is what gets consulted most: it is where you decide
          between two close entities, and where extraction erred most. */}
      {e.notThis?.map((n, i) => (
        <p key={i} className="text-[12px] text-amber-400/90 leading-relaxed mb-1">
          <span className="font-semibold">not this: </span>{n}
        </p>
      ))}

      {e.signals?.length ? (
        <p className="text-[11px] text-ink-faint mt-2">
          signals: {e.signals.join(' · ')}
        </p>
      ) : null}

      {e.notes && (
        <p className="text-[11px] text-ink-muted mt-2 italic">{e.notes}</p>
      )}
    </div>
  );
}
