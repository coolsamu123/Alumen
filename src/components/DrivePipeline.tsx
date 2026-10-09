'use client';

// The single table of Drive Sync: every project, the state of each stage of
// the chain, and the one action that fits it. Replaces the Drive Sync project
// explorer and the Data Flow "Projetos"/"Fila" tabs of the former Alumen menu,
// which each knew half of the chain. Data: /api/drive/pipeline
// (lib/pipeline-view.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProjectContext } from '@/context/ProjectContext';

type ProjectSource = 'excel' | 'drive' | 'initiative' | 'manual';
type StageState = 'done' | 'running' | 'error' | 'waiting' | 'none' | 'na';
const STAGES = ['request', 'copy', 'cleanup', 'discover', 'download', 'goals', 'impact'] as const;
type StageKey = typeof STAGES[number];

const STAGE_LABEL: Record<StageKey, string> = {
  request: 'Request',
  copy: 'Copy',
  cleanup: 'Cleanup',
  discover: 'Discover',
  download: 'Download',
  goals: 'Goals',
  impact: 'Impact',
};
const STAGE_WHO: Record<StageKey, string> = {
  request: 'Alumen asks Apps Script for the copy',
  copy: 'Apps Script copies the documents into the base folder',
  cleanup: 'Apps Script removes duplicates and the classification label',
  discover: 'Alumen finds the PRJ folder in the base folder',
  download: 'Alumen downloads the files',
  goals: 'Gemini extracts the governance fields',
  impact: 'Gemini computes the relations with the other projects',
};

interface PipelineRow {
  projectId: string;
  name: string;
  source: ProjectSource;
  cdioMissingSince: string | null;
  dds: string;
  gate: string;
  period: string;
  stages: Record<StageKey, StageState>;
  errors: Partial<Record<StageKey, string>>;
  filesDownloaded: number;
  impactCount: number;
  linkFolder: string;
  loadable: boolean;
}

interface PipelineData {
  rows: PipelineRow[];
  newFromCdio: number;
  queueSize: number;
  queueError: string | null;
  heartbeat: { at: string; pending: number } | null;
  cycle: string;
  baseFolderUrl: string;
}

export const SOURCE_BADGE: Record<ProjectSource, { label: string; title: string; className: string }> = {
  excel: { label: 'CDIO', title: 'From the CDIO sheet', className: 'bg-surface-2 text-ink-4' },
  drive: { label: 'Drive', title: 'PRJ folder found in Drive with no row in the CDIO sheet', className: 'bg-blue-900/40 text-blue-300' },
  initiative: { label: 'Initiative', title: 'Drive folder with no CDIO project', className: 'bg-amber-900/40 text-amber-300' },
  manual: { label: 'Ad hoc', title: 'Added by hand by number; becomes CDIO once the sheet lists it', className: 'bg-teal-900/40 text-teal-300' },
};

function StageIcon({ state, title }: { state: StageState; title: string }) {
  const map: Record<StageState, { ch: string; cls: string }> = {
    done:    { ch: '✓', cls: 'text-green-400' },
    running: { ch: '●', cls: 'text-accent-text animate-pulse' },
    error:   { ch: '✗', cls: 'text-red-400 font-bold' },
    waiting: { ch: '·', cls: 'text-ink-3 font-bold' },
    none:    { ch: '–', cls: 'text-ink-faint' },
    na:      { ch: 'n/a', cls: 'text-ink-faint text-[10px]' },
  };
  const m = map[state];
  return <span className={m.cls} title={title}>{m.ch}</span>;
}

function heartbeatAge(at: string | undefined): { text: string; ok: boolean } {
  if (!at) return { text: 'no signal', ok: false };
  const min = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  return { text: min <= 0 ? 'just now' : `${min} min ago`, ok: min <= 20 };
}

type StageFilter = { stage: StageKey; kind: 'active' | 'error' } | null;

