'use client';

import { useProjectContext } from '@/context/ProjectContext';
import { getDDSColor, getGateColor, getDecisionColor } from '@/lib/constants';
import ProjectPlanningPanel from './ProjectPlanningPanel';
import { usePlanAllState, type PerProjectPlanState } from '@/hooks/usePlanAllState';

const UNRELIABLE_VALUES = new Set([
  '', 'n/a', 'na', 'none', 'unknown', 'not identified',
  'not available', 'not applicable', 'not specified',
  'not identified in available documentation',
]);

function isUseful(value: string | null | undefined): value is string {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (UNRELIABLE_VALUES.has(v)) return false;
  if (v.startsWith('not identified') || v.startsWith('not available')) return false;
  return true;
}

function planBarClasses(status: PerProjectPlanState['status']): string {
  switch (status) {
    case 'running': return 'bg-gradient-to-r from-purple-600 via-fuchsia-500 to-cyan-500 animate-pulse';
    case 'done': return 'bg-emerald-500';
    case 'error': return 'bg-red-500';
    case 'skipped': return 'bg-ink-muted/40';
    default: return 'bg-ink-muted/15';
  }
}

function planBarTitle(e: PerProjectPlanState): string {
  switch (e.status) {
    case 'pending': return 'Queued for planning';
    case 'running': return 'Generating plan…';
    case 'done': return e.cached ? 'Plan already up to date' : `Plan generated${e.durationMs ? ` in ${(e.durationMs / 1000).toFixed(1)}s` : ''}`;
    case 'error': return `Failed: ${e.errorMessage}`;
    case 'skipped': return e.errorMessage || 'Skipped';
    default: return '';
  }
}

export default function DetailView() {
  const { filtered, selected, setSelected, isAdmin } = useProjectContext();
  const { state: planState, start: startPlanAll, stop: stopPlanAll } = usePlanAllState();
  const isPlanning = planState?.status === 'running' || planState?.status === 'stopping';

  return (
    <div className="flex-1 overflow-auto p-6 animate-fadeIn">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="text-xs text-ink-4">{filtered.length} project{filtered.length === 1 ? '' : 's'}</div>
        <div className="flex items-center gap-3">
          {planState && planState.status !== 'idle' && (
            <span className="text-[11px] text-ink-muted">
              {isPlanning ? `Planning… ${planState.doneProjects}/${planState.totalProjects}` : `Done: ${planState.doneProjects}/${planState.totalProjects}`}
              {planState.capExceeded && <span className="text-amber-500 ml-1.5">· daily LLM cap reached</span>}
            </span>
          )}
          {/* Admin-only server-side (POST/DELETE /api/impact/project/planning/run-all
              match the /api/impact prefix rule in middleware.ts) — disabled
              here too rather than hidden, same rationale as Impact/Goals. */}
          {isPlanning ? (
            <button
              type="button"
              onClick={() => isAdmin && stopPlanAll()}
              disabled={!isAdmin}
              title={!isAdmin ? 'Requer perfil administrador' : undefined}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-red-600/80 hover:bg-red-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => startPlanAll(filtered.map(p => p.projectId))}
              disabled={!isAdmin || filtered.length === 0}
              title={!isAdmin ? 'Requer perfil administrador' : 'Generates the Project Planning panel (Timeline/Gates/Actions/CAPEX-OPEX) for every project shown below. Syncs Drive documents first when needed. Already-planned projects are near-instant (cached).'}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-white transition-colors
                bg-gradient-to-r from-purple-700 via-fuchsia-600 to-cyan-600 hover:from-purple-600 hover:via-fuchsia-500 hover:to-cyan-500
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              🗓️ Plan all ({filtered.length})
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(p => {
          const color = getDDSColor(p.dds);
          const isSelected = selected === p.projectId;
          const planEntry = planState?.perProject[p.projectId];

          return (
            <div
              key={p.projectId}
              onClick={() => setSelected(isSelected ? null : p.projectId)}
              className={`bg-surface-1 border rounded-xl p-5 cursor-pointer transition-all hover:-translate-y-0.5
                ${isSelected ? 'border-accent-border ring-1 ring-accent-border/30' : 'border-line hover:border-line-strong'}`}
              style={{ borderTopColor: color, borderTopWidth: '2px' }}
            >
              {/* Header */}
              <div className="flex justify-between items-start mb-2.5">
                <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                  {p.projectId}
                </span>
                <div className="flex gap-1.5">
                  {isUseful(p.currentGate) && (
                    <span className="inline-block px-3 py-1 rounded-full text-[11px] font-bold border"
                      style={{
                        background: `${getGateColor(p.currentGate)}18`,
                        color: `color-mix(in srgb, ${getGateColor(p.currentGate)} 70%, var(--ink-1))`,
                        borderColor: `${getGateColor(p.currentGate)}40`,
                        boxShadow: `0 0 8px ${getGateColor(p.currentGate)}25`,
                      }}>
                      Gate {p.currentGate}
                    </span>
                  )}
                  {isUseful(p.dds) && (
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold"
                      style={{ background: `${color}22`, color: `color-mix(in srgb, ${color} 70%, var(--ink-1))` }}>
                      {p.dds}
                    </span>
                  )}
                </div>
              </div>

              {/* Name */}
              {p.name && p.name !== p.projectId && (
                <div className="text-sm font-bold text-ink-1 mb-2 leading-snug line-clamp-2">
                  {p.name}
                </div>
              )}

              {/* Description */}
              {p.description && (
                <div className="text-xs text-ink-3 leading-relaxed mb-3 line-clamp-3">
                  {p.description}
                </div>
              )}

              {/* Decision badge */}
              {isUseful(p.latestDecision) && (
                <div className="mb-3 flex gap-2 flex-wrap">
                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold"
                    style={{ background: `${getDecisionColor(p.latestDecision)}22`, color: `color-mix(in srgb, ${getDecisionColor(p.latestDecision)} 70%, var(--ink-1))` }}>
                    {p.latestDecision}
                  </span>
                </div>
              )}

              {/* Cost */}
              {p.costKEur && (
                <div className="text-[11px] text-ink-4">
                  <span>{p.costKEur}k€</span>
                </div>
              )}

              {/* Tags */}
              {p.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {p.tags.slice(0, 5).map(t => (
                    <span key={t} className="inline-block px-2 py-0.5 rounded text-[9px] text-ink-4 bg-surface-2 border border-line-strong">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Links */}
              {(p.linkFolder || p.linkPositions) && (
                <div className="flex gap-2 mt-3">
                  {p.linkFolder && (
                    <a href={p.linkFolder} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-[10px] text-accent-text2 hover:text-accent-text underline">
                      Folder
                    </a>
                  )}
                  {p.linkPositions && (
                    <a href={p.linkPositions} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-[10px] text-accent-text2 hover:text-accent-text underline">
                      CIOO Position
                    </a>
                  )}
                </div>
              )}

              {/* Plan-all progress bar — only shown once this card is part of a run */}
              {planEntry && (
                <div
                  className="mt-3 h-[3px] rounded-full overflow-hidden bg-surface-2"
                  title={planBarTitle(planEntry)}
                >
                  <div className={`h-full w-full ${planBarClasses(planEntry.status)}`} />
                </div>
              )}

            </div>
          );
        })}
      </div>

      {selected && (() => {
        const selectedProject = filtered.find(p => p.projectId === selected);
        return selectedProject
          ? <ProjectPlanningPanel project={selectedProject} onClose={() => setSelected(null)} />
          : null;
      })()}
    </div>
  );
}
