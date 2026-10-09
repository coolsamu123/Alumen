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
  request: 'Pedido',
  copy: 'Cópia',
  cleanup: 'Limpeza',
  discover: 'Descoberta',
  download: 'Download',
  goals: 'Goals',
  impact: 'Impacto',
};
const STAGE_WHO: Record<StageKey, string> = {
  request: 'Alumen pede a cópia ao Apps Script',
  copy: 'Apps Script copia os documentos para a pasta base',
  cleanup: 'Apps Script remove duplicados e o rótulo de classificação',
  discover: 'Alumen encontra a pasta PRJ na pasta base',
  download: 'Alumen baixa os arquivos',
  goals: 'Gemini extrai os campos de governança',
  impact: 'Gemini calcula as relações com os outros projetos',
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
  excel: { label: 'CDIO', title: 'Da planilha CDIO', className: 'bg-surface-2 text-ink-4' },
  drive: { label: 'Drive', title: 'Pasta PRJ encontrada no Drive, sem linha na planilha CDIO', className: 'bg-blue-900/40 text-blue-300' },
  initiative: { label: 'Iniciativa', title: 'Pasta sem projeto CDIO', className: 'bg-amber-900/40 text-amber-300' },
  manual: { label: 'Avulso', title: 'Adicionado à mão por número; vira CDIO quando a planilha o listar', className: 'bg-teal-900/40 text-teal-300' },
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
  if (!at) return { text: 'sem sinal', ok: false };
  const min = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  return { text: min <= 0 ? 'agora' : `há ${min} min`, ok: min <= 20 };
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
      if (!d.ok) throw new Error(d.error || 'Falha ao carregar');
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

  const post = async (body: object): Promise<{ added: string[]; skipped: { projectId: string; reason: string }[] }> => {
    const res = await fetch('/api/drive/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Falhou');
    return d;
  };

  const loadOne = async (projectId: string) => {
    setBusy(projectId);
    try {
      const r = await post({ action: 'load', projectIds: [projectId] });
      onToast(r.added.length ? 'success' : 'info',
        r.added.length ? `${projectId}: cópia pedida ao Apps Script.` : `${projectId}: ${r.skipped[0]?.reason ?? 'nada a fazer'}.`);
      load();
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const loadNew = async () => {
    if (!data?.newFromCdio) return;
    if (!window.confirm(`Carregar ${data.newFromCdio} projeto(s) novos do CDIO? Cada um passa por cópia, limpeza e consome chamadas ao Gemini.`)) return;
    setBusy('__all__');
    try {
      const r = await post({ action: 'load-new-cdio' });
      onToast('success', `${r.added.length} projeto(s) pedidos ao Apps Script.`);
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
      if (res.status === 409) { onToast('info', 'Outra sincronização já está rodando.'); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falhou');
      onToast('info', `Baixando de novo os arquivos de ${projectId}…`);
    } catch (err: unknown) {
      onToast('error', err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const removeManual = async (projectId: string) => {
    if (!window.confirm(`Remover o projeto avulso ${projectId}, com seus goals e impactos?`)) return;
    setBusy(projectId);
    try {
      const res = await fetch(`/api/drive/projects/manual?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Falhou');
      onToast('success', `${projectId} removido.`);
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
          <div className="text-sm font-semibold text-ink-2">Cadeia ao vivo</div>
          <span className={`text-[11px] px-2 py-0.5 rounded ${hb.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}
            title="Último sinal do Apps Script (gatilho de 10 em 10 minutos)">
            Apps Script: {hb.text}
          </span>
          {data && data.queueSize > 0 && <span className="text-[11px] text-ink-muted">{data.queueSize} na fila</span>}
          {data?.cycle && data.cycle !== 'idle' && (
            <span className="text-[11px] text-accent-text">ciclo em andamento: {data.cycle}</span>
          )}
          {data?.queueError && <span className="text-[11px] text-red-400" title={data.queueError}>fila ilegível</span>}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {chain.map((c, i) => {
            const activeSel = stageFilter?.stage === c.stage;
            return (
              <div key={c.stage} className="relative">
                <button
                  onClick={() => setStageFilter(activeSel && stageFilter?.kind === 'active' ? null : { stage: c.stage, kind: 'active' })}
                  title={`${STAGE_WHO[c.stage]} — clique para ver os projetos nesta etapa`}
                  className={`w-full rounded-lg border px-2 py-2 text-left transition-colors ${
                    activeSel ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2/40 hover:bg-surface-2'}`}
                >
                  <div className="text-[11px] text-ink-muted">{i + 1}. {STAGE_LABEL[c.stage]}</div>
                  <div className="font-mono text-base text-ink-1">{c.active}</div>
                  <div className="text-[10px] text-ink-faint">{c.done} feitos</div>
                </button>
                {c.error > 0 && (
                  <button
                    onClick={() => setStageFilter({ stage: c.stage, kind: 'error' })}
                    className="absolute top-1 right-1 text-[10px] px-1.5 rounded bg-red-900/60 text-red-200"
                    title="Ver os projetos com erro nesta etapa"
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
          <div className="text-sm font-semibold text-ink-2">+ Adicionar projeto</div>
          <div className="text-[11px] text-ink-muted">Por número PRJ, esteja ou não no CDIO</div>
          <div className="flex-1" />
          <button
            onClick={loadNew}
            disabled={!data?.newFromCdio || busy !== null}
            className={`px-4 py-1.5 rounded-lg border border-accent-border text-accent-text text-sm font-semibold ${
              !data?.newFromCdio || busy !== null ? 'opacity-40' : 'hover:bg-accent-soft'}`}
            title="Pede ao Apps Script a cópia de todos os projetos do CDIO que ainda não foram carregados"
          >
            {busy === '__all__' ? 'Pedindo…' : `Carregar novos do CDIO (${data?.newFromCdio ?? 0})`}
          </button>
        </div>
        {addProject}
      </div>

      {/* Table */}
      <div className="bg-surface-1 border border-line rounded-xl">
        <div className="px-5 py-3 flex items-center gap-2 flex-wrap border-b border-line">
          <div className="text-sm font-semibold text-ink-2">Projetos</div>
          <div className="text-[11px] text-ink-muted mr-2">{visible.length} / {rows.length}</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="PRJ ou nome…" className={`${sel} w-44`} />
          <select value={source} onChange={e => setSource(e.target.value as typeof source)} className={sel}>
            <option value="any">Origem: todas</option>
            <option value="excel">CDIO</option>
            <option value="manual">Avulso</option>
            <option value="drive">Drive</option>
          </select>
          <select value={period} onChange={e => setPeriod(e.target.value)} className={sel}>
            <option value="any">Período: todos</option>
            {periods.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={gate} onChange={e => setGate(e.target.value)} className={sel}>
            <option value="any">Gate: todos</option>
            {gates.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={dds} onChange={e => setDds(e.target.value)} className={sel}>
            <option value="any">DDS: todos</option>
            {ddsList.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <label className="text-xs text-ink-3 flex items-center gap-1">
            <input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} /> só erro
          </label>
          {stageFilter && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-accent-soft text-accent-text">
              {STAGE_LABEL[stageFilter.stage]}: {stageFilter.kind === 'error' ? 'com erro' : 'em andamento'}
            </span>
          )}
          {filtersOn && (
            <button onClick={() => { setQ(''); setSource('any'); setPeriod('any'); setGate('any'); setDds('any'); setOnlyErrors(false); setStageFilter(null); }}
              className="text-[11px] text-ink-muted hover:text-ink-2 underline">limpar filtros</button>
          )}
        </div>
        {loadError && <div className="px-5 py-2 text-xs text-red-400">{loadError}</div>}
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-1 z-10">
              <tr className="text-ink-muted border-b border-line">
                <th className="px-3 py-2 text-left font-semibold">PRJ</th>
                <th className="px-2 py-2 text-left font-semibold">Nome</th>
                <th className="px-2 py-2 text-left font-semibold">Origem</th>
                <th className="px-2 py-2 text-left font-semibold">Período</th>
                {STAGES.map(s => (
                  <th key={s} className="px-1.5 py-2 text-center font-semibold" title={STAGE_WHO[s]}>{STAGE_LABEL[s]}</th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Ação</th>
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
                            title={`Não está mais na planilha CDIO desde ${r.cdioMissingSince}. Mantido: goals e impactos continuam valendo.`}>
                            fora do CDIO
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-ink-4 whitespace-nowrap">{r.period || '—'}</td>
                      {STAGES.map(s => (
                        <td key={s} className="px-1.5 py-1.5 text-center">
                          {r.stages[s] === 'error' ? (
                            <button onClick={() => setOpenError(isOpen ? null : r.projectId)} title={r.errors[s] || 'erro'}>
                              <StageIcon state="error" title={r.errors[s] || 'erro'} />
                            </button>
                          ) : (
                            <StageIcon state={r.stages[s]} title={`${STAGE_LABEL[s]}: ${r.stages[s]}`
                              + (s === 'download' && r.filesDownloaded ? ` (${r.filesDownloaded} arquivos)` : '')
                              + (s === 'impact' && r.impactCount ? ` (${r.impactCount} relações)` : '')} />
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-2">
                        {r.loadable && (
                          <button onClick={() => loadOne(r.projectId)} disabled={busy !== null}
                            className="px-2 py-0.5 rounded bg-accent-hover text-white text-[11px] font-semibold disabled:opacity-40 hover:bg-accent">
                            {busy === r.projectId ? '…' : 'Carregar'}
                          </button>
                        )}
                        {!r.loadable && downloadFailed && r.linkFolder && (
                          <button onClick={() => resync(r.projectId)} disabled={busy !== null}
                            className="text-ink-muted hover:text-ink-2 disabled:opacity-40" title="Baixar de novo os arquivos deste projeto">↻</button>
                        )}
                        {r.source === 'manual' && (
                          <button onClick={() => removeManual(r.projectId)} disabled={busy !== null}
                            className="text-ink-muted hover:text-red-400 disabled:opacity-40" title="Remover este projeto avulso">🗑</button>
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
                  {data ? 'Nenhum projeto com esses filtros.' : 'Carregando…'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-2 border-t border-line text-[11px] text-ink-muted">
          ✓ feito · ● em andamento · ✗ erro (clique para ver) · · aguardando a etapa anterior · – não pedido
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
