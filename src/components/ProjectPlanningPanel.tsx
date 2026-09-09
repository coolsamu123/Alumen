'use client';

import { useCallback, useEffect, useState } from 'react';
import { getGateColor, getDecisionColor, ADMIN_ONLY_TITLE } from '@/lib/constants';
import { useProjectContext } from '@/context/ProjectContext';
import type { ProjectSummary } from '@/lib/types';

interface PlanningEvent {
  date: string | null;
  label: string;
  evidenceFile: string | null;
}

interface PlanningGate {
  gate: string;
  date: string | null;
  forum: string | null;
  decision: string;
  note: string | null;
  evidenceFile: string | null;
  deterministic: boolean;
}

interface PlanningAction {
  title: string;
  owner: string | null;
  status: 'open' | 'done';
  evidenceFile: string | null;
}

interface PlanningFinancials {
  capexKEur: number | null;
  opexKEur: number | null;
  totalKEur: number | null;
  currency: string | null;
  fundingEntity: string | null;
  notes: string | null;
}

interface PlanningResult {
  projectId: string;
  events: PlanningEvent[];
  gates: PlanningGate[];
  actions: PlanningAction[];
  financials: PlanningFinancials;
  fallbackCostKEur: number | null;
  hasDocuments: boolean;
  syncAttempted: boolean;
  syncError: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  generatedAt: string | null;
  durationMs: number | null;
  cached: boolean;
}

function fmtKEur(v: number | null): string {
  return v !== null ? `${v.toLocaleString()} k€` : '—';
}

