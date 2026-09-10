'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { useDrivePanelStream } from '@/hooks/useDrivePanelStream';
import type { DrivePanelState } from '@/lib/drive-panel-state';
import type { ProjectSyncStatus } from '@/lib/drive-sync-all';

// ─── Types ──────────────────────────────────────────────────────────────────

type ProjectSource = 'excel' | 'drive' | 'initiative';

interface ExplorerRow {
  projectId: string;
  name: string;
  source: ProjectSource;
  missingSince: string | null;
  dds: string;
  gate: string;
  filesDownloaded: number;
  hasGoals: boolean;
  impactCount: number;
  linkFolder: string;
  linkPositions: string;
  linkCIOO: string;
  localPath: string;
}

// Per-column filter state. Text filters use a substring match (case-insensitive).
// Select/tri-state filters use 'any' to mean "no filter".
interface ColumnFilters {
  projectId: string;
  name: string;
  dds: string;        // 'any' | exact value
  gate: string;       // 'any' | exact value
  files:   'any' | 'with' | 'without';
  goals:   'any' | 'yes' | 'no';
  impacts: 'any' | 'with' | 'without';
  drive:   'any' | 'yes' | 'no';
  local:   'any' | 'yes' | 'no';
  source:  'any' | ProjectSource;
}
const EMPTY_FILTERS: ColumnFilters = {
  projectId: '', name: '', dds: 'any', gate: 'any',
  files: 'any', goals: 'any', impacts: 'any', drive: 'any', local: 'any',
  source: 'any',
};

