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

type SubView = 'chain' | 'projects' | 'queue';
type StageStatus = 'DONE' | 'ERROR' | 'IN_PROGRESS' | 'PENDING' | 'NONE';

interface DataFlowState {
  upstream: UpstreamSnapshot;
  counts: { totalProjects: number; withFiles: number; withGoals: number; withImpacts: number };
  pipelineRunning: { drive: boolean; goals: boolean; impact: boolean };
  generatedAt: string;
}

interface QueueItem {
  projectId: string;
  requestedBy: string;
  requestedAt: string;
}

/**
 * A fila é admin-only (o endpoint vive sob /api/drive, que middleware.ts
 * fecha para basic). Em vez de plumbar o papel do usuário até aqui, deixamos o
 * próprio endpoint decidir: 403 significa "não é admin", e a aba nem aparece.
 * Uma autoridade só, do lado do servidor.
 */
function useQueue() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [heartbeat, setHeartbeat] = useState<{ at: string; pending: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/drive/queue');
      if (res.status === 403 || res.status === 401) { setAllowed(false); return; }
      const data = await res.json();
      setAllowed(true);
      if (data.ok) {
        setQueue(data.queue ?? []);
        setHeartbeat(data.heartbeat ?? null);
        setError(null);
      } else {
        setError(data.error ?? 'falha ao ler a fila');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  return { allowed, queue, heartbeat, error, reload: load };
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
  const q = useQueue();

  const views: SubView[] = q.allowed ? ['chain', 'projects', 'queue'] : ['chain', 'projects'];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-bg">
      <div className="shrink-0 px-6 py-3 border-b border-line bg-surface-1 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {views.map(v => (
            <button
              key={v}
              onClick={() => setSubView(v)}
              className={`px-3 py-1 rounded text-[12px] font-medium transition-all cursor-pointer
                ${subView === v
                  ? 'bg-accent-soft border border-accent-border text-accent-text'
                  : 'text-ink-4 hover:bg-surface-2 border border-transparent'
                }`}
            >
              {v === 'chain' ? '⬡ Cadeia' : v === 'projects' ? '📋 Projetos' : '➕ Fila'}
              {v === 'queue' && q.queue.length > 0 && (
                <span className="ml-1.5 px-1.5 rounded-full bg-accent-soft text-accent-text text-[10px]">
                  {q.queue.length}
                </span>
              )}
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
        ) : subView === 'projects' ? (
          <ProjectsTable />
        ) : (
          <QueuePanel q={q} />
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
  const anyRunning = Boolean(pipeline?.drive || pipeline?.goals || pipeline?.impact);

  const copyDone = upstreamCount('copy', 'DONE');
  const cleanDone = upstreamCount('cleanup', 'DONE');

  return (
    <div className="p-8 flex flex-col gap-2 max-w-6xl mx-auto">
      {upstream?.error && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-300 text-[12px]">
          ⚠ Upstream (Apps Script) não pôde ser lido: {upstream.error} — mostrando o último dado bom.
        </div>
      )}

      {/* ── Faixa 1: fora do Alumen ─────────────────────────────────────── */}
      <LaneLabel
        text="Fora do Alumen · Apps Script"
        hint={upstream ? `${upstream.stale ? 'cache' : 'ao vivo'}${upstream.readAt ? ' · ' + new Date(upstream.readAt).toLocaleTimeString() : ''}` : undefined}
      />
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-0">
        <StageNode
          num={0} icon="📥" title="Copy" sub="syncProjectFiles"
          metric={{ value: copyDone, label: 'copiados' }}
          errors={upstreamCount('copy', 'ERROR')}
          running={upstreamCount('copy', 'IN_PROGRESS') > 0}
        />
        <Conduit active={copyDone > 0} />
        <StageNode
          num={1} icon="🧹" title="Cleanup" sub="removeClassification"
          metric={{ value: cleanDone, label: 'limpos' }}
          errors={upstreamCount('cleanup', 'ERROR')}
          running={upstreamCount('cleanup', 'IN_PROGRESS') > 0}
        />
      </div>

      {/* conduíte vertical entre os dois mundos */}
      <div className="flex justify-center py-1">
        <Conduit vertical active={cleanDone > 0} />
      </div>

      {/* ── Faixa 2: dentro do Alumen ───────────────────────────────────── */}
      <LaneLabel text="Alumen · Analysis Pipeline" accent />
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-0">
        <StageNode
          num={2} icon="🔍" title="Discover" sub="pastas PRJ-XXXXX"
          metric={{ value: total, label: 'projetos' }}
        />
        <Conduit active={total > 0} />
        <StageNode
          num={3} icon="⬇️" title="Download" sub="DOCX · XLSX · PDF"
          metric={{ value: counts?.withFiles ?? 0, of: total, label: 'com arquivos' }}
          running={pipeline?.drive}
        />
        <Conduit active={(counts?.withFiles ?? 0) > 0} fast={pipeline?.goals} />
        <StageNode
          num={4} icon="🧠" title="Goals" sub="Tech · DDS · GIO" badge="Gemini"
          metric={{ value: counts?.withGoals ?? 0, of: total, label: 'com goals' }}
          running={pipeline?.goals}
        />
        <Conduit active={(counts?.withGoals ?? 0) > 0} fast={pipeline?.impact} />
        <StageNode
          num={5} icon="🔗" title="Impact" sub="cruzamentos · citações" badge="Gemini"
          metric={{ value: counts?.withImpacts ?? 0, of: total, label: 'com impactos' }}
          running={pipeline?.impact}
        />
      </div>

      <div className="flex justify-center py-1">
        <Conduit vertical active={(counts?.withImpacts ?? 0) > 0} />
      </div>

      {/* ── Saídas ──────────────────────────────────────────────────────── */}
      <LaneLabel text="Saídas" />
      <div className="flex flex-wrap gap-2">
        {['Projects', 'Goals', 'Impact Graph', 'Matrix'].map(o => (
          <span key={o}
            className="px-3 py-1.5 rounded-lg bg-surface-1 border border-line text-[11px] text-ink-3">
            {o}
          </span>
        ))}
      </div>

      {anyRunning && (
        <p className="mt-4 text-[11px] text-accent-text flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-text animate-pulse" />
          pipeline em execução — os conduítes ativos correm mais rápido
        </p>
      )}
    </div>
  );
}

