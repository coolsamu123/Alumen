'use client';

import { useState, useMemo } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { getDDSColor, getDecisionColor, getGateColor, categoryText } from '@/lib/constants';

/** Normalize DD/MM/YYYY or YYYY-MM-DD to a Date-sortable ISO string (YYYY-MM-DD). */
function normalizeDate(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // DD/MM/YYYY
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  }
  // Already ISO-ish
  if (/^\d{4}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return '';
}

function formatDisplayDate(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

interface TimelineProject {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  latestDecision: string;
  reviewDate: string;     // normalized ISO
  reviewDateRaw: string;  // display
  costKEur: number | null;
  description: string;
}

export default function TimelineView() {
  const { filtered, selected, setSelected } = useProjectContext();

  const [filterDDS, setFilterDDS] = useState('All');
  const [filterGate, setFilterGate] = useState('All');
  const [filterDecision, setFilterDecision] = useState('All');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const { projects, grouped, monthKeys, ddsOptions, gateOptions, decisionOptions } = useMemo(() => {
    const projects: TimelineProject[] = filtered
      .map(p => {
        const isoDate = normalizeDate(p.lastReviewDate);
        return {
          projectId: p.projectId,
          name: p.name,
          dds: p.dds,
          currentGate: p.currentGate,
          latestDecision: p.latestDecision,
          reviewDate: isoDate,
          reviewDateRaw: isoDate ? formatDisplayDate(isoDate) : '',
          costKEur: p.costKEur,
          description: p.description,
        };
      })
      .filter(p => {
        if (!p.reviewDate) return false;
        if (filterDDS !== 'All' && p.dds !== filterDDS) return false;
        if (filterGate !== 'All' && p.currentGate !== filterGate) return false;
        if (filterDecision !== 'All' && p.latestDecision !== filterDecision) return false;
        return true;
      })
      .sort((a, b) => {
        const cmp = a.reviewDate.localeCompare(b.reviewDate);
        return sortOrder === 'desc' ? -cmp : cmp;
      });

    // Group by month
    const grouped = new Map<string, TimelineProject[]>();
    for (const p of projects) {
      const month = p.reviewDate.slice(0, 7); // YYYY-MM
      if (!grouped.has(month)) grouped.set(month, []);
      grouped.get(month)!.push(p);
    }

    const monthKeys = Array.from(grouped.keys()).sort((a, b) => {
      const cmp = a.localeCompare(b);
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    const ddsOptions = Array.from(new Set(filtered.map(p => p.dds).filter(Boolean))).sort();
    const gateOptions = Array.from(new Set(filtered.map(p => p.currentGate).filter(Boolean))).sort();
    const decisionOptions = Array.from(new Set(filtered.map(p => p.latestDecision).filter(Boolean))).sort();

    return { projects, grouped, monthKeys, ddsOptions, gateOptions, decisionOptions };
  }, [filtered, filterDDS, filterGate, filterDecision, sortOrder]);

  return (
    <div className="flex-1 overflow-auto p-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold text-ink-1">Review Timeline</h2>
          <p className="text-xs text-ink-4 mt-0.5">
            {projects.length} projects across {monthKeys.length} months
          </p>
        </div>
        <button
          onClick={() => setSortOrder(s => s === 'desc' ? 'asc' : 'desc')}
          className="px-3 py-1.5 rounded-lg bg-surface-2 border border-line-strong text-xs text-ink-3 hover:bg-surface-3 transition-colors"
        >
          {sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={filterDDS}
          onChange={e => setFilterDDS(e.target.value)}
          className="bg-surface-2 border border-line-strong text-ink-2 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent-border"
        >
          <option value="All">All DDS</option>
          {ddsOptions.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          value={filterGate}
          onChange={e => setFilterGate(e.target.value)}
          className="bg-surface-2 border border-line-strong text-ink-2 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent-border"
        >
          <option value="All">All Gates</option>
          {gateOptions.map(g => <option key={g} value={g}>Gate {g}</option>)}
        </select>
        <select
          value={filterDecision}
          onChange={e => setFilterDecision(e.target.value)}
          className="bg-surface-2 border border-line-strong text-ink-2 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent-border"
        >
          <option value="All">All Decisions</option>
          {decisionOptions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Timeline */}
      {projects.length === 0 ? (
        <div className="text-center text-ink-muted py-20">
          <div className="text-lg font-semibold text-ink-3 mb-2">No projects match the current filters</div>
          <div className="text-sm">Try adjusting the filters above</div>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[120px] top-0 bottom-0 w-px bg-surface-2" />

          {monthKeys.map(month => {
            const items = grouped.get(month)!;
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const isCurrent = month === currentMonth;

            return (
              <div key={month} className="mb-8">
                {/* Month header */}
                <div className="flex items-center mb-4">
                  <div className="w-[120px] shrink-0 text-right pr-5">
                    <div className={`text-sm font-bold ${isCurrent ? 'text-accent-text2' : 'text-ink-2'}`}>
                      {monthLabel(month)}
                    </div>
                    <div className="text-[11px] text-ink-muted">{items.length} review{items.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className={`w-3 h-3 rounded-full shrink-0 -ml-[6px] z-10 border-2 border-bg ${isCurrent ? 'bg-accent' : 'bg-surface-3'}`} />
                  <div className={`flex-1 h-px ml-4 ${isCurrent ? 'bg-accent/30' : 'bg-surface-2'}`} />
                </div>

                {/* Compact project rows for this month */}
                <div className="ml-[140px] space-y-1">
                  {items.map(p => {
                    const ddsColor = getDDSColor(p.dds);
                    const isSelected = selected === p.projectId;

                    return (
                      <div
                        key={`${p.projectId}-${p.reviewDate}`}
                        onClick={() => setSelected(isSelected ? null : p.projectId)}
                        className={`flex items-center gap-2 bg-surface-1/60 border border-line rounded-lg px-3 py-1.5 hover:bg-surface-2/50 hover:border-line-strong transition-colors cursor-pointer
                          ${isSelected ? 'border-accent-border ring-1 ring-accent-border/30' : ''}`}
                      >
                        {/* Date */}
                        <span className="text-[11px] text-ink-muted font-mono w-[72px] shrink-0">
                          {p.reviewDateRaw}
                        </span>

                        {/* Project ID */}
                        <span className="text-[11px] font-mono font-semibold shrink-0 w-[90px]" style={{ color: categoryText(ddsColor) }}>
                          {p.projectId}
                        </span>

                        {/* Gate badge */}
                        {p.currentGate ? (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold shrink-0"
                            style={{ background: `${getGateColor(p.currentGate)}20`, color: categoryText(getGateColor(p.currentGate)) }}
                          >
                            G{p.currentGate}
                          </span>
                        ) : <span className="w-6 shrink-0" />}

                        {/* Decision badge */}
                        {p.latestDecision ? (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0"
                            style={{ background: `${getDecisionColor(p.latestDecision)}22`, color: categoryText(getDecisionColor(p.latestDecision)) }}
                          >
                            {p.latestDecision}
                          </span>
                        ) : <span className="w-10 shrink-0" />}

                        {/* Name */}
                        <span className="text-[11px] text-ink-3 truncate flex-1 min-w-0">
                          {p.name && p.name !== p.projectId ? p.name : ''}
                        </span>

                        {/* DDS */}
                        {p.dds && (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0"
                            style={{ background: `${ddsColor}18`, color: categoryText(ddsColor) }}
                          >
                            {p.dds}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