// Provenance is the one column that says whether a row is governed portfolio or
// something the app found on its own. Without it an initiative — which has no
// gate, DDS or cost — reads as a badly-filled project.
const SOURCE_BADGE: Record<ProjectSource, { label: string; title: string; className: string }> = {
  excel: {
    label: 'CDIO',
    title: 'From the CDIO sheet',
    className: 'bg-surface-2 text-ink-4',
  },
  drive: {
    label: 'Drive',
    title: 'PRJ folder found in Drive with no row in the CDIO sheet',
    className: 'bg-blue-900/40 text-blue-300',
  },
  initiative: {
    label: 'Iniciativa',
    title: 'Drive folder with documents but no CDIO project',
    className: 'bg-amber-900/40 text-amber-300',
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function DriveView() {
  const { projects, refreshProjects } = useProjectContext();
  const { state, connected } = useDrivePanelStream();

  // Toast: detect new projects discovered during a cycle.
  const lastTotalRef = useRef<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'info'|'success'|'error'; msg: string } | null>(null);
  useEffect(() => {
    if (!state) return;
    const total = state.counts.totalProjects;
    if (lastTotalRef.current !== null && total > lastTotalRef.current) {
      const delta = total - lastTotalRef.current;
      setToast({ kind: 'success', msg: `${delta} new project${delta > 1 ? 's' : ''} discovered.` });
      refreshProjects();
      setTimeout(() => setToast(null), 6000);
    }
    lastTotalRef.current = total;
  }, [state, refreshProjects]);

  // ─── Sync all (per-project) action ────────────────────────────────────────

  const triggerProjectResync = useCallback(async (projectId: string) => {
    try {
      const res = await fetch('/api/drive/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'project', projectId }),
      });
      if (res.status === 409) {
        setToast({ kind: 'info', msg: 'Another sync is already running.' });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start');
      }
      setToast({ kind: 'info', msg: `Re-syncing ${projectId}…` });
      setTimeout(() => setToast(null), 4000);
    } catch (err: unknown) {
      setToast({ kind: 'error', msg: err instanceof Error ? err.message : 'Run failed' });
      setTimeout(() => setToast(null), 6000);
    }
  }, []);

  const isRunning = state?.pipeline.isRunning ?? false;

  return (
    <div className="flex-1 overflow-auto bg-bg animate-fadeIn">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl border text-sm font-medium ${
            toast.kind === 'success' ? 'bg-green-900/90 border-green-700 text-green-100' :
            toast.kind === 'error'   ? 'bg-red-900/90 border-red-700 text-red-100' :
                                       'bg-accent-soft border-accent-border text-accent-fg'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* ZONE 1: Sticky Status Header */}
      <StatusHeader state={state} connected={connected} />

      <div className="p-6 space-y-6">
        {/* ZONE B: Sources (collapsible) */}
        <SourcesSection state={state} />

        {/* ZONE C: Project Explorer */}
        <ProjectExplorer
          totalProjects={state?.counts.totalProjects}
          onResync={triggerProjectResync}
          isRunning={isRunning}
          knownNames={projects}
          syncAll={state?.syncAll}
          onToast={setToast}
        />
      </div>
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

// ─── Sources Section (collapsible cards) ────────────────────────────────────

function SourcesSection({ state }: { state: DrivePanelState | null }) {
  return (
    <div className="space-y-3">
      <CollapsibleCard title="Fontes do Drive" subtitle="As pastas que o ciclo automático revisita">
        <WatchRoots />
      </CollapsibleCard>

      <CollapsibleCard title="Add a Drive source" subtitle="Descobrir projetos PRJ, ou registrar uma raiz de iniciativas">
        <AddSource />
      </CollapsibleCard>

      <CollapsibleCard title="Upload CDIO Gating Pre-review Excel" subtitle="Replace base project metadata from the 'CDIO internal committee' sheet">
        <ExcelUpload />
      </CollapsibleCard>

      {state?.recentRuns.length ? (
        <CollapsibleCard title="Recent cycles" subtitle={`Last ${state.recentRuns.length} runs`}>
          <RecentRunsTable runs={state.recentRuns} />
        </CollapsibleCard>
      ) : null}
    </div>
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

// ─── Fontes do Drive (watch roots) ──────────────────────────────────────────
// A API de roots (listar, ligar/desligar, remover) já existia inteira em
// /api/auto-discovery, mas nenhuma tela a consumia — então uma pasta cadastrada
// simplesmente sumia de vista, e não havia como saber o que o ciclo automático
// revisitava, nem desligar uma fonte sem mexer no banco.

interface WatchRoot {
  id: number;
  url: string;
  driveId: string;
  label: string;
  enabled: boolean;
  addedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string;
  addedCount: number;
  kind: 'portfolio' | 'initiatives';
}

function WatchRoots() {
  const [roots, setRoots] = useState<WatchRoot[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch('/api/auto-discovery');
      const data = await res.json();
      setRoots(data.roots ?? []);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (r: WatchRoot) => {
    setBusy(r.id);
    try {
      const res = await fetch('/api/auto-discovery/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, enabled: !r.enabled }),
      });
      const data = await res.json();
      if (data.roots) setRoots(data.roots); else await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const remove = async (r: WatchRoot) => {
    if (!confirm(`Remover a fonte "${r.label || r.url}"?\n\nOs projetos já descobertos continuam; só o ciclo automático deixa de revisitar esta pasta.`)) return;
    setBusy(r.id);
    try {
      const res = await fetch(`/api/auto-discovery?id=${r.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.roots) setRoots(data.roots); else await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  if (roots === null) return <p className="text-[12px] text-ink-muted">carregando…</p>;

  if (roots.length === 0) {
    return (
      <p className="text-[12px] text-ink-muted">
        Nenhuma fonte registrada. Use <span className="text-ink-3">Add a Drive source</span> abaixo —
        a pasta passa a ser revisitada pelo ciclo automático.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
      {roots.map(r => (
        <div key={r.id}
          className={`rounded-lg border p-3 ${r.enabled ? 'border-line bg-surface-1' : 'border-line bg-surface-1 opacity-55'}`}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-ink-1 truncate">
                  {r.label || r.driveId}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                  r.kind === 'initiatives'
                    ? 'bg-purple-900/40 text-purple-300'
                    : 'bg-accent-soft text-accent-text'}`}>
                  {r.kind === 'initiatives' ? 'INICIATIVAS' : 'PORTFÓLIO'}
                </span>
                {!r.enabled && (
                  <span className="text-[10px] text-ink-faint uppercase tracking-wider">desligada</span>
                )}
              </div>

              <a href={r.url} target="_blank" rel="noopener noreferrer"
                 className="block text-[11px] text-ink-muted hover:text-accent-text truncate mt-0.5">
                {r.url}
              </a>

              <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[10px] text-ink-faint">
                <span>
                  {r.kind === 'initiatives'
                    ? 'cada subpasta direta vira uma iniciativa'
                    : 'varre recursivamente atrás de pastas PRJxxxxx'}
                </span>
                <span>{r.addedCount} projeto(s) adicionado(s)</span>
                <span>
                  {r.lastRunAt
                    ? `última varredura ${new Date(r.lastRunAt + 'Z').toLocaleString()}`
                    : 'nunca varrida'}
                  {r.lastRunStatus === 'error' && <span className="text-rose-400"> · falhou</span>}
                </span>
              </div>

              {r.lastRunError && (
                <p className="mt-1 text-[10px] text-rose-400 break-words">{r.lastRunError}</p>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => toggle(r)}
                disabled={busy === r.id}
                className="px-2.5 py-1 rounded text-[11px] border border-line text-ink-3
                           hover:bg-surface-2 disabled:opacity-40 cursor-pointer transition-all"
              >
                {r.enabled ? 'Desligar' : 'Ligar'}
              </button>
              <button
                onClick={() => remove(r)}
                disabled={busy === r.id}
                className="px-2.5 py-1 rounded text-[11px] border border-line text-rose-400
                           hover:bg-surface-2 disabled:opacity-40 cursor-pointer transition-all"
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Add a Drive source ─────────────────────────────────────────────────────
// Two flows behind one form, because the two roots are scanned differently:
//
//   projects    — recurse the URL looking for PRJxxxxx subfolder names, then
//                 link or create the matching project.
//   initiatives — every DIRECT subfolder is one initiative, whatever it is
//                 called. The root is remembered so later additions to it are
//                 picked up, and the internal INI code is allocated here.

type SourceMode = 'projects' | 'initiatives';

interface InitiativeResult {
  created:  { projectId: string; folderName: string }[];
  seen:     { projectId: string; folderName: string }[];
  renamed:  { projectId: string; folderName: string }[];
  returned: { projectId: string; folderName: string }[];
  missing:  { projectId: string; folderName: string }[];
}

function AddSource() {
  const { refreshProjects } = useProjectContext();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<SourceMode>('projects');
  const [state, setState] = useState<'idle'|'busy'|'ok'|'err'>('idle');
  const [result, setResult] = useState<{
    created: { projectId: string; name: string }[];
    linked:  { projectId: string; name: string }[];
    unmatched: { folderName: string; extracted: string }[];
    scannedFolders: number;
  } | null>(null);
  const [iniResult, setIniResult] = useState<InitiativeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const submit = async () => {
    if (!url.trim()) return;
    setState('busy'); setResult(null); setIniResult(null); setErrorMsg('');
    try {
      const res = await fetch('/api/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: mode === 'initiatives' ? 'discover_initiatives' : 'discover',
          url: url.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (mode === 'initiatives') {
        setIniResult({
          created:  data.created  || [],
          seen:     data.seen     || [],
          renamed:  data.renamed  || [],
          returned: data.returned || [],
          missing:  data.missing  || [],
        });
      } else {
        setResult({
          created:        data.created   || [],
          linked:         data.linked    || [],
          unmatched:      data.unmatched || [],
          scannedFolders: data.scannedFolders ?? 0,
        });
      }
      setState('ok');
      setUrl('');
      refreshProjects();
    } catch (err: unknown) {
      setState('err');
      setErrorMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  const renderList = (items: { projectId: string; name: string }[]) =>
    items.slice(0, 6).map(p => (
      <span key={p.projectId} className="inline-block mr-2 mb-1 font-mono">
        {p.projectId}
      </span>
    )).concat(items.length > 6
      ? [<span key="more" className="text-ink-muted">+{items.length - 6} more</span>]
      : []);

  return (
    <div className="pt-3">
      <div className="flex gap-1 mb-3">
        {([
          { value: 'projects'    as SourceMode, label: 'Projetos (PRJ)' },
          { value: 'initiatives' as SourceMode, label: 'Iniciativas' },
        ]).map(opt => (
          <button
            key={opt.value}
            onClick={() => { setMode(opt.value); setState('idle'); setResult(null); setIniResult(null); }}
            className={`px-3 py-1 rounded text-xs font-semibold ${
              mode === opt.value
                ? 'bg-purple-700 text-white'
                : 'bg-surface-2 text-ink-3 hover:bg-surface-3'
            }`}
          >{opt.label}</button>
        ))}
      </div>
      <p className="text-xs text-ink-muted mb-3">
        {mode === 'projects' ? (
          <>
            Paste a Drive folder URL — the engine scans subfolders for any name containing{' '}
            <code className="text-ink-3">PRJ</code>. Existing projects get the link attached;
            unknown PRJ codes are created as new entries.
          </>
        ) : (
          <>
            Cole a URL da pasta-mãe de iniciativas. Cada subpasta <strong>direta</strong> vira
            uma iniciativa, com o nome que a equipe deu — não há convenção a seguir. A pasta
            fica registrada, então subpastas e documentos adicionados depois entram sozinhos.
          </>
        )}
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="https://drive.google.com/drive/folders/..."
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="flex-1 bg-surface-deep border border-line text-ink-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-border"
        />
        <button
          onClick={submit}
          disabled={!url.trim() || state === 'busy'}
          className="px-5 py-2 rounded-lg bg-purple-700 text-white text-sm font-semibold hover:bg-purple-600 disabled:opacity-40"
        >
          {state === 'busy' ? 'Scanning…' : 'Add'}
        </button>
      </div>

      {state === 'err' && (
        <div className="mt-2 text-xs text-red-400">{errorMsg}</div>
      )}

      {state === 'ok' && iniResult && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="text-ink-muted">
            {iniResult.created.length + iniResult.seen.length + iniResult.renamed.length} pasta(s) de
            iniciativa · {iniResult.created.length} nova(s)
          </div>
          {iniResult.created.length + iniResult.seen.length + iniResult.renamed.length === 0 && (
            <div className="text-ink-4 italic">Nenhuma subpasta direta encontrada nessa raiz.</div>
          )}
          {iniResult.created.length > 0 && (
            <div>
              <span className="text-green-400 font-semibold">+ {iniResult.created.length} nova(s):</span>{' '}
              <span className="text-ink-3">
                {iniResult.created.slice(0, 8).map(i => (
                  <span key={i.projectId} className="inline-block mr-2 mb-1">
                    <span className="font-mono text-ink-4">{i.projectId}</span> {i.folderName}
                  </span>
                ))}
              </span>
            </div>
          )}
          {iniResult.renamed.length > 0 && (
            <div className="text-ink-4">
              {iniResult.renamed.length} pasta(s) renomeada(s) — nome atualizado, iniciativa preservada
            </div>
          )}
          {iniResult.returned.length > 0 && (
            <div className="text-accent-text2">
              {iniResult.returned.length} pasta(s) reapareceram no Drive
            </div>
          )}
          {iniResult.missing.length > 0 && (
            <div className="text-yellow-400">
              ⚠ {iniResult.missing.length} iniciativa(s) não estão mais no Drive — marcadas, não apagadas
            </div>
          )}
        </div>
      )}

      {state === 'ok' && result && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="text-ink-muted">
            Scanned {result.scannedFolders} folder{result.scannedFolders !== 1 ? 's' : ''} ·
            {' '}{result.linked.length} linked, {result.created.length} created
            {result.unmatched.length > 0 && `, ${result.unmatched.length} unmatched (saved as new)`}
          </div>
          {result.created.length === 0 && result.linked.length === 0 && (
            <div className="text-ink-4 italic">No folders matching the PRJ pattern were found.</div>
          )}
          {result.linked.length > 0 && (
            <div>
              <span className="text-accent-text2 font-semibold">✓ Linked to {result.linked.length} existing project{result.linked.length > 1 ? 's' : ''}:</span>{' '}
              <span className="text-ink-3">{renderList(result.linked)}</span>
            </div>
          )}
          {result.created.length > 0 && (
            <div>
              <span className="text-green-400 font-semibold">+ Created {result.created.length} new project{result.created.length > 1 ? 's' : ''}:</span>{' '}
              <span className="text-ink-3">{renderList(result.created)}</span>
            </div>
          )}
          {result.unmatched.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-yellow-400 hover:text-yellow-300">
                ⚠ {result.unmatched.length} folder{result.unmatched.length > 1 ? 's' : ''} didn&apos;t match any existing project ID
              </summary>
              <ul className="mt-1 ml-4 space-y-0.5 text-ink-4">
                {result.unmatched.slice(0, 20).map(u => (
                  <li key={u.extracted} className="font-mono text-[11px]">
                    <span className="text-yellow-500">{u.extracted}</span>
                    <span className="text-ink-faint"> ← </span>
                    <span>{u.folderName}</span>
                  </li>
                ))}
                {result.unmatched.length > 20 && (
                  <li className="text-ink-muted">…and {result.unmatched.length - 20} more</li>
                )}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
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
      setMsg(`Success: parsed ${data.count} projects from ${file.name}.`);
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
        Upload the <code className="text-ink-3">Gating Pre-review – CDIO internal committee</code> workbook to populate base project metadata. Replaces all existing projects.
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

// ─── Project Explorer ───────────────────────────────────────────────────────

function ProjectExplorer({
  totalProjects, onResync, isRunning, knownNames, syncAll, onToast,
}: {
  totalProjects: number | undefined;
  onResync: (projectId: string) => void;
  isRunning: boolean;
  knownNames: { projectId: string; name: string }[];
  syncAll: DrivePanelState['syncAll'] | undefined;
  onToast: (t: { kind: 'info'|'success'|'error'; msg: string } | null) => void;
}) {
  const syncing = syncAll?.status === 'running' || syncAll?.status === 'stopping';
  // Identify the project currently being processed by Sync-all (first 'counting'
  // or 'downloading' entry) so we can keep it scrolled into view as it changes.
  const activeProjectId = useMemo(() => {
    if (!syncAll || !syncing) return '';
    for (const p of Object.values(syncAll.perProject)) {
      if (p.status === 'counting' || p.status === 'downloading') return p.projectId;
    }
    return '';
  }, [syncAll, syncing]);

  const startSyncAll = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/sync-all', { method: 'POST' });
      if (res.status === 409) {
        onToast({ kind: 'info', msg: 'Sync is already running.' });
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to start');
      onToast({ kind: 'info', msg: 'Sync started.' });
      setTimeout(() => onToast(null), 3000);
    } catch (err: unknown) {
      onToast({ kind: 'error', msg: err instanceof Error ? err.message : 'Failed' });
      setTimeout(() => onToast(null), 5000);
    }
  }, [onToast]);

  const stopSyncAll = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/sync-all', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to stop');
      onToast({ kind: 'info', msg: 'Stop requested. Finishing in-flight files…' });
      setTimeout(() => onToast(null), 4000);
    } catch (err: unknown) {
      onToast({ kind: 'error', msg: err instanceof Error ? err.message : 'Failed' });
      setTimeout(() => onToast(null), 5000);
    }
  }, [onToast]);
  const [rows, setRows] = useState<ExplorerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ColumnFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ col: keyof ExplorerRow; dir: 'asc'|'desc' }>({ col: 'projectId', dir: 'asc' });

  const updateFilter = <K extends keyof ColumnFilters>(key: K, value: ColumnFilters[K]) =>
    setFilters(f => ({ ...f, [key]: value }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const hasActiveFilter = useMemo(
    () => (Object.keys(EMPTY_FILTERS) as (keyof ColumnFilters)[]).some(
      k => filters[k] !== EMPTY_FILTERS[k]
    ),
    [filters],
  );

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/drive/projects');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setRows(data.rows || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + reload when totalProjects changes (new projects discovered)
  // or when a run finishes.
  useEffect(() => { load(); }, [load]);
  const lastTotalRef = useRef<number | undefined>(undefined);
  const lastRunningRef = useRef<boolean>(false);
  useEffect(() => {
    if (totalProjects !== lastTotalRef.current) {
      lastTotalRef.current = totalProjects;
      if (rows !== null) load();
    }
    // Cycle just finished → reload once so file counts/local paths refresh.
    if (lastRunningRef.current && !isRunning && rows !== null) {
      load();
    }
    lastRunningRef.current = isRunning;
  }, [totalProjects, isRunning, load, rows]);

  // While Sync-all is running, refresh the explorer periodically so per-project
  // file counts and Local paths advance in near real-time (independent of the
  // per-row progress bar, which comes from SSE).
  useEffect(() => {
    if (!syncing) return;
    const id = setInterval(() => { load(); }, 4000);
    return () => clearInterval(id);
  }, [syncing, load]);

  // Auto-scroll the currently downloading project into view so the user sees progress.
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  useEffect(() => {
    if (!activeProjectId) return;
    const el = rowRefs.current.get(activeProjectId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeProjectId]);

  const ddsValues = useMemo(() => {
    const set = new Set<string>();
    (rows || []).forEach(r => r.dds && set.add(r.dds));
    return Array.from(set).sort();
  }, [rows]);
  const gateValues = useMemo(() => {
    const set = new Set<string>();
    (rows || []).forEach(r => r.gate && set.add(r.gate));
    return Array.from(set).sort();
  }, [rows]);

  const visible = useMemo(() => {
    if (!rows) return [];
    let out = rows;

    const idQ   = filters.projectId.trim().toLowerCase();
    const nameQ = filters.name.trim().toLowerCase();
    if (idQ)   out = out.filter(r => r.projectId.toLowerCase().includes(idQ));
    if (nameQ) out = out.filter(r => r.name.toLowerCase().includes(nameQ));
    if (filters.dds  !== 'any') out = out.filter(r => r.dds  === filters.dds);
    if (filters.gate !== 'any') out = out.filter(r => r.gate === filters.gate);
    if (filters.files   === 'with')    out = out.filter(r => r.filesDownloaded > 0);
    if (filters.files   === 'without') out = out.filter(r => r.filesDownloaded === 0);
    if (filters.goals   === 'yes')     out = out.filter(r => r.hasGoals);
    if (filters.goals   === 'no')      out = out.filter(r => !r.hasGoals);
    if (filters.impacts === 'with')    out = out.filter(r => r.impactCount > 0);
    if (filters.impacts === 'without') out = out.filter(r => r.impactCount === 0);
    if (filters.drive   === 'yes')     out = out.filter(r => !!r.linkFolder);
    if (filters.drive   === 'no')      out = out.filter(r => !r.linkFolder);
    if (filters.local   === 'yes')     out = out.filter(r => !!r.localPath);
    if (filters.local   === 'no')      out = out.filter(r => !r.localPath);
    if (filters.source  !== 'any')     out = out.filter(r => r.source === filters.source);

    const dir = sort.dir === 'asc' ? 1 : -1;
    // For hasGoals (boolean), coerce to number for stable sort.
    const accessor = (r: ExplorerRow): string | number => {
      const v = r[sort.col];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as string | number;
    };
    out = [...out].sort((a, b) => {
      const av = accessor(a); const bv = accessor(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return out;
  }, [rows, filters, sort]);

  const toggleSort = (col: keyof ExplorerRow) => {
    setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });
  };

  return (
    <div className="bg-surface-1 border border-line rounded-xl">
      <div className="px-5 py-3 flex items-center gap-3 flex-wrap border-b border-line">
        <div className="text-sm font-semibold text-ink-2">Projects</div>
        <div className="text-[11px] text-ink-muted">{visible.length} / {rows?.length ?? 0}</div>
        {/* DEBUG: temporary indicator so we know SSE is delivering the syncAll payload. */}
        {syncAll && (
          <div className={`text-[10px] font-mono px-2 py-0.5 rounded ${
            syncing ? 'bg-accent-soft text-accent-text' :
            syncAll.status === 'done' && syncAll.totalProjects > 0 ? 'bg-green-900/40 text-green-300' :
            'bg-surface-2 text-ink-muted'
          }`}>
            sync:{syncAll.status} · {Object.keys(syncAll.perProject).length} entries · {syncAll.doneFiles}/{syncAll.totalFiles} files
          </div>
        )}
        {syncing && syncAll && (
          <div className="flex items-center gap-2 text-[11px] text-accent-text">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-text2 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
            </span>
            <span className="font-mono">
              {syncAll.doneProjects}/{syncAll.totalProjects} projects ·
              {' '}{syncAll.doneFiles}/{syncAll.totalFiles || '?'} files
            </span>
          </div>
        )}
        <div className="flex-1" />
        {hasActiveFilter && (
          <button
            onClick={clearFilters}
            className="px-2.5 py-1 rounded bg-surface-2 text-ink-3 text-xs hover:bg-surface-3"
            title="Clear all column filters"
          >Clear filters</button>
        )}
        {!syncing ? (
          <button
            onClick={startSyncAll}
            disabled={isRunning}
            className="px-3 py-1 rounded bg-accent-hover text-white text-xs font-semibold hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
            title="Count and download all linked Drive folders"
          >▶ Sync all</button>
        ) : (
          <button
            onClick={stopSyncAll}
            disabled={syncAll?.status === 'stopping'}
            className="px-3 py-1 rounded bg-red-700 text-white text-xs font-semibold hover:bg-red-600 disabled:opacity-40"
            title="Stop after finishing in-flight files"
          >■ {syncAll?.status === 'stopping' ? 'Stopping…' : 'Stop all'}</button>
        )}
        <button
          onClick={load} disabled={loading}
          className="px-2.5 py-1 rounded bg-surface-2 text-ink-3 text-xs hover:bg-surface-3 disabled:opacity-40"
          title="Reload"
        >↻</button>
      </div>

      {error && (
        <div className="px-5 py-3 text-xs text-red-400 border-b border-line">
          {error}{' — '}
          {error.includes('404') || error.includes('Cannot find') ? 'restart the dev server to register the new endpoints.' : ''}
        </div>
      )}

      <div className="overflow-auto max-h-[55vh]">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-deep sticky top-0 z-10">
            <tr>
              <ColumnHeader label="ID"      col="projectId"       sort={sort} onSort={toggleSort}
                filter={<FilterInput value={filters.projectId} onChange={v => updateFilter('projectId', v)} placeholder="PRJ…" />} />
              <ColumnHeader label="Name"    col="name"            sort={sort} onSort={toggleSort}
                filter={<FilterInput value={filters.name} onChange={v => updateFilter('name', v)} placeholder="name…" />} />
              <ColumnHeader label="Origem"  col="source"          sort={sort} onSort={toggleSort}
                filter={<FilterSelect value={filters.source} onChange={v => updateFilter('source', v as ColumnFilters['source'])}
                  options={[
                    { value: 'any', label: 'All' },
                    { value: 'excel', label: 'CDIO' },
                    { value: 'drive', label: 'Drive' },
                    { value: 'initiative', label: 'Iniciativa' },
                  ]} />} />
              <ColumnHeader label="DDS"     col="dds"             sort={sort} onSort={toggleSort}
                filter={<FilterSelect value={filters.dds} onChange={v => updateFilter('dds', v)}
                  options={[{ value: 'any', label: 'All' }, ...ddsValues.map(v => ({ value: v, label: v }))]} />} />
              <ColumnHeader label="Gate"    col="gate"            sort={sort} onSort={toggleSort} align="center"
                filter={<FilterSelect value={filters.gate} onChange={v => updateFilter('gate', v)}
                  options={[{ value: 'any', label: 'All' }, ...gateValues.map(v => ({ value: v, label: v }))]} />} />
              <ColumnHeader label="Files"   col="filesDownloaded" sort={sort} onSort={toggleSort} align="right"
                filter={<FilterSelect value={filters.files} onChange={v => updateFilter('files', v as ColumnFilters['files'])}
                  options={[{ value: 'any', label: 'Any' }, { value: 'with', label: '>0' }, { value: 'without', label: '0' }]} />} />
              <ColumnHeader label="Goals"   col="hasGoals"        sort={sort} onSort={toggleSort} align="center"
                filter={<FilterSelect value={filters.goals} onChange={v => updateFilter('goals', v as ColumnFilters['goals'])}
                  options={[{ value: 'any', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />} />
              <ColumnHeader label="Impacts" col="impactCount"     sort={sort} onSort={toggleSort} align="right"
                filter={<FilterSelect value={filters.impacts} onChange={v => updateFilter('impacts', v as ColumnFilters['impacts'])}
                  options={[{ value: 'any', label: 'Any' }, { value: 'with', label: '>0' }, { value: 'without', label: '0' }]} />} />
              <ColumnHeader label="GDrive"  col="linkFolder"      sort={sort} onSort={toggleSort}
                filter={<FilterSelect value={filters.drive} onChange={v => updateFilter('drive', v as ColumnFilters['drive'])}
                  options={[{ value: 'any', label: 'Any' }, { value: 'yes', label: 'Linked' }, { value: 'no', label: 'None' }]} />} />
              <ColumnHeader label="Local"   col="localPath"       sort={sort} onSort={toggleSort}
                filter={<FilterSelect value={filters.local} onChange={v => updateFilter('local', v as ColumnFilters['local'])}
                  options={[{ value: 'any', label: 'Any' }, { value: 'yes', label: 'Downloaded' }, { value: 'no', label: 'No' }]} />} />
              <th className="px-2 py-1.5 text-right align-top text-[10px] uppercase text-ink-muted font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {loading && rows === null && (
              <tr><td colSpan={11} className="px-5 py-6 text-center text-ink-muted text-xs">Carregando…</td></tr>
            )}
            {!loading && visible.length === 0 && rows !== null && (
              <tr><td colSpan={11} className="px-5 py-6 text-center text-ink-muted text-xs italic">No matches.</td></tr>
            )}
            {visible.map(r => {
              const ps = syncAll?.perProject[r.projectId];
              const isActive = ps?.status === 'counting' || ps?.status === 'downloading';
              const psStatus: ProjectSyncStatus | undefined = ps?.status;
              const psPct = ps && ps.totalFiles > 0
                ? Math.min(100, (ps.doneFiles / ps.totalFiles) * 100)
                : (ps?.status === 'counting' ? 5 : 0);
              // Row-wide progress: paint a gradient across the whole row that
              // fills exactly to psPct%. Color encodes the status. Opacities
              // pushed high enough to be obviously visible on the dark theme.
              const barColor =
                ps?.status === 'counting'    ? 'rgba(234,179,8,0.40)'  : // yellow-500
                ps?.status === 'downloading' ? 'rgba(59,130,246,0.45)' : // blue-500
                ps?.status === 'done'        ? 'rgba(34,197,94,0.28)'  : // green-500
                ps?.status === 'error'       ? 'rgba(239,68,68,0.40)'  : // red-500
                ps?.status === 'skipped'     ? 'rgba(107,114,128,0.32)': // gray-500
                                               'transparent';
              const rowStyle: React.CSSProperties | undefined =
                ps && ps.status !== 'pending'
                  ? {
                      backgroundImage: `linear-gradient(to right, ${barColor} ${psPct}%, transparent ${psPct}%)`,
                      transition: 'background-image 300ms linear',
                    }
                  : undefined;
              return (
              <tr
                key={r.projectId}
                ref={(el) => {
                  if (el) rowRefs.current.set(r.projectId, el);
                  else rowRefs.current.delete(r.projectId);
                }}
                style={rowStyle}
                className={`hover:bg-surface-2/30 ${isActive ? 'shadow-[inset_3px_0_0_0_rgb(59_130_246)]' : ''}`}
              >
                <td className="px-2 py-1.5 font-mono text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={psStatus} />
                    {r.projectId}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-ink-3 max-w-xs truncate" title={r.name}>{r.name || '—'}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${SOURCE_BADGE[r.source].className}`}
                    title={SOURCE_BADGE[r.source].title}
                  >
                    {SOURCE_BADGE[r.source].label}
                  </span>
                  {r.missingSince && (
                    <span
                      className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-900/40 text-red-300"
                      title={`Folder no longer in Drive since ${r.missingSince}. Kept: its goals and impact edges are still valid.`}
                    >
                      fora do Drive
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-ink-4">{r.dds || '—'}</td>
                <td className="px-2 py-1.5 text-center text-ink-4">{r.gate || '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {ps && ps.status !== 'pending' ? (
                    <span className={ps.status === 'error' ? 'text-red-400' : 'text-accent-text'}>
                      {ps.doneFiles}{ps.totalFiles > 0 && <span className="text-ink-muted">/{ps.totalFiles}</span>}
                    </span>
                  ) : (
                    <span className={r.filesDownloaded > 0 ? 'text-accent-text' : 'text-ink-faint'}>
                      {r.filesDownloaded}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {r.hasGoals
                    ? <span className="text-green-400" title="Goals extracted">✓</span>
                    : <span className="text-ink-faint">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  <span className={r.impactCount > 0 ? 'text-purple-300' : 'text-ink-faint'}>
                    {r.impactCount}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-[10px] max-w-[280px]">
                  {r.linkFolder ? (
                    <a
                      href={r.linkFolder.split(' ')[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={r.linkFolder.split(' ')[0]}
                      className="text-accent-text2 hover:text-accent-text hover:underline truncate inline-block max-w-full align-bottom"
                    >
                      {r.linkFolder.split(' ')[0]}
                    </a>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-[10px] max-w-[260px]">
                  {r.localPath ? (
                    <span className="text-ink-4 truncate inline-block max-w-full align-bottom" title={r.localPath}>
                      {r.localPath}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    onClick={() => onResync(r.projectId)}
                    disabled={isRunning}
                    title="Re-sync this project's Drive links"
                    className="px-2 py-0.5 rounded text-[11px] bg-surface-2 text-ink-3 hover:bg-accent-hover hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ↻ Sync
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* knownNames is here just to silence unused warning if needed */}
      <span className="hidden">{knownNames.length}</span>
    </div>
  );
}

// Combined sort + filter header. The label area is clickable to toggle sort
// direction; the filter input/select lives directly below in the same column,
// so each control unambiguously belongs to its column.
function ColumnHeader({
  label, col, sort, onSort, filter, align = 'left',
}: {
  label: string;
  col: keyof ExplorerRow;
  sort: { col: keyof ExplorerRow; dir: 'asc'|'desc' };
  onSort: (col: keyof ExplorerRow) => void;
  filter: React.ReactNode;
  align?: 'left'|'right'|'center';
}) {
  const isActive = sort.col === col;
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <th className="px-1.5 py-1.5 align-top">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onSort(col)}
          className={`flex items-center gap-1 ${justify} text-[10px] uppercase font-medium text-ink-muted hover:text-ink-2 cursor-pointer select-none`}
        >
          <span>{label}</span>
          <span className="text-ink-4 w-2 inline-block">
            {isActive ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
        <div onClick={e => e.stopPropagation()}>{filter}</div>
      </div>
    </th>
  );
}

function FilterInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      className="w-full bg-surface-1 border border-line-strong text-ink-2 rounded px-1.5 py-0.5 text-[11px] font-normal normal-case focus:outline-none focus:border-accent-border placeholder:text-ink-faint"
    />
  );
}

function StatusDot({ status }: { status: ProjectSyncStatus | undefined }) {
  if (!status || status === 'pending') return null;
  const cls = status === 'counting'    ? 'bg-yellow-400 animate-pulse ring-yellow-300/40' :
              status === 'downloading' ? 'bg-accent-text2 animate-pulse ring-accent-border/40' :
              status === 'done'        ? 'bg-green-500 ring-green-400/30' :
              status === 'error'       ? 'bg-red-500 ring-red-400/40' :
                                         'bg-ink-muted ring-ink-4/30';
  const tip = status === 'counting' ? 'Counting files in Drive…' :
              status === 'downloading' ? 'Downloading…' :
              status === 'done' ? 'Done' :
              status === 'error' ? 'Error' :
                                   'Skipped';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ring-2 ${cls}`} title={tip} />;
}

function FilterSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      className="w-full bg-surface-1 border border-line-strong text-ink-2 rounded px-1 py-0.5 text-[11px] font-normal normal-case focus:outline-none focus:border-accent-border cursor-pointer"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

