'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';

/**
 * Alumen on a phone.
 *
 * A separate route rather than a responsive pass over the desktop app, which is
 * built around a 100vh shell, a fixed 288px sidebar and 300-row tables — making
 * that fit a 390px screen means touching every view and still ends up as a
 * cramped desktop app. Nothing new on the backend: this reuses
 * /api/strom/dataflow-state, /api/strom/dataflow-projects, /api/impact/project
 * and /api/drive/queue exactly as the desktop does.
 *
 * Scope is deliberately the three things worth doing while away from a desk:
 * queue a project, watch it move, read its impacts.
 */

type Tab = 'chain' | 'projects' | 'queue';
type StageStatus = 'DONE' | 'ERROR' | 'IN_PROGRESS' | 'PENDING' | 'NONE';

const STAGES = [
  { key: 'copy', label: 'Copy' },
  { key: 'cleanup', label: 'Cleanup' },
  { key: 'discover', label: 'Discover' },
  { key: 'download', label: 'Download' },
  { key: 'goals', label: 'Goals' },
  { key: 'impact', label: 'Impact' },
] as const;

interface ProjectRow {
  projectId: string;
  name: string;
  stages: Record<string, StageStatus>;
}

export default function MobilePage() {
  const [tab, setTab] = useState<Tab>('projects');
  const [canQueue, setCanQueue] = useState(false);

  // The queue endpoint is the authority on whether this user is an admin:
  // a 403 means "not admin" and the tab simply never appears. Same rule the
  // desktop Data Flow uses, so there is one source of truth.
  useEffect(() => {
    fetch('/api/drive/queue')
      .then(r => setCanQueue(r.status !== 403 && r.status !== 401))
      .catch(() => setCanQueue(false));
  }, []);

  const tabs: Tab[] = canQueue ? ['chain', 'projects', 'queue'] : ['chain', 'projects'];

  return (
    <div className="min-h-screen bg-bg text-ink-1 flex flex-col">
      <header className="sticky top-0 z-20 bg-surface-1 border-b border-line px-4 py-3
                         flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="" className="w-7 h-7 rounded-lg" />
          <span className="text-base font-extrabold">Alumen</span>
        </div>
        <a href="/" className="text-[11px] text-ink-muted underline">desktop</a>
      </header>

      <main className="flex-1 pb-20">
        {tab === 'chain' && <ChainScreen />}
        {tab === 'projects' && <ProjectsScreen />}
        {tab === 'queue' && <QueueScreen />}
      </main>

      {/* Bottom bar: on a phone the thumb lives here, not at the top. */}
      <nav className="fixed bottom-0 inset-x-0 z-20 bg-surface-1 border-t border-line
                      flex pb-[env(safe-area-inset-bottom)]">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-3 text-[12px] font-semibold transition-colors
              ${tab === t ? 'text-accent-text' : 'text-ink-4'}`}
          >
            <span className="block text-lg leading-none mb-0.5">
              {t === 'chain' ? '⬡' : t === 'projects' ? '📋' : '➕'}
            </span>
            {t === 'chain' ? 'Chain' : t === 'projects' ? 'Projects' : 'Queue'}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ─── Chain: the six stages as a vertical list ───────────────────────────────

function ChainScreen() {
  const [state, setState] = useState<{
    counts: Record<string, number>;
    upstream: { rows: Array<{ stage: string; status: string }>; readAt: string | null };
    pipelineRunning: Record<string, boolean>;
  } | null>(null);

  useEffect(() => {
    const load = () => fetch('/api/strom/dataflow-state')
      .then(r => r.json()).then(setState).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (!state) return <p className="p-4 text-sm text-ink-muted">Loading…</p>;

  const up = (stage: string, status: string) =>
    state.upstream.rows.filter(r => r.stage === stage && r.status === status).length;
  const total = state.counts.totalProjects ?? 0;

  const rows = [
    { label: 'Copy', value: up('copy', 'DONE'), of: null as number | null,
      sub: 'Apps Script', running: up('copy', 'IN_PROGRESS') > 0,
      queued: up('copy', 'QUEUED'), errors: up('copy', 'ERROR') },
    { label: 'Cleanup', value: up('cleanup', 'DONE'), of: null,
      sub: 'Apps Script', running: up('cleanup', 'IN_PROGRESS') > 0,
      queued: up('cleanup', 'QUEUED'), errors: up('cleanup', 'ERROR') },
    { label: 'Discover', value: total, of: null, sub: 'PRJ folders',
      running: false, queued: 0, errors: 0 },
    { label: 'Download', value: state.counts.withFiles ?? 0, of: total, sub: 'documents',
      running: state.pipelineRunning.drive, queued: 0, errors: 0 },
    { label: 'Goals', value: state.counts.withGoals ?? 0, of: total, sub: 'Gemini',
      running: state.pipelineRunning.goals, queued: 0, errors: 0 },
    { label: 'Impact', value: state.counts.withImpacts ?? 0, of: total, sub: 'Gemini',
      running: state.pipelineRunning.impact, queued: 0, errors: 0 },
  ];

  return (
    <div className="p-4 space-y-2">
      {rows.map((r, i) => (
        <div key={r.label}
          className={`rounded-xl border p-3 ${r.running
            ? 'border-emerald-500 bg-emerald-500/5'
            : 'border-line bg-surface-1'}`}>
          <div className="flex items-baseline justify-between">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-surface-2 border border-line
                               text-[10px] font-bold text-ink-4 flex items-center justify-center">
                {i}
              </span>
              <span className="text-sm font-bold">{r.label}</span>
              <span className="text-[10px] text-ink-muted">{r.sub}</span>
            </div>
            <div className="text-right">
              <span className="text-xl font-mono font-bold">{r.value}</span>
              {r.of !== null && <span className="text-[11px] text-ink-faint"> / {r.of}</span>}
            </div>
          </div>
          {(r.running || r.queued > 0 || r.errors > 0) && (
            <div className="mt-2 flex gap-3 text-[11px]">
              {r.running && (
                <span className="font-semibold text-emerald-400 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> running
                </span>
              )}
              {r.queued > 0 && <span className="text-amber-400">{r.queued} queued</span>}
              {r.errors > 0 && <span className="text-red-300">{r.errors} failed</span>}
            </div>
          )}
        </div>
      ))}
      {state.upstream.readAt && (
        <p className="text-[10px] text-ink-faint pt-1">
          upstream read {new Date(state.upstream.readAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// ─── Projects: search, tap for detail ───────────────────────────────────────

function ProjectsScreen() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<ProjectRow | null>(null);

  useEffect(() => {
    const load = () => fetch('/api/strom/dataflow-projects')
      .then(r => r.json()).then(d => setRows(d.projects ?? [])).catch(() => {});
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const t = q.trim().toUpperCase();
    // Unfiltered this is 300+ cards on a phone — a scroll nobody finishes.
    // The list only appears once the search narrows it.
    if (!t) return rows.filter(r => Object.values(r.stages).some(s => s === 'IN_PROGRESS' || s === 'PENDING')).slice(0, 30);
    return rows.filter(r =>
      r.projectId.toUpperCase().includes(t) || (r.name || '').toUpperCase().includes(t)
    ).slice(0, 60);
  }, [rows, q]);

  if (open) return <ProjectDetail row={open} onBack={() => setOpen(null)} />;

  return (
    <div className="p-4">
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search PRJ or name…"
        className="w-full px-3 py-2.5 rounded-xl bg-surface-1 border border-line
                   text-sm outline-none focus:border-accent-border mb-3"
      />
      {rows === null && <p className="text-sm text-ink-muted">Loading…</p>}
      {rows !== null && filtered.length === 0 && (
        <p className="text-sm text-ink-muted">
          {q.trim() ? 'No match.' : 'Nothing in flight. Search to find a project.'}
        </p>
      )}
      <div className="space-y-2">
        {filtered.map(r => (
          <button key={r.projectId} onClick={() => setOpen(r)}
            className="w-full text-left rounded-xl border border-line bg-surface-1 p-3">
            <div className="font-mono text-[13px] text-accent-text">{r.projectId}</div>
            <div className="text-[12px] text-ink-2 line-clamp-2 mb-2">{r.name}</div>
            <StageDots stages={r.stages} />
          </button>
        ))}
      </div>
    </div>
  );
}

function StageDots({ stages }: { stages: Record<string, StageStatus> }) {
  return (
    <div className="flex gap-1.5">
      {STAGES.map(s => {
        const st = stages[s.key] ?? 'NONE';
        const cor =
          st === 'DONE' ? 'bg-emerald-400'
          : st === 'ERROR' ? 'bg-red-400'
          : st === 'IN_PROGRESS' ? 'bg-emerald-400 animate-pulse'
          : st === 'PENDING' ? 'bg-amber-400'
          : 'bg-ink-faint/40';
        return (
          <span key={s.key} className="flex-1 flex flex-col items-center gap-1">
            <span className={`w-full h-1.5 rounded-full ${cor}`} />
            <span className="text-[8px] text-ink-faint uppercase tracking-wide">
              {s.label.slice(0, 4)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Project detail: stages + impacts ───────────────────────────────────────

interface Impact {
  id: number;
  sourceProjectId: string;
  targetProjectId: string;
  impactType: string;
  direction: string;
  severity: string;
  explanation: string;
}

function ProjectDetail({ row, onBack }: { row: ProjectRow; onBack: () => void }) {
  const [impacts, setImpacts] = useState<Impact[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`/api/impact/project?projectId=${encodeURIComponent(row.projectId)}`)
      .then(r => r.json())
      .then(d => { if (d.error) setErr(d.error); else setImpacts(d.impacts ?? []); })
      .catch(e => setErr(String(e)));
  }, [row.projectId]);

  const sev = (s: string) =>
    s === 'high' ? 'text-red-300 border-red-500/40'
    : s === 'medium' ? 'text-amber-300 border-amber-500/40'
    : 'text-ink-3 border-line';

  return (
    <div className="p-4">
      <button onClick={onBack} className="text-[12px] text-accent-text mb-3">← back</button>

      <div className="font-mono text-sm text-accent-text">{row.projectId}</div>
      <h1 className="text-base font-bold mb-3">{row.name}</h1>

      <div className="rounded-xl border border-line bg-surface-1 p-3 mb-4">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-2">Pipeline</div>
        <div className="space-y-1.5">
          {STAGES.map(s => {
            const st = row.stages[s.key] ?? 'NONE';
            return (
              <div key={s.key} className="flex items-center justify-between text-[12px]">
                <span className="text-ink-2">{s.label}</span>
                <span className={
                  st === 'DONE' ? 'text-emerald-400'
                  : st === 'ERROR' ? 'text-red-400'
                  : st === 'IN_PROGRESS' ? 'text-emerald-400 font-semibold'
                  : st === 'PENDING' ? 'text-amber-400'
                  : 'text-ink-faint'}>
                  {st === 'NONE' ? '—' : st.toLowerCase().replace('_', ' ')}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-2">
        Impacts {impacts && `(${impacts.length})`}
      </div>
      {err && <p className="text-[12px] text-rose-400">{err}</p>}
      {impacts === null && !err && <p className="text-sm text-ink-muted">Loading…</p>}
      {impacts?.length === 0 && <p className="text-sm text-ink-muted">No impacts recorded.</p>}

      <div className="space-y-2">
        {impacts?.map(i => {
          const other = i.sourceProjectId === row.projectId ? i.targetProjectId : i.sourceProjectId;
          const outgoing = i.sourceProjectId === row.projectId;
          return (
            <div key={i.id} className={`rounded-xl border bg-surface-1 p-3 ${sev(i.severity)}`}>
              <div className="flex items-center gap-1.5 text-[12px] font-mono mb-1">
                <span className="text-ink-faint">{outgoing ? '→' : '←'}</span>
                <span className="text-accent-text">{other}</span>
                <span className="ml-auto text-[10px] uppercase">{i.severity}</span>
              </div>
              <div className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">
                {i.impactType.replace(/_/g, ' ')}
              </div>
              <p className="text-[12px] text-ink-2 whitespace-pre-wrap">{i.explanation}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Queue (admin) ──────────────────────────────────────────────────────────

interface QueueItem { projectId: string; requestedBy: string; requestedAt: string }

function QueueScreen() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [heartbeat, setHeartbeat] = useState<{ at: string; pending: number } | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/queue');
      const d = await res.json();
      if (d.ok) { setQueue(d.queue ?? []); setHeartbeat(d.heartbeat ?? null); }
    } catch { /* keep the last good view */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const submit = async () => {
    const id = projectId.trim();
    if (!id || busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/drive/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id }),
      });
      const d = await res.json();
      if (!d.ok) setMsg({ ok: false, text: d.error ?? 'failed' });
      else if (d.added) { setMsg({ ok: true, text: `${id.toUpperCase()} queued` }); setProjectId(''); }
      else setMsg({ ok: false, text: `${id.toUpperCase()}: ${d.reason}` });
      await load();
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const age = heartbeat
    ? Math.round((Date.now() - new Date(heartbeat.at).getTime()) / 60000) : null;

  return (
    <div className="p-4 space-y-4">
      <div>
        <div className="flex gap-2">
          <input
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            placeholder="PRJ0021863"
            autoCapitalize="characters"
            autoCorrect="off"
            disabled={busy}
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-1 border border-line
                       text-sm outline-none focus:border-accent-border"
          />
          <button
            onClick={submit}
            disabled={busy || !projectId.trim()}
            className="px-4 rounded-xl bg-accent-hover text-white text-sm font-semibold
                       disabled:opacity-40"
          >
            {busy ? '…' : 'Queue'}
          </button>
        </div>
        {msg && (
          <p className={`mt-2 text-[12px] ${msg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
            {msg.text}
          </p>
        )}
        <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
          Apps Script picks the request up on its next heartbeat — up to 10 minutes
          before it shows in the Chain.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface-1 p-3">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">Worker</div>
        {heartbeat ? (
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`w-2 h-2 rounded-full ${
              age !== null && age <= 30 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span>{age === null ? '—' : age < 1 ? 'just now' : `${age} min ago`}</span>
            <span className="text-ink-muted">· {heartbeat.pending} pending</span>
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">No signal.</p>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-2">
          Awaiting confirmation ({queue.length})
        </div>
        {queue.length === 0
          ? <p className="text-[12px] text-ink-muted">Queue is empty.</p>
          : (
            <div className="space-y-1.5">
              {queue.map(it => (
                <div key={it.projectId}
                  className="rounded-xl border border-line bg-surface-1 p-2.5">
                  <div className="font-mono text-[13px]">{it.projectId}</div>
                  <div className="text-[10px] text-ink-faint">
                    {it.requestedBy} · {new Date(it.requestedAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