export default function PipelineSection({ addProject, onToast }: {
  addProject: React.ReactNode;
  onToast: (kind: 'info' | 'success' | 'error', msg: string) => void;
}) {
  const { refreshProjects } = useProjectContext();
  const [data, setData] = useState<PipelineData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [source, setSource] = useState<'any' | ProjectSource>('any');
  const [period, setPeriod] = useState('any');
  const [gate, setGate] = useState('any');
  const [dds, setDds] = useState('any');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [stageFilter, setStageFilter] = useState<StageFilter>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/pipeline');
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Failed to load');
      setData(d);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const values = (pick: (r: PipelineRow) => string) =>
    Array.from(new Set(rows.map(pick).filter(Boolean))).sort();
  const periods = useMemo(() => values(r => r.period).reverse(), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const gates = useMemo(() => values(r => r.gate), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const ddsList = useMemo(() => values(r => r.dds), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const chain = useMemo(() => STAGES.map(stage => ({
    stage,
    active: rows.filter(r => r.stages[stage] === 'running' || r.stages[stage] === 'waiting').length,
    error: rows.filter(r => r.stages[stage] === 'error').length,
    done: rows.filter(r => r.stages[stage] === 'done').length,
  })), [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (needle && !r.projectId.toLowerCase().includes(needle) && !r.name.toLowerCase().includes(needle)) return false;
      if (source !== 'any' && r.source !== source) return false;
      if (period !== 'any' && r.period !== period) return false;
      if (gate !== 'any' && r.gate !== gate) return false;
      if (dds !== 'any' && r.dds !== dds) return false;
      if (onlyErrors && !Object.keys(r.errors).length) return false;
      if (stageFilter) {
        const st = r.stages[stageFilter.stage];
        if (stageFilter.kind === 'error' ? st !== 'error' : st !== 'running' && st !== 'waiting') return false;
      }
      return true;
    });
  }, [rows, q, source, period, gate, dds, onlyErrors, stageFilter]);

  const post = async (body: object): Promise<{ added: string[]; skipped: { projectId: string; reason: string }[]; alreadyInBase: string[] }> => {
    const res = await fetch('/api/drive/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Failed');
    return d;
  };

  const loadOne = async (projectId: string) => {
    setBusy(projectId);
    try {
      const r = await post({ action: 'load', projectIds: [projectId] });
      onToast(r.added.length || r.alreadyInBase.length ? 'success' : 'info',
        r.added.length ? `${projectId}: copy requested from Apps Script.`
        : r.alreadyInBase.length ? `${projectId}: folder already in Drive, going straight to download, goals and impact.`
        : `${projectId}: ${r.skipped[0]?.reason ?? 'nothing to do'}.`);
      load();
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const loadNew = async () => {
    if (!data?.newFromCdio) return;
    if (!window.confirm(`Load ${data.newFromCdio} new CDIO project(s)? Each goes through copy and cleanup and uses Gemini calls.`)) return;
    setBusy('__all__');
    try {
      const r = await post({ action: 'load-new-cdio' });
      onToast('success', `${r.added.length} project(s) queued for Apps Script` +
        (r.alreadyInBase.length ? `; ${r.alreadyInBase.length} already in Drive, going straight on.` : '.'));
      load();
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const resync = async (projectId: string) => {
    setBusy(projectId);
    try {
      const res = await fetch('/api/drive/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'project', projectId }),
      });
      if (res.status === 409) { onToast('info', 'Another sync is already running.'); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
      onToast('info', `Downloading the files of ${projectId} again…`);
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const removeManual = async (projectId: string) => {
    if (!window.confirm(`Remove the ad hoc project ${projectId}, with its goals and impacts?`)) return;
    setBusy(projectId);
    try {
      const res = await fetch(`/api/drive/projects/manual?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Failed');
      onToast('success', `${projectId} removed.`);
      refreshProjects();
      load();
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const hb = heartbeatAge(data?.heartbeat?.at);
  const sel = 'px-2 py-1 rounded bg-surface-2 border border-line text-xs text-ink-2';
  const filtersOn = q || source !== 'any' || period !== 'any' || gate !== 'any' || dds !== 'any' || onlyErrors || stageFilter;

  return (
    <div className="space-y-4">
      {/* Chain, live. Clicking a stage filters the table to it. */}
      <div className="bg-surface-1 border border-line rounded-xl px-5 py-4">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <div className="text-sm font-semibold text-ink-2">Live chain</div>
          <span className={`text-[11px] px-2 py-0.5 rounded ${hb.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}
            title="Last signal from Apps Script (trigger every 10 minutes)">
            Apps Script: {hb.text}
          </span>
          {data && data.queueSize > 0 && <span className="text-[11px] text-ink-muted">{data.queueSize} queued</span>}
          {data?.cycle && data.cycle !== 'idle' && (
            <span className="text-[11px] text-accent-text">cycle running: {data.cycle}</span>
          )}
          {data?.queueError && <span className="text-[11px] text-red-400" title={data.queueError}>queue unreadable</span>}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {chain.map((c, i) => {
            const activeSel = stageFilter?.stage === c.stage;
            return (
              <div key={c.stage} className="relative">
                <button
                  onClick={() => setStageFilter(activeSel && stageFilter?.kind === 'active' ? null : { stage: c.stage, kind: 'active' })}
                  title={`${STAGE_WHO[c.stage]} — click to see the projects at this stage`}
                  className={`w-full rounded-lg border px-2 py-2 text-left transition-colors ${
                    activeSel ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2/40 hover:bg-surface-2'}`}
                >
                  <div className="text-[11px] text-ink-muted">{i + 1}. {STAGE_LABEL[c.stage]}</div>
                  <div className="font-mono text-base text-ink-1">{c.active}</div>
                  <div className="text-[10px] text-ink-faint">{c.done} done</div>
                </button>
                {c.error > 0 && (
                  <button
                    onClick={() => setStageFilter({ stage: c.stage, kind: 'error' })}
                    className="absolute top-1 right-1 text-[10px] px-1.5 rounded bg-red-900/60 text-red-200"
                    title="See the projects with an error at this stage"
                  >{c.error} ✗</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-surface-1 border border-line rounded-xl px-5 py-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-sm font-semibold text-ink-2">+ Add project</div>
          <div className="text-[11px] text-ink-muted">By PRJ number, whether or not it is in CDIO</div>
          <div className="flex-1" />
          <button
            onClick={loadNew}
            disabled={!data?.newFromCdio || busy !== null}
            className={`px-4 py-1.5 rounded-lg border border-accent-border text-accent-text text-sm font-semibold ${
              !data?.newFromCdio || busy !== null ? 'opacity-40' : 'hover:bg-accent-soft'}`}
            title="Asks Apps Script to copy every CDIO project not loaded yet"
          >
            {busy === '__all__' ? 'Requesting…' : `Load new from CDIO (${data?.newFromCdio ?? 0})`}
          </button>
        </div>
        {addProject}
      </div>

      {/* Table */}
      <div className="bg-surface-1 border border-line rounded-xl">
        <div className="px-5 py-3 flex items-center gap-2 flex-wrap border-b border-line">
          <div className="text-sm font-semibold text-ink-2">Projects</div>
          <div className="text-[11px] text-ink-muted mr-2">{visible.length} / {rows.length}</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="PRJ or name…" className={`${sel} w-44`} />
          <select value={source} onChange={e => setSource(e.target.value as typeof source)} className={sel}>
            <option value="any">Source: all</option>
            <option value="excel">CDIO</option>
            <option value="manual">Ad hoc</option>
            <option value="drive">Drive</option>
          </select>
          <select value={period} onChange={e => setPeriod(e.target.value)} className={sel}>
            <option value="any">Period: all</option>
            {periods.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={gate} onChange={e => setGate(e.target.value)} className={sel}>
            <option value="any">Gate: all</option>
            {gates.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={dds} onChange={e => setDds(e.target.value)} className={sel}>
            <option value="any">DDS: all</option>
            {ddsList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <label className="text-xs text-ink-3 flex items-center gap-1">
            <input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} /> errors only
          </label>
          {stageFilter && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-accent-soft text-accent-text">
              {STAGE_LABEL[stageFilter.stage]}: {stageFilter.kind === 'error' ? 'with error' : 'in progress'}
            </span>
          )}
          {filtersOn && (
            <button onClick={() => { setQ(''); setSource('any'); setPeriod('any'); setGate('any'); setDds('any'); setOnlyErrors(false); setStageFilter(null); }}
              className="text-[11px] text-ink-muted hover:text-ink-2 underline">clear filters</button>
          )}
        </div>
        {loadError && <div className="px-5 py-2 text-xs text-red-400">{loadError}</div>}
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-1 z-10">
              <tr className="text-ink-muted border-b border-line">
                <th className="px-3 py-2 text-left font-semibold">PRJ</th>
                <th className="px-2 py-2 text-left font-semibold">Name</th>
                <th className="px-2 py-2 text-left font-semibold">Source</th>
                <th className="px-2 py-2 text-left font-semibold">Period</th>
                {STAGES.map(s => (
                  <th key={s} className="px-1.5 py-2 text-center font-semibold" title={STAGE_WHO[s]}>{STAGE_LABEL[s]}</th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const errKeys = Object.keys(r.errors) as StageKey[];
                const isOpen = openError === r.projectId;
                const downloadFailed = r.stages.download === 'error' || (r.stages.discover === 'done' && r.stages.download !== 'done');
                return (
                  <FragmentRow key={r.projectId}>
                    <tr className="border-b border-line/50 hover:bg-surface-2/30">
                      <td className="px-3 py-1.5 font-mono text-ink-2 whitespace-nowrap">{r.projectId}</td>
                      <td className="px-2 py-1.5 text-ink-3 max-w-xs truncate" title={r.name}>{r.name || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${SOURCE_BADGE[r.source].className}`}
                          title={SOURCE_BADGE[r.source].title}>{SOURCE_BADGE[r.source].label}</span>
                        {r.cdioMissingSince && (
                          <span className="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-red-900/40 text-red-300"
                            title={`No longer in the CDIO sheet since ${r.cdioMissingSince}. Kept: its goals and impacts are still valid.`}>
                            not in CDIO
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-ink-4 whitespace-nowrap">{r.period || '—'}</td>
                      {STAGES.map(s => (
                        <td key={s} className="px-1.5 py-1.5 text-center">
                          {r.stages[s] === 'error' ? (
                            <button onClick={() => setOpenError(isOpen ? null : r.projectId)} title={r.errors[s] || 'error'}>
                              <StageIcon state="error" title={r.errors[s] || 'error'} />
                            </button>
                          ) : (
                            <StageIcon state={r.stages[s]} title={`${STAGE_LABEL[s]}: ${r.stages[s]}`
                              + (s === 'download' && r.filesDownloaded ? ` (${r.filesDownloaded} files)` : '')
                              + (s === 'impact' && r.impactCount ? ` (${r.impactCount} relations)` : '')} />
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-2">
                        {r.loadable && (
                          <button onClick={() => loadOne(r.projectId)} disabled={busy !== null}
                            className="px-2 py-0.5 rounded bg-accent-hover text-white text-[11px] font-semibold disabled:opacity-40 hover:bg-accent">
                            {busy === r.projectId ? '…' : 'Load'}
                          </button>
                        )}
                        {!r.loadable && downloadFailed && r.linkFolder && (
                          <button onClick={() => resync(r.projectId)} disabled={busy !== null}
                            className="text-ink-muted hover:text-ink-2 disabled:opacity-40" title="Download this project's files again">↻</button>
                        )}
                        {r.source === 'manual' && (
                          <button onClick={() => removeManual(r.projectId)} disabled={busy !== null}
                            className="text-ink-muted hover:text-red-400 disabled:opacity-40" title="Remove this ad hoc project">🗑</button>
                        )}
                      </td>
                    </tr>
                    {isOpen && errKeys.length > 0 && (
                      <tr className="bg-red-950/30 border-b border-line/50">
                        <td colSpan={5 + STAGES.length} className="px-5 py-2 text-[11px] text-red-300">
                          {errKeys.map(k => <div key={k}><b>{STAGE_LABEL[k]}:</b> {r.errors[k]}</div>)}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
              {!visible.length && (
                <tr><td colSpan={5 + STAGES.length} className="px-5 py-6 text-center text-ink-muted">
                  {data ? 'No project matches these filters.' : 'Loading…'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-2 border-t border-line text-[11px] text-ink-muted">
          ✓ done · ● running · ✗ error (click to see) · · waiting for the previous stage · – not requested
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