export default function ProjectPlanningPanel({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const { isAdmin } = useProjectContext();
  const [data, setData] = useState<PlanningResult | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Initial cached-only probe.
  useEffect(() => {
    let cancelled = false;
    setLoadingInitial(true);
    setError(null);
    fetch(`/api/impact/project/planning?projectId=${encodeURIComponent(project.projectId)}`)
      .then(res => res.json())
      .then(json => {
        if (cancelled) return;
        if (json.error) throw new Error(json.error);
        setData(json as PlanningResult);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoadingInitial(false); });
    return () => { cancelled = true; };
  }, [project.projectId]);

  // Escape-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Loading timer for the LLM call.
  useEffect(() => {
    if (!generating) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [generating]);

  const runGenerate = useCallback(async (force: boolean) => {
    setGenerating(true);
    setError(null);
    setElapsed(0);
    try {
      const res = await fetch('/api/impact/project/planning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.projectId, force }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Planning generation failed');
      setData(json as PlanningResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setGenerating(false);
    }
  }, [project.projectId]);

  const gateColor = getGateColor(project.currentGate);
  const decisionColor = getDecisionColor(project.latestDecision);
  // "Generate plan" also does the Drive sync when nothing is cached yet — no
  // separate "Sync" button in this panel — so it's offered whenever the
  // project has a Drive link at all, not only once documents are known-cached.
  const hasDriveLink = !!(project.linkFolder || project.linkPositions || project.linkCIOO);

  const hasFinancials =
    data?.financials && (
      data.financials.capexKEur !== null ||
      data.financials.opexKEur !== null ||
      data.financials.totalKEur !== null ||
      data.financials.notes !== null
    );

  // Undated events sort to the bottom; dated ones ascending.
  const sortedEvents = data
    ? [...data.events].sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
      })
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-y-auto bg-surface-1 border border-line-strong rounded-xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-surface-1/95 backdrop-blur border-b border-line-strong px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-mono font-semibold text-accent-text2">{project.projectId}</div>
            <div className="text-sm font-bold text-ink-1 leading-snug truncate">{project.name}</div>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {project.currentGate && (
                <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border"
                  style={{ background: `${gateColor}18`, color: `color-mix(in srgb, ${gateColor} 70%, var(--ink-1))`, borderColor: `${gateColor}40` }}>
                  Gate {project.currentGate}
                </span>
              )}
              {project.latestDecision && (
                <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
                  style={{ background: `${decisionColor}22`, color: `color-mix(in srgb, ${decisionColor} 70%, var(--ink-1))` }}>
                  {project.latestDecision}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink-1 hover:bg-surface-2 transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loadingInitial && (
            <div className="text-xs text-ink-4 py-8 text-center">Loading planning data…</div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
          )}

          {!loadingInitial && data && (
            <>
              {/* No Drive link at all — nothing "Generate plan" could ever sync */}
              {!data.hasDocuments && !hasDriveLink && !data.generatedAt && (
                <div className="text-xs text-ink-4 bg-surface-2 border border-line rounded-lg px-3 py-2.5">
                  No Drive folder is linked for this project — showing gate history and cost from the CDIO sheet only.
                </div>
              )}

              {/* A sync was attempted (as part of a previous Generate click) and either
                  failed outright, or the folder turned out to have nothing usable. */}
              {data.syncAttempted && !data.hasDocuments && (
                <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
                  {data.syncError
                    ? `Could not sync documents from Drive: ${data.syncError}`
                    : 'Synced this project\'s Drive folder, but found no usable documents.'}
                  {' '}Showing gate history and cost from the CDIO sheet only.
                </div>
              )}

              {/* Generate CTA — shown until something has been generated, as long as
                  there's a Drive link to sync (or documents are already cached). The
                  first click syncs the Drive folder if needed, then runs the LLM. */}
              {(data.hasDocuments || hasDriveLink) && !data.generatedAt && (
                <div className="rounded-lg overflow-hidden">
                  <button
                    onClick={() => runGenerate(false)}
                    disabled={!isAdmin || generating}
                    title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-[13px] font-semibold text-white transition-all duration-200 disabled:cursor-wait disabled:opacity-40
                      bg-gradient-to-r from-purple-700 via-fuchsia-600 to-cyan-600 hover:from-purple-600 hover:via-fuchsia-500 hover:to-cyan-500
                      ${generating ? 'animate-pulse' : 'shadow-[0_0_18px_rgba(168,85,247,0.45)] hover:shadow-[0_0_24px_rgba(168,85,247,0.7)]'}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-base">🗓️</span>
                      <span>Generate plan</span>
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-white/85 font-bold">
                      {generating ? `${elapsed}s …` : (data.hasDocuments ? 'from project documents' : 'syncs Drive, then generates')}
                    </span>
                  </button>
                  {!generating && (
                    <div className="text-[10px] text-ink-muted px-1 pt-1.5">
                      {data.hasDocuments
                        ? 'Typical: 15–40s · calls the LLM once, then cached.'
                        : 'First run syncs the Drive folder, then calls the LLM — can take longer than usual. Cached after that.'}
                    </div>
                  )}
                </div>
              )}

              {/* Regenerate affordance — shown once something has been generated */}
              {data.hasDocuments && data.generatedAt && (
                <div className="flex items-center justify-between text-[10px] text-ink-muted">
                  <span>
                    Generated {data.generatedAt.slice(0, 10)} · {data.llmProvider}/{data.llmModel}
                    {data.durationMs ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => runGenerate(true)}
                    disabled={!isAdmin || generating}
                    title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
                    className={`font-bold uppercase tracking-wider transition-colors ${!isAdmin ? 'opacity-40 cursor-not-allowed' : generating ? 'text-ink-muted/60 cursor-wait' : 'text-fuchsia-300 hover:text-fuchsia-200 cursor-pointer'}`}
                  >
                    {generating ? `↻ ${elapsed}s …` : '↻ Regenerate'}
                  </button>
                </div>
              )}

              {/* Timeline */}
              {sortedEvents.length > 0 && (
                <Section title="Timeline">
                  <div className="space-y-2">
                    {sortedEvents.map((ev, i) => (
                      <div key={i} className="flex gap-3 text-xs">
                        <div className="w-24 shrink-0 font-mono text-ink-muted">{ev.date || 'Undated'}</div>
                        <div className="flex-1 text-ink-2 leading-relaxed">
                          {ev.label}
                          {ev.evidenceFile && <span className="text-ink-muted italic"> — {ev.evidenceFile}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Gates */}
              <Section title="Gates">
                {data.gates.length === 0 ? (
                  <div className="text-xs text-ink-muted">No gate reviews on record.</div>
                ) : (
                  <div className="space-y-2">
                    {data.gates.map((g, i) => {
                      const gc = getGateColor(g.gate);
                      const dc = getDecisionColor(g.decision);
                      return (
                        <div key={i} className="rounded-lg border border-line px-3 py-2.5" style={{ borderLeftColor: gc, borderLeftWidth: '3px' }}>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-bold" style={{ color: gc }}>Gate {g.gate}</span>
                              {g.forum && <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-2 text-ink-4 font-semibold uppercase tracking-wider">{g.forum}</span>}
                              {!g.deterministic && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-soft text-accent-text font-semibold" title="From project documents, not the CDIO sheet">doc</span>}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono text-ink-muted">{g.date || 'unknown date'}</span>
                              {g.decision && (
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                  style={{ background: `${dc}22`, color: `color-mix(in srgb, ${dc} 70%, var(--ink-1))` }}>
                                  {g.decision}
                                </span>
                              )}
                            </div>
                          </div>
                          {g.note && <div className="text-xs text-ink-3 mt-1.5 leading-relaxed">{g.note}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>

              {/* Actions */}
              {data.actions.length > 0 && (
                <Section title="Actions">
                  <div className="space-y-1.5">
                    {data.actions.map((a, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={`shrink-0 mt-0.5 ${a.status === 'done' ? 'text-emerald-500' : 'text-ink-muted'}`}>
                          {a.status === 'done' ? '☑' : '☐'}
                        </span>
                        <span className={`flex-1 leading-relaxed ${a.status === 'done' ? 'text-ink-muted line-through' : 'text-ink-2'}`}>
                          {a.title}
                        </span>
                        {a.owner && (
                          <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-surface-2 text-ink-4 font-semibold">{a.owner}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* CAPEX / OPEX */}
              <Section title="CAPEX / OPEX">
                {hasFinancials ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <StatTile label="CAPEX" value={fmtKEur(data.financials.capexKEur)} />
                      <StatTile label="OPEX" value={fmtKEur(data.financials.opexKEur)} />
                      <StatTile label="Total" value={fmtKEur(data.financials.totalKEur ?? data.fallbackCostKEur)} accent />
                    </div>
                    {(data.financials.currency || data.financials.fundingEntity) && (
                      <div className="text-[11px] text-ink-4 mt-2">
                        {data.financials.currency && <span>{data.financials.currency}</span>}
                        {data.financials.currency && data.financials.fundingEntity && <span> · </span>}
                        {data.financials.fundingEntity && <span>Funding: {data.financials.fundingEntity}</span>}
                      </div>
                    )}
                    {data.financials.notes && (
                      <div className="text-xs text-ink-3 leading-relaxed mt-2">{data.financials.notes}</div>
                    )}
                  </>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <StatTile label="Total cost (CDIO sheet, no breakdown available)" value={fmtKEur(data.fallbackCostKEur)} accent wide />
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-accent-text2 uppercase tracking-wider border-b border-line-strong pb-1 mb-2.5">{title}</div>
      {children}
    </div>
  );
}

function StatTile({ label, value, accent, wide }: { label: string; value: string; accent?: boolean; wide?: boolean }) {
  return (
    <div className={`bg-surface-2 rounded-lg p-2.5 ${wide ? 'col-span-3' : ''}`}>
      <div className="text-[9px] text-ink-muted uppercase tracking-wider leading-tight">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${accent ? 'text-accent-text' : 'text-ink-2'}`}>{value}</div>
    </div>
  );
}
