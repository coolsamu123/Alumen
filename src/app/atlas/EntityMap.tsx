'use client';

import { useMemo, useState } from 'react';
import type { Entity } from './types';

/**
 * The map, drawn.
 *
 * Zones as bordered bands, entities as boxes, and real edges between them:
 * hierarchy, renaming, boundary. Positions are COMPUTED from the data rather
 * than authored, which is the whole reason this replaces the mermaid diagram in
 * ATLAS_ENTIDADES.md — that one was hand-typed and already listed "Network &
 * Telecom" and "E&C" as live boxes the day after Fase C retired them.
 *
 * Layout is deterministic: zones are columns in a fixed order, entities stack
 * inside their zone, and every coordinate falls out of that. No physics, no
 * randomness — the same catalog always draws the same picture, so people can
 * learn where things are.
 */

type Metric = 'claims' | 'owners';

const ZONES: { key: string; label: string; tone: string }[] = [
  { key: 'GIO', label: 'GIO · INFRASTRUCTURE', tone: '#22d3ee' },
  { key: 'GDS', label: 'GDS · DELIVERY', tone: '#a78bfa' },
  { key: 'Functional', label: 'FUNCTIONAL GROUPS', tone: '#94a3b8' },
  { key: 'Region', label: 'DDS REGIONS', tone: '#34d399' },
  { key: 'Business', label: 'GBUs & SUBSIDIARIES', tone: '#fbbf24' },
];

// Fixed geometry: every coordinate below derives from these numbers, so
// adjusting the drawing means editing here, not fifty scattered offsets.
const NODE_W = 190;
const NODE_H = 46;
const NODE_GAP = 12;
const ZONE_PAD = 16;
const ZONE_HEAD = 30;
const COL_GAP = 68;
const TOP = 16;
const HEAD_H = 34;
// Left gutter so same-column boundary edges have somewhere to run.
const GUTTER = 52;

interface Placed {
  e: Entity;
  x: number; y: number;
  zone: string;
}

