'use client';

import { useMemo } from 'react';
import { useProjectContext } from '@/context/ProjectContext';

export default function Toolbar() {
  const { projects, filtered, links, filters, setFilters, view } = useProjectContext();
  const showSeverity = view === 'impact';

  const ddsList = useMemo(() => {
    const vals = new Set(projects.map(p => p.dds).filter(Boolean));
    return ['All', ...Array.from(vals).sort()];
  }, [projects]);

  const gateList = useMemo(() => {
    const vals = new Set(projects.map(p => p.currentGate).filter(Boolean));
    return ['All', ...Array.from(vals).sort()];
  }, [projects]);

  const decisionList = useMemo(() => {
    const vals = new Set(projects.map(p => p.latestDecision).filter(Boolean));
    return ['All', ...Array.from(vals).sort()];
  }, [projects]);

  const yearList = useMemo(() => {
    const years = new Set(
      projects
        .map(p => parseInt(p.lastReviewDate?.slice(0, 4)))
        .filter(y => !isNaN(y) && y > 2000)
    );
    return Array.from(years).sort();
  }, [projects]);

  return (
    <div className="px-6 py-2.5 border-b border-line flex items-center gap-3 bg-surface flex-wrap">
      <span className="text-xs text-ink-muted mr-1">Filter:</span>

      <select
        value={filters.dds}
        onChange={e => setFilters({ ...filters, dds: e.target.value })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
      >
        {ddsList.map(d => <option key={d} value={d}>{d === 'All' ? 'All DDS' : d}</option>)}
      </select>

      <select
        value={filters.gate}
        onChange={e => setFilters({ ...filters, gate: e.target.value })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
      >
        {gateList.map(g => <option key={g} value={g}>{g === 'All' ? 'All Gates' : `Gate ${g}`}</option>)}
      </select>

      <select
        value={filters.decision}
        onChange={e => setFilters({ ...filters, decision: e.target.value })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
      >
        {decisionList.map(d => <option key={d} value={d}>{d === 'All' ? 'All Decisions' : d}</option>)}
      </select>

      {showSeverity && (
        <select
          value={filters.severity}
          onChange={e => setFilters({ ...filters, severity: e.target.value })}
          className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
          title="Filter impact relationships by severity"
        >
          <option value="All">All Severity</option>
          <option value="high">High</option>
          <option value="low">Low</option>
        </select>
      )}

      <span className="text-xs text-ink-muted ml-1">Year:</span>
      <select
        value={filters.yearFrom ?? ''}
        onChange={e => setFilters({ ...filters, yearFrom: e.target.value ? Number(e.target.value) : null })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
      >
        <option value="">From</option>
        {yearList.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      <select
        value={filters.yearTo ?? ''}
        onChange={e => setFilters({ ...filters, yearTo: e.target.value ? Number(e.target.value) : null })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-2.5 py-1 text-[13px] focus:outline-none focus:border-accent-border"
      >
        <option value="">To</option>
        {yearList.map(y => <option key={y} value={y}>{y}</option>)}
      </select>

      <input
        type="text"
        placeholder="Search projects..."
        value={filters.search}
        onChange={e => setFilters({ ...filters, search: e.target.value })}
        className="bg-surface-2 border border-line-strong text-ink-2 rounded-md px-3 py-1 text-[13px] focus:outline-none focus:border-accent-border w-48"
      />

      <div className="flex-1" />
      <span className="text-xs text-ink-muted">
        {filtered.length} projects · {links.length} connections
      </span>
    </div>
  );
}
