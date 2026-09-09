'use client';

import { useState, useEffect, useMemo } from 'react';
import type { UpstreamSnapshot, UpstreamRow } from '@/lib/upstream-sync';

// Replaces the static <iframe src="/dataflow.html"> (PLAN_LIVE_DATAFLOW.md
// Fase 2). Keeps the same 6-stage shape people already recognise (§1.3):
//   [0] Copy · [1] Cleanup  — outside Alumen, from upstream
//   [2] Discover · [3] Download · [4] Goals · [5] Impact — from the pipeline
// Two sub-views: "Cadeia" (the diagram, live counters per stage) and
// "Projetos" (PRJ × 6 stages table, filterable, ERROR highlighted).
//
// Deliberately polls /api/strom/dataflow-state instead of reusing
// useDrivePanelStream's /api/drive/stream: that path is admin-only
// (middleware.ts) because Drive Sync's management UI is admin-only by design
// (PLAN_USER_MANAGEMENT.md). This view has to work for basic users too (the
// 'strom' tab is not admin-gated), so it needs a read surface that isn't
// bundled with Drive Sync's write-capable one. See dataflow-state/route.ts.

type SubView = 'chain' | 'projects';
type StageStatus = 'DONE' | 'ERROR' | 'IN_PROGRESS' | 'PENDING' | 'NONE';

interface DataFlowState {
  upstream: UpstreamSnapshot;
  counts: { totalProjects: number; withFiles: number; withGoals: number; withImpacts: number };
  pipelineRunning: { drive: boolean; goals: boolean; impact: boolean };
  generatedAt: string;
}

function useDataFlowState() {
  const [state, setState] = useState<DataFlowState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/strom/dataflow-state')
        .then(r => r.json())
        .then(d => {
          if (cancelled) return;
          if (d.error) { setError(d.error); return; }
          setError(null);
          setState(d);
        })
        .catch(() => { if (!cancelled) setError('Falha ao carregar.'); });
    };
    load();
    // Matches upstream-sync.ts's own 15s cache freshness — no point polling
    // faster than the data underneath actually changes.
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { state, error };
}

interface ProjectStageRow {
  projectId: string;
  name: string;
  stages: {
    copy: StageStatus;
    cleanup: StageStatus;
    discover: StageStatus;
    download: StageStatus;
    goals: StageStatus;
    impact: StageStatus;
  };
}

const STAGE_COLUMNS: Array<{ key: keyof ProjectStageRow['stages']; label: string }> = [
  { key: 'copy', label: 'Copy' },
  { key: 'cleanup', label: 'Cleanup' },
  { key: 'discover', label: 'Discover' },
  { key: 'download', label: 'Download' },
  { key: 'goals', label: 'Goals' },
  { key: 'impact', label: 'Impact' },
];

export default function DataFlowLive() {
  const { state, error } = useDataFlowState();
  const [subView, setSubView] = useState<SubView>('chain');

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-bg">
      <div className="shrink-0 px-6 py-3 border-b border-line bg-surface-1 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {(['chain', 'projects'] as SubView[]).map(v => (
            <button
              key={v}
              onClick={() => setSubView(v)}
              className={`px-3 py-1 rounded text-[12px] font-medium transition-all cursor-pointer
                ${subView === v
                  ? 'bg-accent-soft border border-accent-border text-accent-text'
                  : 'text-ink-4 hover:bg-surface-2 border border-transparent'
                }`}
            >
              {v === 'chain' ? '⬡ Cadeia' : '📋 Projetos'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-muted">
          <span className={`w-1.5 h-1.5 rounded-full ${state && !error ? 'bg-emerald-400' : 'bg-ink-faint'}`} />
          {error ? 'erro ao atualizar' : state ? 'ao vivo' : 'carregando…'}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {subView === 'chain' ? (
          <ChainView state={state} />
        ) : (
          <ProjectsTable />
        )}
      </div>
    </div>
  );
}

// ─── Cadeia ─────────────────────────────────────────────────────────────────

