'use client';

import { useEffect, useState } from 'react';
import ArchitectureCanvas from './canvas';
import DetailPanel from './panels/DetailPanel';
import DataFlowLive from '@/components/DataFlowLive';
import { getStage } from './stages';

export interface StromStats {
  projects: number;
  documents: { success: number; skipped: number; error: number; total: number };
  goals: { success: number; v4: number };
  impacts: { total: number; withCitations: number; withChain: number };
  deepDives: number;
}

type SubTab = 'architecture' | 'dataflow';

export default function StromArchitecture() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<StromStats | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('architecture');
  const selectedStage = selectedId ? getStage(selectedId) : null;

  // Live stats — polled lightly. Cheap query, ~1KB response.
  useEffect(() => {
    let alive = true;
    const fetchStats = () =>
      fetch('/api/strom/stats')
        .then(r => r.json())
        .then(d => { if (alive && !d.error) setStats(d); })
        .catch(() => {});
    fetchStats();
    const id = setInterval(fetchStats, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <Header stats={stats} subTab={subTab} onSubTab={setSubTab} />
      <div className="flex-1 flex overflow-hidden">
        {subTab === 'architecture' ? (
          <>
            <div className="flex-1 min-w-0">
              <ArchitectureCanvas selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            {selectedStage && (
              <DetailPanel stage={selectedStage} stats={stats} onClose={() => setSelectedId(null)} />
            )}
          </>
        ) : (
          <DataFlowLive />
        )}
      </div>
    </div>
  );
}

function Header({ stats, subTab, onSubTab }: { stats: StromStats | null; subTab: SubTab; onSubTab: (t: SubTab) => void }) {
  return (
    <div className="shrink-0 px-6 py-3 border-b border-line bg-surface-1">
      <div className="flex items-center justify-between gap-6 flex-wrap">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-lg font-bold text-ink-1">Alumen</h1>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {subTab === 'architecture'
                ? 'Click any stage to inspect inputs, outputs, code, and run controls.'
                : 'Animated data flow through the Alumen pipeline.'}
            </p>
          </div>
          <div className="flex items-center gap-1 ml-2">
            {(['architecture', 'dataflow'] as SubTab[]).map(t => (
              <button
                key={t}
                onClick={() => onSubTab(t)}
                className={`px-3 py-1 rounded text-[12px] font-medium transition-all cursor-pointer
                  ${subTab === t
                    ? 'bg-accent-soft border border-accent-border text-accent-text'
                    : 'text-ink-4 hover:bg-surface-2 border border-transparent'
                  }`}
              >
                {t === 'architecture' ? '⬡ Pipeline' : '⟶ Data Flow'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <Counter label="Projects" value={stats?.projects} tone="cyan" />
          <Counter label="Docs (success)" value={stats?.documents.success} tone="cyan" sub={stats ? `${stats.documents.skipped} skipped` : undefined} />
          <Counter label="Goals v4" value={stats?.goals.v4} tone="emerald" />
          <Counter label="Impacts" value={stats?.impacts.total} tone="orange" sub={stats ? `${pct(stats.impacts.withChain, stats.impacts.total)}% chained` : undefined} />
          <Counter label="Deep dives" value={stats?.deepDives} tone="orange" />
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, tone, sub }: { label: string; value?: number; tone: 'cyan' | 'orange' | 'emerald'; sub?: string }) {
  const toneClass = tone === 'cyan' ? 'text-cyan-300' : tone === 'orange' ? 'text-orange-300' : 'text-emerald-300';
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wider text-ink-muted">{label}</span>
      <span className={`text-base font-mono font-bold ${toneClass}`}>
        {value ?? '—'}
      </span>
      {sub && <span className="text-[9px] text-ink-faint">{sub}</span>}
    </div>
  );
}

function pct(num: number, den: number): string {
  if (!den) return '0';
  return (100 * num / den).toFixed(1);
}
