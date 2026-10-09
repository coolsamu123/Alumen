'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { useDrivePanelStream } from '@/hooks/useDrivePanelStream';
import type { DrivePanelState } from '@/lib/drive-panel-state';
import PipelineSection from '@/components/DrivePipeline';
import { DataFlowChain } from '@/components/DataFlowLive';
import ArchitectureCanvas from '@/components/StromArchitecture/canvas';
import DetailPanel from '@/components/StromArchitecture/panels/DetailPanel';
import { getStage } from '@/components/StromArchitecture/stages';
import type { StromStats } from '@/components/StromArchitecture';

// ─── Component ──────────────────────────────────────────────────────────────
// One screen for loading projects, in three tabs:
//   Projects — "+ Add project", "Load new from CDIO" and the single per-stage
//              table (DrivePipeline.tsx), with configuration and history below
//   Chain    — the animated chain diagram (DataFlowLive.tsx)
//   Pipeline — the architecture, click a stage for its explanation
// Replaces the former "Drive sources" / "Add a Drive source" cards, the
// Sync-all explorer and the separate Alumen menu (whose Chain and Pipeline
// views are the last two tabs).

type DriveTab = 'projects' | 'chain' | 'pipeline';
const TAB_LABEL: Record<DriveTab, string> = { projects: 'Projects', chain: '⟶ Chain', pipeline: '⬡ Pipeline' };

export default function DriveView() {
  const { refreshProjects } = useProjectContext();
  const { state, connected } = useDrivePanelStream();

  const [tab, setTab] = useState<DriveTab>('projects');
  const [toast, setToast] = useState<{ kind: 'info'|'success'|'error'; msg: string } | null>(null);
  const showToast = useCallback((kind: 'info'|'success'|'error', msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), kind === 'error' ? 8000 : 5000);
  }, []);

  // New projects discovered by a cycle: refresh the app-wide project list.
  const lastTotalRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const total = state.counts.totalProjects;
    if (lastTotalRef.current !== null && total > lastTotalRef.current) refreshProjects();
    lastTotalRef.current = total;
  }, [state, refreshProjects]);

  return (
    <div className="flex-1 overflow-auto bg-bg animate-fadeIn">
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl border text-sm font-medium ${
            toast.kind === 'success' ? 'bg-green-900/90 border-green-700 text-green-100' :
            toast.kind === 'error'   ? 'bg-red-900/90 border-red-700 text-red-100' :
                                       'bg-surface-2/90 border-line-2 text-ink-1'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <StatusHeader state={state} connected={connected} />

      <div className="px-6 pt-4 flex items-center gap-1 border-b border-line">
        {(Object.keys(TAB_LABEL) as DriveTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-accent text-accent-text' : 'border-transparent text-ink-4 hover:text-ink-2'}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {/* Kept mounted and toggled, like the app's views: no refetch or lost
          filters when switching tabs. */}
      <div className={tab === 'projects' ? 'p-6 space-y-4' : 'hidden'}>
        <PipelineSection addProject={<AddProject />} onToast={showToast} />

        <CollapsibleCard title="Configuration" subtitle="CDIO file, base folder and automatic cycle">
          <ConfigPanel onToast={showToast} />
        </CollapsibleCard>

        {state?.recentRuns.length ? (
          <CollapsibleCard title="History" subtitle={`Last ${state.recentRuns.length} cycles`}>
            <RecentRunsTable runs={state.recentRuns} />
          </CollapsibleCard>
        ) : null}
      </div>

      {tab === 'chain' && <DataFlowChain />}

      {tab === 'pipeline' && (
        <div className="p-6">
          <p className="text-[11px] text-ink-muted mb-3">
            Click any stage to inspect its inputs, outputs, code and run controls.
          </p>
          <ArchitectureBox />
        </div>
      )}
    </div>
  );
}

// ─── Configuration ───────────────────────────────────────────────────────────

function ConfigPanel({ onToast }: { onToast: (kind: 'info'|'success'|'error', msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/drive/pipeline').then(r => r.json()).then(d => d.ok && setBaseUrl(d.baseFolderUrl)).catch(() => {});
  }, []);

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/drive/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      });
      if (res.status === 409) { onToast('info', 'A cycle is already running.'); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
      onToast('info', 'Cycle started: discover → download → goals → impact.');
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <div className="pt-3 space-y-5">
      <div>
        <div className="text-xs font-semibold text-ink-2 mb-1">CDIO file</div>
        <CdioPanel />
      </div>
      <div className="border-t border-line pt-4">
        <div className="text-xs font-semibold text-ink-2 mb-1">Base folder</div>
        <p className="text-[11px] text-ink-muted mb-1">
          Where Apps Script delivers the documents of each project, already cleaned. The only place Alumen looks.
        </p>
        {baseUrl && <a href={baseUrl} target="_blank" rel="noreferrer" className="text-xs text-accent-text2 hover:underline break-all">{baseUrl}</a>}
      </div>
      <div className="border-t border-line pt-4">
        <div className="text-xs font-semibold text-ink-2 mb-1">Automatic cycle</div>
        <p className="text-[11px] text-ink-muted mb-2">
          Runs on its own every 15 minutes when there is work: once the cleanup of a project finishes, it is
          discovered, downloaded, its goals extracted and its impacts computed. Waits for the whole batch to
          leave Apps Script before starting.
        </p>
        <button onClick={runNow} disabled={busy}
          className={`px-4 py-1.5 rounded-lg border border-line text-sm text-ink-2 ${busy ? 'opacity-50' : 'hover:bg-surface-2'}`}>
          {busy ? 'Starting…' : 'Run cycle now'}
        </button>
      </div>
    </div>
  );
}

