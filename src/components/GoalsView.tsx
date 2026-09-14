'use client';

import { useState, useEffect, useCallback } from 'react';
import LoadingState from './LoadingState';
import { useProjectContext } from '@/context/ProjectContext';
import { ADMIN_ONLY_TITLE } from '@/lib/constants';
import Tag, { severityTone, type Tone } from './Tag';

interface ProjectGoals {
  id: number;
  project_id: string;
  project_name: string;
  region: string;
  gate: string;
  month_folder: string;
  summary_one_line: string;
  digital_technologies: string;
  change_management: string;
  security_impacts: string;
  regional_impacts: string;
  ia_embedded: string;
  gio_sl_dds_impacts: string;
  dds_gio_workload: string;
  business_apps_cis: string;
  dds_entities_touched: string;     // JSON
  gio_services_touched: string;     // JSON
  tech_tags: string;                // JSON
  vendors: string;                  // JSON
  data_classifications: string;     // JSON
  mentioned_projects: string;       // JSON
  // Onda 2/3 output. Extracted, validated and consumed by the Impact engine
  // since mid-2026, but never shown here until 2026-08-31 — which meant the
  // most auditable part of the extraction (every item carries the verbatim
  // sentence it came from) was invisible to the people checking it.
  project_relations: string;        // JSON [{project_id, kind, relation, source_file, evidence_quote, confidence}]
  out_of_scope: string;             // JSON [{topic, evidence_quote, source_file}]
  impact_claims: string;            // JSON [{target_kind, target, role, severity, impact_type, evidence_file, evidence_quote, confidence}]
  timeline_struct: string;          // JSON {gate1_actual, gate2_target, go_live_target, must_complete_before[], blocked_by[]}
  prompt_version: number;
  source_files: string;
  analyzed_at: string;
  status: string;
  error_message: string;
}

interface ImpactClaim {
  target_kind: string; target: string; role: string; severity: string;
  impact_type: string; evidence_file: string; evidence_quote: string; confidence: string;
}
interface ProjectRelation {
  project_id: string; kind: string; relation: string;
  source_file: string; evidence_quote: string; confidence: string;
}
interface OutOfScope { topic: string; evidence_quote: string; source_file: string }
interface TimelineDep { project_id: string; reason: string; evidence_file: string; evidence_quote: string }
interface TimelineStruct {
  gate1_actual: string | null; gate2_target: string | null; go_live_target: string | null;
  must_complete_before?: TimelineDep[]; blocked_by?: TimelineDep[];
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string') : []; }
  catch { return []; }
}

function parseObjArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v as T[] : []; }
  catch { return []; }
}

function parseTimeline(raw: string | null | undefined): TimelineStruct | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as TimelineStruct : null;
  } catch { return null; }
}

/** The verbatim sentence an extracted item was grounded in. Rendering it is the
 *  whole point of this section: without the quote a claim is unauditable. */
function Evidence({ quote, file }: { quote?: string; file?: string }) {
  if (!quote) return null;
  return (
    <div className="mt-1 pl-3 border-l-2 border-line-strong">
      <span className="text-[11px] text-ink-faint italic leading-relaxed">&ldquo;{quote}&rdquo;</span>
      {file && <span className="ml-2 text-[11px] text-ink-muted font-mono">{file}</span>}
    </div>
  );
}

interface RunStatus {
  isRunning: boolean;
  totalProjects: number;
  processedProjects: number;
  successCount: number;
  errorCount: number;
  /** Projects left alone because their documents did not change. Counted apart
   *  from successes, which used to absorb them — including skipped error rows. */
  skippedCount: number;
  currentProject: string;
  errors: string[];
  /** Last row of the `goals_runs` journal. Survives the process, so an
   *  extraction killed mid-flight is still visible afterwards. */
  lastRun?: {
    status: string;
    scope: string;
    startedAt: string;
    finishedAt: string | null;
    processedProjects: number;
    totalProjects: number;
    successCount: number;
    errorCount: number;
    skippedCount: number;
  } | null;
}