function ChainView({ state }: { state: DataFlowState | null }) {
  const upstream = state?.upstream;
  const counts = state?.counts;
  const pipeline = state?.pipelineRunning;

  const upstreamCount = (stage: 'copy' | 'cleanup', status: UpstreamRow['status']) =>
    upstream?.rows.filter(r => r.stage === stage && r.status === status).length ?? 0;

  const total = counts?.totalProjects ?? 0;

  return (
    <div className="p-8 flex flex-col gap-6 max-w-5xl mx-auto">
      {upstream?.error && (
        <div className="px-4 py-2.5 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-300 text-[12px]">
          ⚠ Upstream (Apps Script) não pôde ser lido: {upstream.error} — mostrando o último dado bom.
        </div>
      )}

      {/* External — outside Alumen */}
      <Section label="🌐 Fora do Alumen — Apps Script">
        <div className="grid grid-cols-2 gap-4">
          <StageBox
            num={0}
            icon="📥"
            title="Copy"
            sub="syncProjectFiles"
            counts={[
              { label: 'DONE', value: upstreamCount('copy', 'DONE'), tone: 'emerald' },
              { label: 'ERROR', value: upstreamCount('copy', 'ERROR'), tone: 'red' },
              { label: 'EM ANDAMENTO', value: upstreamCount('copy', 'IN_PROGRESS'), tone: 'cyan' },
            ]}
          />
          <StageBox
            num={1}
            icon="🧹"
            title="Cleanup"
            sub="removeClassification*"
            counts={[
              { label: 'DONE', value: upstreamCount('cleanup', 'DONE'), tone: 'emerald' },
              { label: 'ERROR', value: upstreamCount('cleanup', 'ERROR'), tone: 'red' },
              { label: 'EM ANDAMENTO', value: upstreamCount('cleanup', 'IN_PROGRESS'), tone: 'cyan' },
            ]}
          />
        </div>
        {upstream && (
          <div className="text-[10px] text-ink-faint mt-2">
            {upstream.stale ? 'última leitura em cache' : 'lido agora'}
            {upstream.readAt && ` · ${new Date(upstream.readAt).toLocaleTimeString()}`}
          </div>
        )}
      </Section>

      <div className="flex items-center justify-center">
        <div className="w-px h-6 bg-line-strong" />
      </div>

      {/* Alumen pipeline */}
      <Section label="🔷 Alumen · Analysis Pipeline">
        <div className="grid grid-cols-2 gap-4">
          <StageBox
            num={2}
            icon="🔍"
            title="Discover"
            sub="Scans PRJ-XXXXX folders"
            counts={[{ label: 'projetos conhecidos', value: total, tone: 'cyan' }]}
          />
          <StageBox
            num={3}
            icon="⬇️"
            title="Download"
            sub="DOCX · XLSX · PDF · Docs"
            running={pipeline?.drive}
            counts={[{ label: 'com arquivos', value: counts?.withFiles ?? 0, of: total, tone: 'cyan' }]}
          />
          <StageBox
            num={4}
            icon="🧠"
            title="Goals Extraction"
            sub="Technologies · DDS · GIO"
            badge="Gemini"
            running={pipeline?.goals}
            counts={[{ label: 'com goals', value: counts?.withGoals ?? 0, of: total, tone: 'emerald' }]}
          />
          <StageBox
            num={5}
            icon="🔗"
            title="Impact Analysis"
            sub="Cross-project · Citations"
            badge="Gemini"
            running={pipeline?.impact}
            counts={[{ label: 'com impactos', value: counts?.withImpacts ?? 0, of: total, tone: 'orange' }]}
          />
        </div>
      </Section>

      {/* Outputs */}
      <Section label="📤 Saídas">
        <div className="flex flex-wrap gap-3 text-[11px] text-ink-4">
          {['Projects', 'Goals', 'Impact Graph', 'Matrix'].map(o => (
            <span key={o} className="px-3 py-1.5 rounded-lg bg-surface-1 border border-line">{o}</span>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider mb-2.5">{label}</div>
      {children}
    </div>
  );
}

function StageBox({
  num,
  icon,
  title,
  sub,
  badge,
  running,
  counts,
}: {
  num: number;
  icon: string;
  title: string;
  sub: string;
  badge?: string;
  running?: boolean;
  counts: Array<{ label: string; value: number; of?: number; tone: 'cyan' | 'emerald' | 'orange' | 'red' }>;
}) {
  const toneClass = (tone: string) =>
    tone === 'emerald' ? 'text-emerald-300' : tone === 'orange' ? 'text-orange-300'
    : tone === 'red' ? 'text-red-300' : 'text-cyan-300';

  return (
    <div className={`relative rounded-xl border p-4 bg-surface-1 ${running ? 'border-accent-border shadow-[0_0_0_1px_var(--accent-border)]' : 'border-line'}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-5 h-5 rounded-full bg-surface-2 text-[10px] font-bold text-ink-4 flex items-center justify-center">{num}</span>
        <span className="text-lg">{icon}</span>
        <span className="text-sm font-bold text-ink-1">{title}</span>
        {badge && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-900/40 text-purple-300">{badge}</span>}
        {running && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-accent-text">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-text animate-pulse" /> rodando
          </span>
        )}
      </div>
      <div className="text-[11px] text-ink-muted mb-3">{sub}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {counts.map(c => (
          <div key={c.label} className="flex flex-col leading-tight">
            <span className="text-[9px] uppercase tracking-wider text-ink-faint">{c.label}</span>
            <span className={`text-base font-mono font-bold ${toneClass(c.tone)}`}>
              {c.value}{c.of !== undefined ? ` / ${c.of}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Projetos ───────────────────────────────────────────────────────────────

function ProjectsTable() {
  const [rows, setRows] = useState<ProjectStageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/strom/dataflow-projects')
        .then(r => r.json())
        .then(d => { if (!cancelled && d.projects) setRows(d.projects); })
        .catch(() => { if (!cancelled) setError('Falha ao carregar.'); });
    };
    load();
    // Light polling of its own — separate from the SSE tick (see route.ts),
    // this is a ~300-row join that only matters while this sub-view is open.
    const id = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter(r => {
      if (onlyErrors && !Object.values(r.stages).includes('ERROR')) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!r.projectId.toLowerCase().includes(s) && !r.name.toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }, [rows, search, onlyErrors]);

  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>;
  if (!rows) return <div className="p-8 text-sm text-ink-muted">Carregando…</div>;

  return (
    <div className="p-6 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por ID ou nome…"
          className="px-3 py-1.5 rounded-lg bg-surface-1 border border-line text-ink-1 text-sm w-64"
        />
        <label className="flex items-center gap-1.5 text-xs text-ink-3 cursor-pointer">
          <input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} />
          Só com ERROR
        </label>
        <span className="text-xs text-ink-muted ml-auto">{filtered.length} de {rows.length} projetos</span>
      </div>

      <div className="border border-line rounded-xl overflow-hidden">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-ink-4 text-[10px] uppercase tracking-wide bg-surface-1">
              <th className="px-3 py-2 font-medium">Projeto</th>
              {STAGE_COLUMNS.map(c => (
                <th key={c.key} className="px-2 py-2 font-medium text-center">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.projectId} className="border-b border-line last:border-0 hover:bg-surface-1/50">
                <td className="px-3 py-1.5">
                  <span className="font-mono text-accent-text2">{r.projectId}</span>
                  <span className="text-ink-4 ml-2 truncate">{r.name}</span>
                </td>
                {STAGE_COLUMNS.map(c => (
                  <td key={c.key} className="px-2 py-1.5 text-center">
                    <StatusDot status={r.stages[c.key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: StageStatus }) {
  const map: Record<StageStatus, { label: string; className: string }> = {
    DONE: { label: '●', className: 'text-emerald-400' },
    ERROR: { label: '●', className: 'text-red-400' },
    IN_PROGRESS: { label: '●', className: 'text-cyan-400 animate-pulse' },
    PENDING: { label: '●', className: 'text-amber-400' },
    NONE: { label: '·', className: 'text-ink-faint' },
  };
  const { label, className } = map[status];
  return <span className={className} title={status}>{label}</span>;
}