// ─── Pipeline (from the former Alumen menu) ──────────────────────────────

function ArchitectureBox() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<StromStats | null>(null);
  useEffect(() => {
    fetch('/api/strom/stats').then(r => r.json()).then(d => { if (!d.error) setStats(d); }).catch(() => {});
  }, []);
  const stage = selectedId ? getStage(selectedId) : null;
  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[520px] border border-line rounded-lg overflow-hidden">
      <div className="flex-1 min-w-0">
        <ArchitectureCanvas selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      {stage && <DetailPanel stage={stage} stats={stats} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

// ─── Status Header ──────────────────────────────────────────────────────────

function StatusHeader({
  state, connected,
}: {
  state: DrivePanelState | null;
  connected: boolean;
}) {
  const counts = state?.counts;
  const llm = state?.todayLLM;
  const isRunning = state?.pipeline.isRunning ?? false;

  return (
    <div className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line">
      <div className="px-6 py-3 flex items-center gap-4 flex-wrap">
        {/* State */}
        <div className="flex items-center gap-2 min-w-[140px]">
          {isRunning ? (
            <>
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-text2 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent"></span>
              </span>
              <span className="text-sm text-accent-text font-semibold">Running</span>
            </>
          ) : (
            <>
              <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-surface-3'}`}></span>
              <span className="text-sm text-ink-3 font-semibold">Idle</span>
            </>
          )}
        </div>

        {/* Counts */}
        <div className="flex items-center gap-3 text-xs text-ink-4 flex-1 min-w-[280px]">
          <Stat label="projects" value={counts?.totalProjects} tone="default" />
          <span className="text-ink-faint">·</span>
          <Stat label="with files"   value={counts?.withFiles}   tone="files" />
          <Stat label="with goals"   value={counts?.withGoals}   tone="goals" />
          <Stat label="with impacts" value={counts?.withImpacts} tone="impacts" />
        </div>

        {/* LLM */}
        <div className="flex items-center gap-4 text-xs text-ink-muted">
          {llm && (
            <span title={`Today: ${llm.total}/${llm.cap} LLM calls`}>
              <span className="text-ink-faint">⚡</span>{' '}
              <span className={`font-mono ${llm.remaining === 0 ? 'text-red-400' : llm.remaining < llm.cap * 0.2 ? 'text-yellow-400' : 'text-ink-3'}`}>
                {llm.total}
              </span>
              <span className="text-ink-faint">/{llm.cap}</span>
            </span>
          )}
        </div>
      </div>

      {/* LLM cap warning */}
      {llm && llm.remaining === 0 && (
        <div className="px-6 py-1.5 bg-red-950/50 border-t border-red-900/50 text-[11px] text-red-300">
          Daily LLM cap reached. Cycles will skip LLM stages until tomorrow.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone: 'default'|'files'|'goals'|'impacts' }) {
  const colorMap = {
    default: 'text-ink-1',
    files:   'text-accent-text',
    goals:   'text-green-300',
    impacts: 'text-purple-300',
  };
  return (
    <span>
      <span className={`font-mono font-semibold ${colorMap[tone]}`}>{value ?? '—'}</span>{' '}
      <span className="text-ink-muted">{label}</span>
    </span>
  );
}

function CollapsibleCard({ title, subtitle, defaultOpen = false, children }: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface-1 border border-line rounded-xl">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-surface-2/30 transition-colors rounded-t-xl"
      >
        <div>
          <div className="text-sm font-semibold text-ink-2">{title}</div>
          {subtitle && <div className="text-[11px] text-ink-muted mt-0.5">{subtitle}</div>}
        </div>
        <span className="text-ink-muted text-sm">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-5 pb-5 pt-1 border-t border-line">{children}</div>}
    </div>
  );
}

// ─── Arquivo CDIO (read from Drive) ─────────────────────────────────────────

interface CdioStatusDto {
  fileId: string;
  fileName: string | null;
  modifiedTime: string | null;
  readAt: string | null;
  checkedAt: string | null;
  error: string | null;
  lastResult: { added: number; updated: number; promoted: number; missing: number; warnings: string[] } | null;
  counts: { inSheet: number; missing: number; manual: number };
  running: boolean;
  autoLoad: boolean;
  lastAutoLoad: { at: string; added: number; error: string | null } | null;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function CdioPanel() {
  const { refreshProjects } = useProjectContext();
  const [status, setStatus] = useState<CdioStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/cdio');
      const data = await res.json();
      if (data.ok) setStatus(data.status);
    } catch { /* keep the last status */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const readNow = async () => {
    setBusy(true); setMsg('Reading the CDIO file from Drive…');
    try {
      const res = await fetch('/api/drive/cdio', { method: 'POST' });
      const data = await res.json();
      if (data.status) setStatus(data.status);
      if (!data.ok) throw new Error(data.error || 'Read failed');
      const r = data.result;
      setMsg((r
        ? `OK: ${r.added} new, ${r.updated} updated, ${r.promoted} promoted, ${r.missing} no longer in CDIO.`
        : 'OK.') + (data.autoLoaded ? ` ${data.autoLoaded} queued for Apps Script.` : ''));
      refreshProjects();
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (on: boolean) => {
    if (!on && !window.confirm('Pause automatic loading? New CDIO projects will only be queued through the "Load" button.')) return;
    try {
      const res = await fetch('/api/drive/cdio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoLoad: on }),
      });
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch { /* status poll will show the truth */ }
  };

  return (
    <div className="pt-3 space-y-3">
      <label className="flex items-start gap-2 text-xs text-ink-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={status?.autoLoad ?? true}
          disabled={!status} onChange={e => toggleAuto(e.target.checked)} />
        <span>
          <b>Load automatically</b> every CDIO project: after each read, the ones never requested are queued
          for Apps Script and go through the whole chain (copy, cleanup, discover, download, goals, impact).
          Projects whose folder is already in the base folder skip the copy.
          {status?.lastAutoLoad && (
            <span className="block text-[11px] text-ink-muted mt-0.5">
              Last automatic load: {fmtWhen(status.lastAutoLoad.at)} · {status.lastAutoLoad.added} project(s) queued
              {status.lastAutoLoad.error && <span className="text-red-400"> · error: {status.lastAutoLoad.error}</span>}
            </span>
          )}
        </span>
      </label>
      {status?.error && (
        <div className="px-3 py-2 rounded-lg bg-red-950/50 border border-red-900/50 text-xs text-red-300">
          {status.error}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div><div className="text-ink-muted">Projects in CDIO</div><div className="font-mono text-ink-1 text-sm">{status?.counts.inSheet ?? '—'}</div></div>
        <div><div className="text-ink-muted">No longer in CDIO</div><div className="font-mono text-ink-1 text-sm">{status?.counts.missing ?? '—'}</div></div>
        <div><div className="text-ink-muted">Ad hoc</div><div className="font-mono text-ink-1 text-sm">{status?.counts.manual ?? '—'}</div></div>
        <div><div className="text-ink-muted">Version read (Drive)</div><div className="text-ink-3">{fmtWhen(status?.modifiedTime ?? null)}</div></div>
      </div>
      <div className="text-[11px] text-ink-muted">
        {status?.fileName ?? 'Gating Pre-review – CDIO internal committee'} · read {fmtWhen(status?.readAt ?? null)} · last checked {fmtWhen(status?.checkedAt ?? null)}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={readNow}
          disabled={busy || status?.running}
          className={`px-4 py-1.5 rounded-lg bg-accent-hover text-white text-sm font-semibold ${busy || status?.running ? 'opacity-50' : 'hover:bg-accent'}`}
        >
          {busy || status?.running ? 'Reading…' : 'Read CDIO now'}
        </button>
        {msg && <span className="text-xs text-ink-4">{msg}</span>}
      </div>
      {status?.lastResult?.warnings?.length ? (
        <details className="text-[11px] text-ink-muted">
          <summary className="cursor-pointer">Warnings from the last read ({status.lastResult.warnings.length})</summary>
          <ul className="mt-1 list-disc pl-5">{status.lastResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      ) : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted">Plan B: upload the file by hand</summary>
        <ExcelUpload />
      </details>
    </div>
  );
}

// ─── + Adicionar projeto (avulso) ───────────────────────────────────────────

function AddProject() {
  const { refreshProjects } = useProjectContext();
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [dds, setDds] = useState('');
  const [gate, setGate] = useState('');
  const [description, setDescription] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/drive/projects/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name, dds, gate, description }),
      });
      const data = await res.json();
      if (data.needsName) { setNeedsName(true); throw new Error(data.error); }
      if (!data.ok) throw new Error(data.error || 'Failed');
      const what = data.created ? 'created as ad hoc' : `already known (${data.source === 'excel' ? 'CDIO' : data.source})`;
      const queue = data.queued
        ? 'copy requested from Apps Script'
        : data.queueNote === 'already in the base folder'
          ? 'folder already in Drive: going straight to download, goals and impact'
        : data.queueNote === 'already in the control sheet'
          ? 'already copied by Apps Script'
          : data.queueNote === 'already queued' ? 'already queued' : 'queue unchanged';
      setMsg({ kind: 'ok', text: `${data.projectId}: ${what}; ${queue}.` });
      setProjectId(''); setName(''); setDds(''); setGate(''); setDescription(''); setNeedsName(false);
      refreshProjects();
    } catch (err: unknown) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const input = 'px-3 py-1.5 rounded-lg bg-surface-2 border border-line text-sm text-ink-1 placeholder:text-ink-faint focus:outline-none focus:border-accent';
  return (
    <form onSubmit={submit} className="pt-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="PRJ0023456" className={`${input} w-40 font-mono`} />
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder={needsName ? 'Project name (required)' : 'Name (only if not in CDIO)'}
          className={`${input} flex-1 min-w-[220px] ${needsName ? 'border-yellow-600' : ''}`} />
        <button type="submit" disabled={busy || !projectId.trim()}
          className={`px-4 py-1.5 rounded-lg bg-accent-hover text-white text-sm font-semibold ${busy || !projectId.trim() ? 'opacity-50' : 'hover:bg-accent'}`}>
          {busy ? 'Adding…' : 'Add and load'}
        </button>
      </div>
      {needsName && (
        <div className="flex items-center gap-2 flex-wrap">
          <input value={dds} onChange={e => setDds(e.target.value)} placeholder="DDS (optional)" className={`${input} w-48`} />
          <input value={gate} onChange={e => setGate(e.target.value)} placeholder="Gate (optional)" className={`${input} w-32`} />
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" className={`${input} flex-1 min-w-[220px]`} />
        </div>
      )}
      {msg && <div className={`text-xs ${msg.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</div>}
    </form>
  );
}

// ─── Excel upload ───────────────────────────────────────────────────────────

function ExcelUpload() {
  const { refreshProjects } = useProjectContext();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setMsg('Uploading…');
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/api/projects/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(`OK: ${data.added} new, ${data.updated} updated, ${data.missing} no longer in CDIO (${file.name}).`);
      refreshProjects();
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'Upload failed'}`);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div className="pt-3">
      <p className="text-xs text-ink-muted mb-3">
        Plan B: upload the <code className="text-ink-3">Gating Pre-review – CDIO internal committee</code> workbook by hand if reading it from Drive fails. Same merge: nothing is deleted.
      </p>
      <label className={`inline-block px-5 py-2 rounded-lg bg-accent-hover text-white text-sm font-semibold ${busy ? 'opacity-50' : 'hover:bg-accent cursor-pointer'}`}>
        {busy ? 'Uploading…' : 'Upload Excel'}
        <input type="file" accept=".xlsx,.xls" className="hidden" disabled={busy} onChange={onChange} />
      </label>
      {msg && <div className="mt-2 text-xs text-ink-4">{msg}</div>}
    </div>
  );
}

// ─── Recent runs table ──────────────────────────────────────────────────────

function RecentRunsTable({ runs }: { runs: DrivePanelState['recentRuns'] }) {
  return (
    <div className="pt-3 overflow-hidden rounded-lg border border-line">
      <table className="w-full text-[11px]">
        <thead className="bg-surface-1 text-ink-muted uppercase">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Started</th>
            <th className="px-2 py-1.5 text-left font-medium">Trig</th>
            <th className="px-2 py-1.5 text-left font-medium">Status</th>
            <th className="px-2 py-1.5 text-right font-medium">New</th>
            <th className="px-2 py-1.5 text-right font-medium">Goals</th>
            <th className="px-2 py-1.5 text-right font-medium">Impacts</th>
            <th className="px-2 py-1.5 text-right font-medium">Errors</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map(r => (
            <tr key={r.id} className="hover:bg-surface-2/30">
              <td className="px-2 py-1.5 text-ink-3 font-mono">{new Date(r.startedAt).toLocaleString()}</td>
              <td className="px-2 py-1.5 text-ink-4">{r.trigger}</td>
              <td className="px-2 py-1.5">
                <span className={
                  r.status === 'success' ? 'text-green-400' :
                  r.status === 'error'   ? 'text-red-400' :
                  r.status === 'partial' ? 'text-yellow-400' : 'text-accent-text2'
                }>{r.status}</span>
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-ink-3">{r.newProjects}</td>
              <td className="px-2 py-1.5 text-right font-mono text-ink-3">{r.goalsAdded}</td>
              <td className="px-2 py-1.5 text-right font-mono text-ink-3">{r.impactsAdded}</td>
              <td className="px-2 py-1.5 text-right font-mono text-ink-3">{r.errorCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