const FIELDS = [
  { key: 'digital_technologies', label: 'Digital Technologies' },
  { key: 'change_management', label: 'Change Management' },
  { key: 'security_impacts', label: 'Security Impacts (DRMT)' },
  { key: 'regional_impacts', label: 'Regional Impacts' },
  { key: 'ia_embedded', label: 'AI Embedded' },
  { key: 'gio_sl_dds_impacts', label: 'GIO SL / DDS Impacts' },
  { key: 'dds_gio_workload', label: 'DDS / GIO Workload' },
  { key: 'business_apps_cis', label: 'Business Apps & CIs' },
] as const;

export default function GoalsView() {
  const { isAdmin, openUniverse } = useProjectContext();
  const [goals, setGoals] = useState<ProjectGoals[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [evidenceOpenId, setEvidenceOpenId] = useState<string | null>(null);
  const [filterRegion, setFilterRegion] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchGoals = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterRegion) params.set('region', filterRegion);
      if (filterStatus) params.set('status', filterStatus);
      const res = await fetch(`/api/goals?${params}`);
      const data = await res.json();
      setGoals(data.goals || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filterRegion, filterStatus]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/goals?action=status');
      const data = await res.json();
      setStatus(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchGoals();
    fetchStatus();
  }, [fetchGoals, fetchStatus]);

  // Poll status while running
  useEffect(() => {
    if (!status?.isRunning) return;
    const interval = setInterval(() => {
      fetchStatus();
      fetchGoals();
    }, 3000);
    return () => clearInterval(interval);
  }, [status?.isRunning, fetchStatus, fetchGoals]);


  const handleRunSingle = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch('/api/goals', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_single', projectId })
    });
    fetchStatus();
  };

  const startAnalysis = async () => {
    await fetch('/api/goals', { method: 'POST' });
    fetchStatus();
  };

  const exportCsv = () => {
    window.open('/api/goals?action=export', '_blank');
  };

  const handleEraseAll = async () => {
    if (!confirm('Are you sure you want to delete all extracted goals? This cannot be undone.')) return;
    try {
      await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_everything' }),
      });
      fetchStatus();
      fetchGoals();
    } catch { /* ignore */ }
  };

  const regions = [...new Set(goals.map(g => g.region).filter(Boolean))].sort();
  const filtered = goals.filter(g => {
    if (search) {
      const s = search.toLowerCase();
      return g.project_id.toLowerCase().includes(s) ||
        g.project_name.toLowerCase().includes(s);
    }
    return true;
  });

  const statusTone = (s: string): Tone => {
    if (s === 'success') return 'ok';
    if (s === 'error') return 'bad';
    if (s === 'partial') return 'warn';
    return 'neutral';
  };

  return (
    <div className="flex-1 overflow-auto bg-bg p-6 text-ink-2">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-ink-1">Project Goals Extractor</h1>
            <p className="text-sm text-ink-muted mt-1">
              AI-powered extraction of governance fields from project documentation
            </p>
          </div>
          <div className="flex gap-3">
            {/* Erase/Run are admin-only server-side (POST /api/goals,
                middleware.ts) — disabled here too, not hidden, so a basic
                user sees the feature and why it's unavailable rather than a
                view that looks like it's missing functionality. Export CSV
                stays enabled for everyone: it only reads what's already
                extracted. */}
            <button
              onClick={handleEraseAll}
              disabled={!isAdmin || status?.isRunning}
              title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
              className="px-4 py-2 text-sm bg-red-900/30 text-red-400 border border-red-800 rounded-md hover:bg-red-900/50 transition-colors disabled:opacity-50"
            >
              Erase All
            </button>
            <button
              onClick={exportCsv}
              disabled={goals.length === 0}
              className="px-4 py-2 text-sm bg-accent-soft text-accent-text border border-accent-border rounded-md hover:bg-accent-soft transition-colors disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              onClick={startAnalysis}
              disabled={!isAdmin || status?.isRunning}
              title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
              className="px-4 py-2 text-sm bg-accent text-white border border-accent-border rounded-md hover:bg-accent transition-colors disabled:opacity-50"
            >
              {status?.isRunning ? 'Running...' : 'Run Analysis'}
            </button>
          </div>
        </div>

        {/* Status bar */}
        {status?.isRunning && (
          <div className="bg-accent-soft border border-accent-border/50 rounded-lg p-4 mb-6">
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium text-accent-text">
                Analyzing: {status.currentProject}
              </span>
              <span className="text-accent-text2">
                {status.processedProjects} / {status.totalProjects} projects
              </span>
            </div>
            <div className="w-full bg-surface-2 rounded-full h-2">
              <div
                className="bg-accent h-2 rounded-full transition-all"
                style={{ width: `${status.totalProjects ? (status.processedProjects / status.totalProjects) * 100 : 0}%` }}
              />
            </div>
            <div className="flex gap-4 mt-2 text-xs text-accent-text2">
              <span>Success: {status.successCount}</span>
              <span>Errors: {status.errorCount}</span>
              <span>Unchanged: {status.skippedCount}</span>
            </div>
            {status.errors.length > 0 && (
              <div className="mt-2 text-xs text-red-400 max-h-20 overflow-y-auto">
                {status.errors.slice(-5).map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        )}

        {/* A run killed mid-flight (OOM, restart, deploy) leaves nothing in
            memory — only the goals_runs journal knows it happened. */}
        {!status?.isRunning && status?.lastRun?.status === 'aborted' && (
          <div className="bg-surface-1 border border-amber-800/50 rounded-lg p-3 mb-6 text-xs text-amber-400">
            Last extraction was interrupted after {status.lastRun.processedProjects} of{' '}
            {status.lastRun.totalProjects} projects
            {status.lastRun.startedAt ? ` (started ${status.lastRun.startedAt})` : ''}. Projects that
            never ran still have no goals — start the analysis again to finish them.
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-4 mb-6">
          <input
            type="text"
            placeholder="Search by ID or name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-2 text-sm bg-surface-1 border border-line-strong rounded-lg w-64 text-ink-2 placeholder-ink-muted focus:outline-none focus:border-accent-border"
          />
          <select
            value={filterRegion}
            onChange={e => setFilterRegion(e.target.value)}
            className="px-3 py-2 text-sm bg-surface-1 border border-line-strong rounded-lg text-ink-2 focus:outline-none focus:border-accent-border"
          >
            <option value="">All Regions</option>
            {regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 text-sm bg-surface-1 border border-line-strong rounded-lg text-ink-2 focus:outline-none focus:border-accent-border"
          >
            <option value="">All Statuses</option>
            <option value="success">Success</option>
            <option value="partial">Partial</option>
            <option value="error">Error</option>
            <option value="pending">Pending</option>
          </select>
          <span className="text-sm text-ink-muted self-center">
            {filtered.length} project{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        {loading ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-ink-muted">
            {goals.length === 0
              ? 'No projects analyzed yet. Click "Run Analysis" to start.'
              : 'No projects match the current filters.'}
          </div>
        ) : (
          <div className="bg-surface-1 rounded-xl border border-line overflow-hidden shadow-sm tabular-nums">
            {/* Header */}
                        <div className="grid grid-cols-[minmax(0,1fr)_100px_60px_40px_80px_120px_90px_30px] gap-2 bg-surface text-ink-muted text-xs font-semibold uppercase px-4 py-3 border-b border-line">
              <div>Project</div>
              <div>Region</div>
              <div>Gate</div>
              <div className="text-center">Files</div>
              <div className="text-center">Status</div>
              <div>Last Analyzed</div>
              <div className="text-center">Action</div>
              <div></div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-line">
              {filtered.map(g => {
                const isExpanded = expandedId === g.project_id;
                let fileCount = 0;
                try { fileCount = JSON.parse(g.source_files || '[]').length; } catch { /* */ }

                return (
                  <div key={g.project_id}>
                    <div
                                            className="grid grid-cols-[minmax(0,1fr)_100px_60px_40px_80px_120px_90px_30px] gap-2 items-center cursor-pointer hover:bg-surface-2/50 px-4 py-3 text-sm transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : g.project_id)}
                    >
                      <div className="min-w-0 truncate pr-2">
                        <span className="font-mono text-xs text-ink-4 mr-2">{g.project_id}</span>
                        <span className="font-medium text-ink-2">{g.project_name}</span>
                      </div>
                      <div className="text-ink-4 truncate">{g.region}</div>
                      <div className="text-ink-4">{g.gate}</div>
                      <div className="text-ink-muted text-center">{fileCount}</div>
                      <div className="text-center">
                        <Tag tone={statusTone(g.status)}>{g.status}</Tag>
                      </div>
                      <div className="text-ink-muted text-[11px]">
                        {g.analyzed_at ? new Date(g.analyzed_at).toLocaleString() : 'Never'}
                      </div>
                      <div className="text-center">
                        <button
                          onClick={(e) => handleRunSingle(g.project_id, e)}
                          disabled={!isAdmin || status?.isRunning}
                          title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
                          className="px-2 py-1 bg-surface-2 text-ink-3 text-xs font-medium rounded hover:bg-surface-3 transition-colors border border-line-strong disabled:opacity-50"
                        >
                          Analyze
                        </button>
                      </div>
                      <div className="text-ink-faint text-center text-xs">
                        {isExpanded ? '▲' : '▼'}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-6 pb-6 pt-2 bg-surface-sunken border-t border-line">
                        {g.error_message && (
                          <div className="mt-3 p-3 bg-red-900/20 border border-red-800/50 rounded text-sm text-red-400">
                            {g.error_message}
                          </div>
                        )}

                        {/* Executive one-liner */}
                        {g.summary_one_line && (
                          <div className="mt-4 px-3.5 py-3 bg-accent-soft/50 border border-accent-border/30 rounded-lg text-sm text-ink-2 leading-relaxed">
                            <span className="text-[11px] font-semibold text-accent-text mr-2">Summary</span>
                            {g.summary_one_line}
                          </div>
                        )}

                        {/* Canonical tags surfaced as pills */}
                        {(() => {
                          const blocks: { label: string; items: string[]; tone: Tone; opensProject?: boolean }[] = [
                            { label: 'Tech tags',           items: parseJsonArray(g.tech_tags),            tone: 'tech' },
                            { label: 'Vendors',             items: parseJsonArray(g.vendors),              tone: 'vendor' },
                            { label: 'Data classifications',items: parseJsonArray(g.data_classifications), tone: 'data' },
                            { label: 'DDS entities touched',items: parseJsonArray(g.dds_entities_touched), tone: 'dds' },
                            { label: 'GIO services touched',items: parseJsonArray(g.gio_services_touched), tone: 'gio' },
                            { label: 'Mentions',            items: parseJsonArray(g.mentioned_projects),   tone: 'neutral', opensProject: true },
                          ];
                          const visible = blocks.filter(b => b.items.length > 0);
                          if (visible.length === 0) return null;
                          return (
                            <div className="mt-3 space-y-2">
                              {visible.map(b => (
                                <div key={b.label} className="flex flex-wrap gap-1.5 items-center">
                                  <span className="text-[11px] font-semibold text-ink-muted w-44 shrink-0">{b.label}</span>
                                  {b.items.map(it => b.opensProject ? (
                                    <Tag key={it} tone={b.tone} mono onClick={() => openUniverse(it)} title="Open Project Universe">{it}</Tag>
                                  ) : (
                                    <Tag key={it} tone={b.tone}>{it}</Tag>
                                  ))}
                                </div>
                              ))}
                            </div>
                          );
                        })()}

                        {/* Evidence-anchored extraction (Onda 2/3). Every item
                            below carries the sentence it came from, which is
                            what makes the Impact graph auditable. Claims/relations/
                            out-of-scope are already surfaced (post-materialization)
                            in the Impact tab, so here they're collapsed by default
                            behind a toggle instead of shown as always-open boxes. */}
                        {(() => {
                          const claims = parseObjArray<ImpactClaim>(g.impact_claims);
                          const relations = parseObjArray<ProjectRelation>(g.project_relations);
                          const exclusions = parseObjArray<OutOfScope>(g.out_of_scope);
                          const tl = parseTimeline(g.timeline_struct);
                          const mcb = tl?.must_complete_before ?? [];
                          const blocked = tl?.blocked_by ?? [];
                          const hasTimeline = !!tl && (tl.gate1_actual || tl.gate2_target || tl.go_live_target || mcb.length > 0 || blocked.length > 0);
                          const evidenceCount = claims.length + relations.length + exclusions.length;
                          if (!evidenceCount && !hasTimeline) return null;

                          // A zero count is left out: "Timeline (0)" read as "no timeline"
                          // even with the gate dates listed right below it.
                          const Section = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (
                            <div className="bg-surface-1 rounded-lg border border-line p-4">
                              <div className="text-[11px] font-semibold text-ink-muted mb-3">
                                {title}{count > 0 && <span className="text-ink-faint"> ({count})</span>}
                              </div>
                              <div className="space-y-3">{children}</div>
                            </div>
                          );

                          const evidenceOpen = evidenceOpenId === g.project_id;

                          return (
                            <div className="mt-4 space-y-4">
                              {evidenceCount > 0 && (
                                <div className="bg-surface-1 rounded-lg border border-line">
                                  <button
                                    type="button"
                                    onClick={() => setEvidenceOpenId(evidenceOpen ? null : g.project_id)}
                                    className="w-full flex items-center justify-between px-4 py-2.5 text-left"
                                  >
                                    <span className="text-[11px] font-semibold text-ink-muted">
                                      Extraction evidence
                                      <span className="text-ink-faint ml-1.5">
                                        {claims.length > 0 && `${claims.length} claim${claims.length === 1 ? '' : 's'}`}
                                        {claims.length > 0 && (relations.length > 0 || exclusions.length > 0) && ' · '}
                                        {relations.length > 0 && `${relations.length} relation${relations.length === 1 ? '' : 's'}`}
                                        {relations.length > 0 && exclusions.length > 0 && ' · '}
                                        {exclusions.length > 0 && `${exclusions.length} out of scope`}
                                      </span>
                                    </span>
                                    <span className="text-ink-faint text-xs">{evidenceOpen ? '▲' : '▼'}</span>
                                  </button>

                                  {evidenceOpen && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 pt-0">
                                      {claims.length > 0 && (
                                        <Section title="Impact claims" count={claims.length}>
                                          {claims.map((c, i) => (
                                            <div key={i} className="text-sm">
                                              <div className="flex flex-wrap gap-1.5 items-center">
                                                <Tag tone={c.target_kind === 'gio' ? 'gio' : 'dds'}>{c.target}</Tag>
                                                <span className="text-[11px] text-ink-3">{(c.role || '').replace(/_/g, ' ')}</span>
                                                <Tag tone={severityTone(c.severity)}>{c.severity}</Tag>
                                                <span className="text-[11px] text-ink-muted font-mono">{(c.impact_type || '').replace(/_/g, ' ')}</span>
                                                {c.confidence === 'inferred' && <span className="text-[11px] text-amber-300/80 italic">inferred</span>}
                                              </div>
                                              <Evidence quote={c.evidence_quote} file={c.evidence_file} />
                                            </div>
                                          ))}
                                        </Section>
                                      )}

                                      {relations.length > 0 && (
                                        <Section title="Project relations" count={relations.length}>
                                          {relations.map((r, i) => (
                                            <div key={i} className="text-sm">
                                              <div className="flex flex-wrap gap-1.5 items-center">
                                                <Tag tone="neutral" mono onClick={() => openUniverse(r.project_id)} title="Open Project Universe">{r.project_id}</Tag>
                                                <span className="text-[11px] text-ink-3">{(r.kind || '').replace(/_/g, ' ')}</span>
                                                {r.confidence === 'inferred' && <span className="text-[11px] text-amber-300/80 italic">inferred</span>}
                                              </div>
                                              {r.relation && <div className="text-[11px] text-ink-3 mt-0.5">{r.relation}</div>}
                                              <Evidence quote={r.evidence_quote} file={r.source_file} />
                                            </div>
                                          ))}
                                        </Section>
                                      )}

                                      {exclusions.length > 0 && (
                                        <Section title="Explicitly out of scope" count={exclusions.length}>
                                          {exclusions.map((o, i) => (
                                            <div key={i} className="text-sm">
                                              <span className="text-[12px] text-ink-3 font-medium">{o.topic}</span>
                                              <Evidence quote={o.evidence_quote} file={o.source_file} />
                                            </div>
                                          ))}
                                        </Section>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {hasTimeline && (
                                <Section title="Timeline" count={mcb.length + blocked.length}>
                                  {(tl!.gate1_actual || tl!.gate2_target || tl!.go_live_target) && (
                                    <div className="flex flex-wrap gap-3 text-[11px] text-ink-3">
                                      {tl!.gate1_actual   && <span>Gate 1 <span className="font-mono text-ink-2">{tl!.gate1_actual}</span></span>}
                                      {tl!.gate2_target   && <span>Gate 2 <span className="font-mono text-ink-2">{tl!.gate2_target}</span></span>}
                                      {tl!.go_live_target && <span>Go-live <span className="font-mono text-ink-2">{tl!.go_live_target}</span></span>}
                                    </div>
                                  )}
                                  {blocked.map((d, i) => (
                                    <div key={`b${i}`} className="text-sm">
                                      <span className="text-[11px] text-red-300">blocked by</span>{' '}
                                      <span className="text-[11px] font-mono text-ink-3">{d.project_id}</span>
                                      {d.reason && <span className="text-[11px] text-ink-muted"> — {d.reason}</span>}
                                      <Evidence quote={d.evidence_quote} file={d.evidence_file} />
                                    </div>
                                  ))}
                                  {mcb.map((d, i) => (
                                    <div key={`m${i}`} className="text-sm">
                                      <span className="text-[11px] text-ink-3">must complete before</span>{' '}
                                      <span className="text-[11px] font-mono text-ink-3">{d.project_id}</span>
                                      {d.reason && <span className="text-[11px] text-ink-muted"> — {d.reason}</span>}
                                      <Evidence quote={d.evidence_quote} file={d.evidence_file} />
                                    </div>
                                  ))}
                                </Section>
                              )}
                            </div>
                          );
                        })()}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                          {FIELDS.map(({ key, label }) => {
                            const val = (g as unknown as Record<string, string>)[key];
                            const isEmpty = !val || val === 'Not identified';
                            return (
                              <div key={key} className={`bg-surface-1 rounded-lg border p-4 ${isEmpty ? 'border-line opacity-60' : 'border-line-strong'}`}>
                                <div className="text-[11px] font-semibold text-ink-muted mb-2">{label}</div>
                                <div className={`text-sm leading-relaxed whitespace-pre-wrap ${isEmpty ? 'text-ink-faint italic' : 'text-ink-3'}`}>
                                  {val || '—'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}