export default function EntityMap({
  all, selected, onSelect,
}: {
  all: Entity[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const [metric, setMetric] = useState<Metric>('claims');

  // Group heads: a `parent` that names something which is NOT an entity —
  // "GIO", "GDS". They are groupings, never impact targets, so they have no
  // catalog card; without a node for them the five service lines would point at
  // nothing and the hierarchy would vanish from the drawing. Derived, not
  // listed: adding a parent in the catalog creates its head automatically.
  const heads = useMemo(() => {
    const names = new Set(all.map(e => e.name));
    const out = new Map<string, string>();   // head name -> zone it sits in
    for (const e of all) {
      if (e.parent && !names.has(e.parent)) out.set(e.parent, e.group ?? 'Business');
    }
    return out;
  }, [all]);

  const { placed, zoneBoxes, width, height, headPos } = useMemo(() => {
    const placed: Placed[] = [];
    const headPos = new Map<string, { x: number; y: number }>();
    const zoneBoxes: { key: string; label: string; tone: string; x: number; y: number; w: number; h: number }[] = [];
    let x = ZONE_PAD + GUTTER;

    for (const z of ZONES) {
      const items = all.filter(e => (e.group ?? 'Business') === z.key);
      if (!items.length) continue;
      const head = [...heads.entries()].find(([, zone]) => zone === z.key)?.[0];
      const headSpace = head ? HEAD_H + NODE_GAP : 0;
      const h = ZONE_HEAD + headSpace + items.length * NODE_H
              + (items.length - 1) * NODE_GAP + ZONE_PAD * 2;
      zoneBoxes.push({ ...z, x, y: TOP, w: NODE_W + ZONE_PAD * 2, h });

      const top = TOP + ZONE_HEAD + ZONE_PAD;
      if (head) headPos.set(head, { x: x + ZONE_PAD, y: top });

      items.forEach((e, i) => {
        placed.push({
          e, zone: z.key,
          x: x + ZONE_PAD,
          y: top + headSpace + i * (NODE_H + NODE_GAP),
        });
      });
      x += NODE_W + ZONE_PAD * 2 + COL_GAP;
    }

    const width = x - COL_GAP + ZONE_PAD;
    const height = Math.max(...zoneBoxes.map(b => b.y + b.h)) + TOP;
    return { placed, zoneBoxes, width, height, headPos };
  }, [all, heads]);

  const byName = useMemo(() => new Map(placed.map(p => [p.e.name, p])), [placed]);

  // Edges derived from the catalog. Nothing here is hand-authored.
  const edges = useMemo(() => {
    const out: { from: Placed; to: Placed; kind: 'hierarchy' | 'boundary' }[] = [];
    for (const p of placed) {
      if (p.e.parent) {
        const parent = byName.get(p.e.parent);
        if (parent) out.push({ from: p, to: parent, kind: 'hierarchy' });
      }
      // The boundary lives as prose in `notThis`; matching the neighbour's name
      // inside that sentence is what makes it drawable.
      for (const n of p.e.notThis ?? []) {
        for (const other of placed) {
          if (other.e.name === p.e.name) continue;
          if (n.includes(other.e.name) && !out.some(o =>
            (o.from === other && o.to === p) || (o.from === p && o.to === other))) {
            out.push({ from: p, to: other, kind: 'boundary' });
          }
        }
      }
    }
    return out;
  }, [placed, byName]);

  const max = Math.max(1, ...all.map(e => e.usage[metric]));
  const sel = selected ? byName.get(selected) : null;

  // An entity is highlighted when it is selected or shares an edge with it.
  const linked = useMemo(() => {
    if (!sel) return null;
    const s = new Set<string>([sel.e.name]);
    for (const ed of edges) {
      if (ed.from.e.name === sel.e.name) s.add(ed.to.e.name);
      if (ed.to.e.name === sel.e.name) s.add(ed.from.e.name);
    }
    return s;
  }, [sel, edges]);

  const center = (p: Placed) => ({ cx: p.x + NODE_W / 2, cy: p.y + NODE_H / 2 });

  const path = (a: Placed, b: Placed) => {
    const A = center(a), B = center(b);
    const sameColumn = Math.abs(A.cx - B.cx) < 1;
    if (sameColumn) {
      // Route through the left gutter, clear of the zone. The first version
      // bowed by only 40px — still inside the zone — so every boundary line
      // ran straight across the boxes between its two ends.
      const gutter = a.x - GUTTER * 0.6;
      const top = Math.min(A.cy, B.cy), bot = Math.max(A.cy, B.cy);
      return `M ${a.x} ${A.cy} C ${gutter} ${A.cy}, ${gutter} ${top}, ${gutter} ${(top + bot) / 2}`
           + ` C ${gutter} ${bot}, ${gutter} ${B.cy}, ${b.x} ${B.cy}`;
    }
    const dx = (B.cx - A.cx) / 2;
    return `M ${A.cx} ${A.cy} C ${A.cx + dx} ${A.cy}, ${B.cx - dx} ${B.cy}, ${B.cx} ${B.cy}`;
  };

  return (
    <div className="mb-6">
      {/* ── controls and legend ── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint">Intensity</span>
          <div className="flex rounded-lg border border-line overflow-hidden">
            {(['claims', 'owners'] as Metric[]).map(m => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1 text-[12px] transition-colors ${
                  metric === m ? 'bg-accent-soft text-accent-text' : 'text-ink-4 hover:bg-surface-2'
                }`}
              >
                {m === 'claims' ? 'Claims' : 'Owned projects'}
              </button>
            ))}
          </div>
        </div>

        <Legend />

        {sel && (
          <button onClick={() => onSelect(null)} className="ml-auto text-[11px] text-accent-text underline">
            clear
          </button>
        )}
      </div>

      {/* ── the diagram ── */}
      <div className="rounded-xl border border-line bg-surface-1 overflow-x-auto">
        <svg width={width} height={height} className="block" style={{ minWidth: '100%' }}>
          <defs>
            <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--border-strong)" />
            </marker>
          </defs>

          {zoneBoxes.map(z => (
            <g key={z.key}>
              <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={12}
                fill="transparent" stroke={z.tone} strokeOpacity={0.28} />
              <text x={z.x + ZONE_PAD} y={z.y + 20} fontSize={10} fontWeight={700}
                fill={z.tone} letterSpacing="0.08em">{z.label}</text>
            </g>
          ))}

          {/* Hierarchy into the group heads. Drawn before the boxes so a line
              never crosses over a label. */}
          {placed.filter(p => p.e.parent && headPos.has(p.e.parent)).map(p => {
            const h = headPos.get(p.e.parent!)!;
            const dim = linked && !linked.has(p.e.name);
            return (
              <path key={`h-${p.e.name}`} fill="none"
                d={`M ${p.x + NODE_W / 2} ${p.y} C ${p.x + NODE_W / 2} ${p.y - 14},
                    ${h.x + NODE_W / 2} ${h.y + HEAD_H + 14}, ${h.x + NODE_W / 2} ${h.y + HEAD_H}`}
                stroke="var(--border-strong)" strokeWidth={1.4}
                opacity={dim ? 0.12 : 0.75} markerEnd="url(#arrow)" />
            );
          })}

          {[...headPos.entries()].map(([name, pos]) => {
            const zone = ZONES.find(z => z.key === heads.get(name))!;
            return (
              <g key={`head-${name}`}>
                <title>{name} is a grouping, not an impact target</title>
                <rect x={pos.x} y={pos.y} width={NODE_W} height={HEAD_H} rx={HEAD_H / 2}
                  fill={zone.tone} fillOpacity={0.18}
                  stroke={zone.tone} strokeOpacity={0.9} strokeWidth={1.5} />
                <text x={pos.x + NODE_W / 2} y={pos.y + 22} fontSize={13} fontWeight={700}
                  textAnchor="middle" fill={zone.tone}>{name}</text>
              </g>
            );
          })}

          {edges.map((ed, i) => {
            const dim = linked && !(linked.has(ed.from.e.name) && linked.has(ed.to.e.name));
            const boundary = ed.kind === 'boundary';
            return (
              <path key={i} d={path(ed.from, ed.to)} fill="none"
                stroke={boundary ? '#f59e0b' : 'var(--border-strong)'}
                strokeWidth={boundary ? 1.2 : 1.6}
                strokeDasharray={boundary ? '3 4' : undefined}
                markerEnd={boundary ? undefined : 'url(#arrow)'}
                opacity={dim ? 0.12 : boundary ? 0.7 : 0.9} />
            );
          })}

          {placed.map(p => {
            const v = p.e.usage[metric];
            const isSel = p.e.name === selected;
            const dim = linked && !linked.has(p.e.name);
            const zone = ZONES.find(z => z.key === p.zone)!;
            // Fill scales with usage: what the portfolio touches most has to
            // stand out before anyone reads a single label.
            const fill = v / max;
            return (
              <g key={p.e.name} onClick={() => onSelect(isSel ? null : p.e.name)}
                style={{ cursor: 'pointer' }} opacity={dim ? 0.25 : 1}>
                <title>{p.e.scope || p.e.description}</title>
                <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={8}
                  fill={zone.tone} fillOpacity={0.06 + fill * 0.22}
                  stroke={isSel ? 'var(--accent-border)' : zone.tone}
                  strokeOpacity={isSel ? 1 : 0.5}
                  strokeWidth={isSel ? 2 : 1} />
                <text x={p.x + 12} y={p.y + 19} fontSize={12} fontWeight={600} fill="var(--ink-1)">
                  {p.e.name.length > 24 ? p.e.name.slice(0, 23) + '…' : p.e.name}
                </text>
                <text x={p.x + 12} y={p.y + 34} fontSize={10} fill="var(--ink-muted)"
                  fontFamily="ui-monospace, monospace">
                  {v} {metric === 'claims' ? 'claims' : 'owned'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {sel ? (
        <SelectionNote sel={sel.e} all={all} />
      ) : (
        <p className="text-[11px] text-ink-faint mt-2">
          Box fill shows how much the portfolio uses each entity. Click one to
          isolate its hierarchy and the entities it gets confused with.
        </p>
      )}
    </div>
  );
}

function Legend() {
  const items = [
    { label: 'Hierarchy', color: 'var(--border-strong)', dash: undefined },
    { label: 'Boundary', color: '#f59e0b', dash: '3 4' },
  ];
  // A pill is a grouping, never an impact target — GIO owns projects but
  // impacts on it go to its service lines (§3.1, items 1 and 7). Saying so in
  // the legend is cheaper than everyone rediscovering it.
  return (
    <div className="flex items-center gap-4">
      <span className="flex items-center gap-1.5 text-[11px] text-ink-4">
        <svg width="22" height="12">
          <rect x="1" y="2" width="20" height="8" rx="4" fill="var(--ink-faint)"
            fillOpacity="0.25" stroke="var(--ink-faint)" />
        </svg>
        Grouping (not a target)
      </span>
      {items.map(i => (
        <span key={i.label} className="flex items-center gap-1.5 text-[11px] text-ink-4">
          <svg width="22" height="8">
            <line x1="0" y1="4" x2="22" y2="4" stroke={i.color} strokeWidth="1.6"
              strokeDasharray={i.dash} />
          </svg>
          {i.label}
        </span>
      ))}
    </div>
  );
}

function SelectionNote({ sel, all }: { sel: Entity; all: Entity[] }) {
  const children = all.filter(e => e.parent === sel.name).map(e => e.name);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
        {sel.parent && <span className="text-ink-3">part of <strong>{sel.parent}</strong></span>}
        {children.length > 0 && <span className="text-ink-3">contains {children.join(', ')}</span>}
        {sel.aliases?.length ? (
          <span className="text-ink-muted font-mono">also written as {sel.aliases.join(', ')}</span>
        ) : null}
      </div>

      {/* The rule, not just the neighbour's name. "confused with User Workplace"
          told nobody anything — the value is the sentence that says where the
          line falls, which is exactly what someone classifying a document needs
          and what the model gets wrong. */}
      {(sel.notThis ?? []).length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1.5">
            Where {sel.name} stops
          </div>
          {(sel.notThis ?? []).map((n, i) => (
            <p key={i} className="text-[12px] text-ink-2 leading-relaxed mb-1 last:mb-0">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