function LaneLabel({ text, hint, accent }: { text: string; hint?: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 mt-4 mb-2">
      <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${accent ? 'text-accent-text' : 'text-ink-4'}`}>
        {text}
      </span>
      <span className="flex-1 h-px bg-line" />
      {hint && <span className="text-[10px] text-ink-faint">{hint}</span>}
    </div>
  );
}

/**
 * O conduíte entre duas etapas. As partículas são o dado em trânsito.
 *
 * `active` = já passou coisa por aqui (senão o trilho fica inerte, e a ausência
 * de movimento é informação: nada chegou nesta etapa ainda).
 * `fast`   = a etapa seguinte está processando agora.
 *
 * A animação usa left/top em %, então funciona em qualquer largura sem medir
 * nada em JS. Em telas estreitas o conduíte vira vertical junto com o layout.
 */
function Conduit({ active, fast, vertical }: { active?: boolean; fast?: boolean; vertical?: boolean }) {
  const dur = fast ? '1.1s' : '2.8s';
  const dots = [0, 1, 2];

  if (vertical) {
    return (
      <div className="relative w-px h-8" aria-hidden>
        <div className={`absolute inset-0 w-px ${active ? 'alumen-track-live-y' : 'bg-line'}`} />
        {active && dots.map(i => (
          <span key={i}
            className="alumen-particle alumen-particle-y w-1 h-1 bg-accent-text"
            style={{ ['--flow-dur' as string]: dur, animationDelay: `${i * 0.9}s` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-w-[28px] h-px sm:h-px my-4 sm:my-0 mx-0 sm:mx-1" aria-hidden>
      <div className={`absolute inset-0 h-px ${active ? 'alumen-track-live' : 'bg-line'}`} />
      {active && dots.map(i => (
        <span key={i}
          className="alumen-particle alumen-particle-x w-1 h-1 bg-accent-text"
          style={{ ['--flow-dur' as string]: dur, animationDelay: `${i * 0.9}s` }} />
      ))}
    </div>
  );
}

function StageNode({
  num, icon, title, sub, badge, running, metric, errors,
}: {
  num: number;
  icon: string;
  title: string;
  sub: string;
  badge?: string;
  running?: boolean;
  errors?: number;
  metric: { value: number; of?: number; label: string };
}) {
  const pct = metric.of && metric.of > 0
    ? Math.min(100, Math.round((metric.value / metric.of) * 100))
    : null;

  return (
    <div
      className={`relative flex-1 min-w-0 rounded-2xl border p-4 transition-all
        ${running
          ? 'border-accent-border bg-surface-2 alumen-halo'
          : 'border-line bg-surface-1 hover:border-line-strong'}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-5 h-5 shrink-0 rounded-full bg-surface-2 border border-line
                         text-[10px] font-bold text-ink-4 flex items-center justify-center">
          {num}
        </span>
        <span className="text-base leading-none">{icon}</span>
        <span className="text-[13px] font-bold text-ink-1 truncate">{title}</span>
        {badge && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-900/40 text-purple-300 shrink-0">
            {badge}
          </span>
        )}
      </div>

      <div className="text-[10px] text-ink-muted mb-3 truncate">{sub}</div>

      <div className="flex items-end gap-1.5">
        <span className="text-2xl font-mono font-bold text-ink-1 leading-none">{metric.value}</span>
        {metric.of !== undefined && (
          <span className="text-[11px] font-mono text-ink-faint leading-none mb-0.5">/ {metric.of}</span>
        )}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-ink-faint mt-1">{metric.label}</div>

      {pct !== null && (
        <div className="mt-2.5 h-1 rounded-full bg-surface-2 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-text transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {(running || (errors ?? 0) > 0) && (
        <div className="mt-2.5 flex items-center gap-2">
          {running && (
            <span className="flex items-center gap-1 text-[10px] text-accent-text">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-text animate-pulse" /> rodando
            </span>
          )}
          {(errors ?? 0) > 0 && (
            <span className="text-[10px] text-red-300">{errors} com erro</span>
          )}
        </div>
      )}
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

// ─── Fila (admin) ───────────────────────────────────────────────────────────

/**
 * Escreve `_alumen_queue.json` na pasta Copy Utility do Drive. O Apps Script
 * lê esse arquivo no heartbeat e acrescenta os IDs à planilha de controle
 * (PLAN §6.3, alumenMergeQueue). O arquivo NÃO é apagado pelo script: o item
 * sai daqui só depois de aparecer na planilha, para que um heartbeat perdido
 * não perca o pedido.
 */
function QueuePanel({ q }: { q: ReturnType<typeof useQueue> }) {
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  const submit = async () => {
    const id = projectId.trim();
    if (!id || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/drive/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id }),
      });
      const data = await res.json();
      if (!data.ok) setMsg({ tone: 'err', text: data.error ?? 'falhou' });
      else if (data.added) { setMsg({ tone: 'ok', text: `${id.toUpperCase()} enfileirado` }); setProjectId(''); }
      else setMsg({ tone: 'warn', text: `${id.toUpperCase()}: ${data.reason}` });
      await q.reload();
    } catch (err: unknown) {
      setMsg({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const prune = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/drive/queue', { method: 'DELETE' });
      const data = await res.json();
      setMsg(data.ok
        ? { tone: 'ok', text: data.removed ? `${data.removed} confirmado(s) removido(s)` : 'nada a remover' }
        : { tone: 'err', text: data.error ?? 'falhou' });
      await q.reload();
    } finally {
      setBusy(false);
    }
  };

  const hbAge = q.heartbeat
    ? Math.round((Date.now() - new Date(q.heartbeat.at).getTime()) / 60000)
    : null;

  return (
    <div className="p-6 max-w-2xl space-y-5">
      <Section label="Enfileirar projeto">
        <div className="flex gap-2">
          <input
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="PRJ0021863"
            disabled={busy}
            className="flex-1 px-3 py-1.5 rounded border border-line bg-surface-1 text-[13px]
                       text-ink-1 placeholder:text-ink-faint focus:outline-none focus:border-accent-border"
          />
          <button
            onClick={submit}
            disabled={busy || !projectId.trim()}
            className="px-4 py-1.5 rounded text-[12px] font-medium border border-accent-border
                       bg-accent-soft text-accent-text disabled:opacity-40 disabled:cursor-not-allowed
                       cursor-pointer transition-all"
          >
            {busy ? '…' : 'Enfileirar'}
          </button>
        </div>
        {msg && (
          <p className={`mt-2 text-[12px] ${
            msg.tone === 'ok' ? 'text-emerald-400'
            : msg.tone === 'warn' ? 'text-amber-400'
            : 'text-rose-400'}`}>
            {msg.text}
          </p>
        )}
        <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
          O pedido vai para um arquivo no Drive. O Apps Script o lê no próximo
          heartbeat e acrescenta o projeto à planilha de controle — pode levar
          alguns minutos até aparecer na Cadeia.
        </p>
      </Section>

      <Section label="Worker (heartbeat)">
        {q.heartbeat ? (
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`w-1.5 h-1.5 rounded-full ${
              hbAge !== null && hbAge <= 30 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-ink-2">
              {hbAge === null ? '—' : hbAge < 1 ? 'agora há pouco' : `há ${hbAge} min`}
            </span>
            <span className="text-ink-muted">· {q.heartbeat.pending} pendente(s)</span>
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">
            Sem sinal. O gatilho ainda não foi instalado no Apps Script
            (<code className="text-ink-3">alumenInstalarHeartbeat()</code>), ou nunca rodou.
          </p>
        )}
      </Section>

      <Section label={`Aguardando confirmação (${q.queue.length})`}>
        {q.error && <p className="text-[12px] text-rose-400 mb-2">{q.error}</p>}
        {q.queue.length === 0 ? (
          <p className="text-[12px] text-ink-muted">Fila vazia.</p>
        ) : (
          <>
            <ul className="space-y-1">
              {q.queue.map(it => (
                <li key={it.projectId}
                    className="flex items-center justify-between text-[12px] py-1 border-b border-line last:border-0">
                  <span className="font-mono text-ink-1">{it.projectId}</span>
                  <span className="text-ink-muted">
                    {it.requestedBy} · {new Date(it.requestedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
            <button
              onClick={prune}
              disabled={busy}
              className="mt-3 px-3 py-1 rounded text-[11px] border border-line text-ink-3
                         hover:bg-surface-2 disabled:opacity-40 cursor-pointer transition-all"
            >
              Limpar os que já chegaram na planilha
            </button>
          </>
        )}
      </Section>
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
