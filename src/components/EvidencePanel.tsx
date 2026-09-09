'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { getDDSColor, ADMIN_ONLY_TITLE } from '@/lib/constants';
import { useProjectContext } from '@/context/ProjectContext';
import { SourcePopover, type SourceRef } from './SourcePopover';

// ─── Data shapes (mirror /api/impact/project/evidence response) ──────────────

interface ProjectMeta {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  decision: string;
  decisionMode: string;
  description: string;
  remarks: string;
  qa: string;
  costKEur: number | null;
  reviewDate: string;
  participants: string;
  links: { folder: string; positions: string; cioo: string };
  history: Array<{ gate: string; decision: string; reviewDate: string }>;
}

interface GoalsData {
  digitalTechnologies: string;
  changeManagement: string;
  securityImpacts: string;
  regionalImpacts: string;
  iaEmbedded: string;
  gioSlDdsImpacts: string;
  ddsGioWorkload: string;
  businessAppsCis: string;
  region: string;
  monthFolder: string;
  analyzedAt: string;
  sourceFiles: string[];
  rawGeminiResponse: string;
  status: string;
}

interface DocumentExcerpt {
  url: string;
  contentType: string;
  fetchStatus: string;
  excerpt: string;
  fullLength: number;
}

interface EvidenceResponse {
  project: ProjectMeta;
  goals: GoalsData | null;
  documents: DocumentExcerpt[];
  impacts: { gio: unknown; dds: unknown };
}

type DeepDiveKind = 'gio' | 'dds';

export interface DeepDiveTarget {
  kind: DeepDiveKind;
  target: string;
}

interface EvidencePanelProps {
  projectId: string;
  // Highlights the field most directly tied to a kind of impact (subtle visual tag).
  highlight?: 'gio' | 'dds' | null;
  // Compact = thinner padding + smaller fonts. Use in the Universe side panel.
  compact?: boolean;
  // List of deep-dive targets to expose buttons for. Empty/omitted = no deep-dive section.
  deepDiveTargets?: DeepDiveTarget[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EvidencePanel({ projectId, highlight = null, compact = false, deepDiveTargets = [] }: EvidencePanelProps) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDocUrl, setOpenDocUrl] = useState<string | null>(null);

  // Set of "<kind>:<target>" keys that already have a cached deep-dive on the
  // server. Used to enable the per-button "Regenerate" affordance without each
  // button having to probe independently.
  const [cachedDeepDives, setCachedDeepDives] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/impact/project/evidence?projectId=${encodeURIComponent(projectId)}`)
      .then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || 'Failed to load evidence');
        return json as EvidenceResponse;
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [projectId]);

  // Probe the deep-dive cache once per project. Cheap GET, no LLM call.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/impact/project/deep-dive?projectId=${encodeURIComponent(projectId)}`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then((json: { items?: Array<{ kind: string; target: string }> }) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const it of json.items || []) set.add(`${it.kind}:${it.target}`);
        setCachedDeepDives(set);
      })
      .catch(() => { /* probe failure is non-fatal; button just stays disabled */ });
    return () => { cancelled = true; };
  }, [projectId]);

  const padCls = compact ? 'p-3' : 'p-4';
  const titleCls = compact ? 'text-[11px]' : 'text-xs';
  const bodyCls = compact ? 'text-[11px]' : 'text-xs';

  if (loading) {
    return (
      <div className={`bg-surface-1/70 border border-line rounded-lg ${padCls} text-ink-muted text-xs animate-pulse`}>
        Loading evidence…
      </div>
    );
  }
  if (error) {
    return (
      <div className={`bg-red-950/30 border border-red-900/50 rounded-lg ${padCls} text-red-400 text-xs`}>
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { project, goals, documents } = data;

  return (
    <div className={`bg-surface-1/40 border border-line rounded-lg ${padCls} space-y-4`}>
      {/* ─── Project metadata ──────────────────────────────────────────── */}
      <Section title="Project metadata" titleCls={titleCls}>
        <dl className={`grid grid-cols-2 gap-x-4 gap-y-1 ${bodyCls} text-ink-3`}>
          <Field label="DDS owner" value={project.dds} color={getDDSColor(project.dds)} />
          <Field label="Current gate" value={project.currentGate} />
          <Field label="Decision" value={`${project.decision}${project.decisionMode ? ` (${project.decisionMode})` : ''}`} />
          <Field label="Cost" value={project.costKEur !== null ? `${project.costKEur} k€` : '—'} />
          <Field label="Last review" value={project.reviewDate} />
          <Field label="Participants" value={project.participants} truncate />
        </dl>
        {(project.links.folder || project.links.positions || project.links.cioo) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {project.links.folder && <ExtLink href={project.links.folder} label="Drive folder" />}
            {project.links.positions && <ExtLink href={project.links.positions} label="Positions" />}
            {project.links.cioo && <ExtLink href={project.links.cioo} label="CIOO" />}
          </div>
        )}
      </Section>

      {/* ─── Description / Remarks ─────────────────────────────────────── */}
      {(project.description || project.remarks || project.qa) && (
        <Section title="CIOO sheet text" titleCls={titleCls}>
          {project.description && (
            <Para label="Description" body={project.description} bodyCls={bodyCls} />
          )}
          {project.remarks && (
            <Para label="Remarks" body={project.remarks} bodyCls={bodyCls} />
          )}
          {project.qa && (
            <Para label="QA" body={project.qa} bodyCls={bodyCls} />
          )}
        </Section>
      )}

      {/* ─── Goals Extractor fields ────────────────────────────────────── */}
      {goals ? (
        <Section
          title={`Goals Extractor · ${goals.region || 'Global'} · analyzed ${formatDate(goals.analyzedAt)}`}
          titleCls={titleCls}
        >
          <div className="space-y-2">
            <GoalsField label="GIO / SL / DDS impacts"  text={goals.gioSlDdsImpacts}  bodyCls={bodyCls} highlighted={highlight === 'gio' || highlight === 'dds'} />
            <GoalsField label="Regional impacts"        text={goals.regionalImpacts}  bodyCls={bodyCls} highlighted={highlight === 'dds'} />
            <GoalsField label="DDS / GIO workload"      text={goals.ddsGioWorkload}   bodyCls={bodyCls} highlighted={highlight === 'gio' || highlight === 'dds'} />
            <GoalsField label="Digital technologies"    text={goals.digitalTechnologies} bodyCls={bodyCls} />
            <GoalsField label="Business apps & CIs"     text={goals.businessAppsCis}  bodyCls={bodyCls} />
            <GoalsField label="Security impacts"        text={goals.securityImpacts}  bodyCls={bodyCls} />
            <GoalsField label="AI embedded"             text={goals.iaEmbedded}       bodyCls={bodyCls} />
            <GoalsField label="Change management"       text={goals.changeManagement} bodyCls={bodyCls} />
          </div>
          {goals.sourceFiles.length > 0 && (
            <div className="mt-3 pt-3 border-t border-line">
              <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1.5">
                Source files used by Goals analysis ({goals.sourceFiles.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {goals.sourceFiles.map(f => (
                  <span key={f} className="text-[10px] font-mono bg-surface-2/60 text-ink-4 px-1.5 py-0.5 rounded border border-line-strong/60">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Section>
      ) : (
        <Section title="Goals Extractor" titleCls={titleCls}>
          <div className={`${bodyCls} text-ink-muted italic`}>
            No Goals analysis on record for this project.
          </div>
        </Section>
      )}

      {/* ─── Documents ─────────────────────────────────────────────────── */}
      {documents.length > 0 && (
        <Section title={`Drive documents (${documents.length})`} titleCls={titleCls}>
          <ul className="space-y-1.5">
            {documents.map(doc => {
              const filename = doc.url.split('/').pop() || doc.url;
              const opened = openDocUrl === doc.url;
              return (
                <li key={doc.url}>
                  <button
                    onClick={() => setOpenDocUrl(opened ? null : doc.url)}
                    className={`w-full text-left px-2 py-1 rounded ${bodyCls} hover:bg-surface-2/50 transition-colors flex items-center gap-2`}
                  >
                    <span className="text-ink-4">{opened ? '▾' : '▸'}</span>
                    <span className="font-mono text-ink-3 truncate flex-1" title={doc.url}>{filename}</span>
                    <span className="text-[10px] text-ink-muted shrink-0">
                      {doc.fetchStatus === 'success' ? `${doc.fullLength} chars` : doc.fetchStatus}
                    </span>
                  </button>
                  {opened && doc.excerpt && (
                    <pre className={`mt-1 ml-5 ${bodyCls} text-ink-4 bg-surface-deep/60 border border-line rounded px-2 py-1.5 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto`}>
                      {doc.excerpt}
                      {doc.fullLength > doc.excerpt.length && '\n…'}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* ─── Gate history ──────────────────────────────────────────────── */}
      {project.history.length > 1 && (
        <Section title={`Gate history (${project.history.length} reviews)`} titleCls={titleCls}>
          <ul className={`${bodyCls} text-ink-3 space-y-1`}>
            {project.history.map((h, i) => (
              <li key={i} className="flex gap-3 font-mono">
                <span className="text-ink-muted shrink-0 w-24">{h.reviewDate || '—'}</span>
                <span className="text-accent-text shrink-0 w-12">Gate {h.gate || '—'}</span>
                <span className="text-emerald-300">{h.decision || '—'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ─── Deep dive (LLM-generated detailed analysis) ─────────────────── */}
      {deepDiveTargets.length > 0 && (
        <Section title="Deep dive analyses (AI)" titleCls={titleCls}>
          <div className={`${bodyCls} text-ink-muted mb-2`}>
            Generate or read a detailed, evidence-backed analysis for each connection.
          </div>
          <div className="space-y-2">
            {deepDiveTargets.map(t => (
              <DeepDiveButton
                key={`${t.kind}:${t.target}`}
                projectId={projectId}
                kind={t.kind}
                target={t.target}
                compact={compact}
                hasCachedResult={cachedDeepDives.has(`${t.kind}:${t.target}`)}
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Deep dive button (lazy-loads, caches via backend) ───────────────────────

interface DeepDiveSource {
  id: number;
  doc_url: string;
  file_name: string;
  snippet: string;
}

interface DeepDiveResponse {
  projectId: string;
  kind: DeepDiveKind;
  target: string;
  responseMd: string;
  sources: DeepDiveSource[];
  llmProvider: string;
  llmModel: string;
  generatedAt: string;
  durationMs: number | null;
  cached: boolean;
}

export function DeepDiveButton({ projectId, kind, target, compact, hasCachedResult = false }: { projectId: string; kind: DeepDiveKind; target: string; compact: boolean; hasCachedResult?: boolean }) {
  const { isAdmin } = useProjectContext();
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [response, setResponse] = useState<DeepDiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Tracks whether a cached deep-dive is known to exist server-side.
  // Initialised from the parent probe, flips to true after any successful run.
  const [cacheExists, setCacheExists] = useState(hasCachedResult);

  // Reflect probe updates from the parent (e.g. project switch).
  useEffect(() => { setCacheExists(hasCachedResult); }, [hasCachedResult]);

  // Tick a loading timer so the user has visual progress on the long LLM call.
  useEffect(() => {
    if (state !== 'loading') return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [state]);

  const runFetch = useCallback(async (force: boolean) => {
    setState('loading');
    setError(null);
    setOpen(true);
    setElapsed(0);
    try {
      const res = await fetch('/api/impact/project/deep-dive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, kind, target, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deep dive failed');
      setResponse(data as DeepDiveResponse);
      setState('done');
      setCacheExists(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setState('error');
    }
  }, [projectId, kind, target]);

  const trigger = useCallback(async () => {
    if (state === 'loading') return;
    if (state === 'done' && response) {
      setOpen(o => !o);
      return;
    }
    await runFetch(false);
  }, [state, response, runFetch]);

  const regenerate = useCallback(async () => {
    if (state === 'loading') return;
    if (!cacheExists) return;  // Disabled until a cached row is known to exist.
    await runFetch(true);
  }, [state, cacheExists, runFetch]);

  const kindLabel = kind === 'gio' ? 'GIO' : 'DDS';

  // Visual state of the trigger button. Each state gets distinct colors and
  // motion so the LLM call feels intentional, not buried.
  const triggerBg =
    state === 'idle'    ? 'bg-gradient-to-r from-purple-700 via-fuchsia-600 to-cyan-600 hover:from-purple-600 hover:via-fuchsia-500 hover:to-cyan-500' :
    state === 'loading' ? 'bg-gradient-to-r from-purple-800 via-fuchsia-700 to-cyan-700 animate-pulse' :
    state === 'done'    ? 'bg-gradient-to-r from-emerald-700/60 to-emerald-800/60 hover:from-emerald-600/60 hover:to-emerald-700/60' :
                          'bg-gradient-to-r from-red-800/70 to-red-900/70 hover:from-red-700/70 hover:to-red-800/70';
  const triggerGlow =
    state === 'idle'    ? 'shadow-[0_0_18px_rgba(168,85,247,0.45)] hover:shadow-[0_0_24px_rgba(168,85,247,0.7)]' :
    state === 'loading' ? 'shadow-[0_0_18px_rgba(168,85,247,0.45)]' :
    '';

  return (
    <div className="rounded-lg overflow-hidden">
      {/* Admin-only: /api/impact/project/deep-dive is POST-only — it serves
          the cached result and generates a missing one through the same
          endpoint, so there's no read-only path to split off here. The
          consequence is that a basic user can't view an already-cached deep
          dive either; splitting the endpoint into GET (cached) + POST
          (generate) is the follow-up that would fix that. */}
      <button
        onClick={trigger}
        disabled={!isAdmin || state === 'loading'}
        title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
        className={`group w-full flex items-center justify-between gap-3 px-4 py-3 ${compact ? 'text-[12px]' : 'text-[13px]'} font-semibold text-white transition-all duration-200 disabled:cursor-wait disabled:opacity-40 ${triggerBg} ${triggerGlow}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-base shrink-0 inline-block group-hover:scale-110 transition-transform">🔬</span>
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 tracking-wider bg-black/30 text-white/95 border border-white/20"
          >
            {kindLabel}
          </span>
          <span className="truncate text-white/95 font-bold" title={target}>{target}</span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/85 font-bold">
          {state === 'idle' && 'Deep dive →'}
          {state === 'loading' && `${elapsed}s …`}
          {state === 'done' && (response?.cached ? '✓ Cached · toggle' : '✓ Done · toggle')}
          {state === 'error' && '⚠ Retry'}
        </span>
      </button>

      {/* Regenerate row — visible always, enabled only when a cached row is
          known to exist server-side (initial probe) or has been created in
          this session by a successful run. */}
      <div className="flex justify-end px-2 py-1 bg-surface-deep/40 border-x border-b border-line/40">
        <button
          type="button"
          onClick={regenerate}
          disabled={!isAdmin || !cacheExists || state === 'loading'}
          title={
            !isAdmin
              ? ADMIN_ONLY_TITLE
              : !cacheExists
                ? 'Regenerate will be enabled once a deep dive has been generated and cached.'
                : 'Force a fresh LLM run and overwrite the cached result.'
          }
          className={`text-[10px] font-bold uppercase tracking-wider transition-colors ${
            !isAdmin || !cacheExists || state === 'loading'
              ? 'text-ink-muted/60 cursor-not-allowed'
              : 'text-fuchsia-300 hover:text-fuchsia-200 cursor-pointer'
          }`}
        >
          ↻ Regenerate
        </button>
      </div>

      {open && (
        <div className="bg-surface-deep/70 border border-t-0 border-line rounded-b-lg px-3 py-2.5">
          {state === 'loading' && (
            <div className={`${compact ? 'text-[11px]' : 'text-xs'} text-ink-4 leading-relaxed`}>
              Generating detailed analysis (typical: 15-40s)…
            </div>
          )}
          {state === 'error' && (
            <div className="text-xs text-red-400">{error}</div>
          )}
          {state === 'done' && response && (
            <>
              <DeepDiveBody response={response} compact={compact} />
              <div className="text-[10px] text-ink-muted mt-3 pt-2 border-t border-line font-mono">
                {response.llmProvider}/{response.llmModel} · {response.durationMs ? `${(response.durationMs / 1000).toFixed(1)}s` : '—'} · generated {response.generatedAt.slice(0, 10)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Deep dive body: section-by-section render with per-section popovers ────

interface DeepDiveSection {
  title: string;       // raw heading text without the leading "## "
  body: string;        // markdown body with the `_Sources: [n]_` line stripped
  sourceIds: number[]; // ids referenced by the section's _Sources: [n,...]_ line
}

// Splits a deep-dive response by `## ` headings, extracts each section's
// trailing `_Sources: [n, n, ...]_` line, and strips that line out of the
// body so it isn't rendered as raw text. The "## Sources" section itself is
// dropped — the source list is rendered separately as popovers, not as a
// trailing markdown list.
function splitDeepDiveSections(markdown: string): DeepDiveSection[] {
  const sections: DeepDiveSection[] = [];
  // Split on lines that begin with "## " (preserve order). The first chunk
  // (before any heading) is rare but possible — skip it to avoid blank cards.
  const parts = markdown.split(/^##\s+/m);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const newlineAt = chunk.indexOf('\n');
    const title = (newlineAt === -1 ? chunk : chunk.slice(0, newlineAt)).trim();
    let body = newlineAt === -1 ? '' : chunk.slice(newlineAt + 1);
    if (title.toLowerCase() === 'sources') continue;

    // Match `_Sources: [n, n, ...]_`. Tolerant on whitespace and trailing
    // punctuation; the LLM sometimes wraps it in extra markdown emphasis.
    const sourceLineRe = /_+\s*Sources:\s*\[([^\]]*)\]\s*_+/i;
    const m = body.match(sourceLineRe);
    const sourceIds: number[] = [];
    if (m) {
      const nums = m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      sourceIds.push(...nums);
      body = body.replace(sourceLineRe, '').trimEnd();
    }
    sections.push({ title, body: body.trim(), sourceIds });
  }
  return sections;
}

function DeepDiveBody({ response, compact }: { response: DeepDiveResponse; compact: boolean }) {
  const sections = useMemo(() => splitDeepDiveSections(response.responseMd), [response.responseMd]);
  const sourceById = useMemo(() => {
    const m = new Map<number, DeepDiveSource>();
    for (const s of response.sources) m.set(s.id, s);
    return m;
  }, [response.sources]);

  // Fallback: if the model skipped the `## ` structure entirely (older cached
  // responses or a malformed run), fall back to the original single-blob render.
  if (sections.length === 0) {
    return (
      <div className={`prose-deep-dive ${compact ? 'text-[11px]' : 'text-xs'} text-ink-2 leading-relaxed`}>
        <ReactMarkdown components={deepDiveMarkdownComponents}>
          {response.responseMd}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className={`prose-deep-dive ${compact ? 'text-[11px]' : 'text-xs'} text-ink-2 leading-relaxed`}>
      {sections.map((sec, i) => {
        const refs: SourceRef[] = sec.sourceIds
          .map(id => sourceById.get(id))
          .filter((s): s is DeepDiveSource => Boolean(s))
          .map(s => ({ doc_url: s.doc_url, file_name: s.file_name, snippet: s.snippet }));
        return (
          <div key={i} className="mt-3 first:mt-0">
            <div className="flex items-center text-[11px] font-bold text-ink-1 uppercase tracking-wider mb-1.5">
              <span>{sec.title}</span>
              {refs.length > 0 && <SourcePopover sources={refs} label={`Sources for "${sec.title}"`} />}
            </div>
            <ReactMarkdown components={deepDiveMarkdownComponents}>{sec.body}</ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}

const deepDiveMarkdownComponents = {
  h2: ({ children }: { children?: React.ReactNode }) => (
    <div className="text-[11px] font-bold text-ink-1 uppercase tracking-wider mt-3 mb-1.5 first:mt-0">{children}</div>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <div className="text-[11px] font-semibold text-ink-2 mt-2 mb-1">{children}</div>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 space-y-0.5 mb-2">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 space-y-0.5 mb-2">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="text-ink-1">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="text-ink-3">{children}</em>,
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono bg-surface-2/70 text-emerald-300 px-1 rounded">{children}</code>
  ),
};

// ─── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children, titleCls }: { title: string; children: React.ReactNode; titleCls: string }) {
  return (
    <div>
      <div className={`${titleCls} font-bold text-ink-2 uppercase tracking-wider mb-2`}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, color, truncate }: { label: string; value: string; color?: string; truncate?: boolean }) {
  return (
    <div className="flex gap-1.5 min-w-0">
      <dt className="text-ink-muted shrink-0">{label}:</dt>
      <dd className={`text-ink-2 ${truncate ? 'truncate' : ''}`} style={color ? { color } : undefined} title={value}>
        {value || '—'}
      </dd>
    </div>
  );
}

function Para({ label, body, bodyCls }: { label: string; body: string; bodyCls: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-0.5">{label}</div>
      <div className={`${bodyCls} text-ink-3 leading-relaxed whitespace-pre-wrap`}>{body}</div>
    </div>
  );
}

function GoalsField({ label, text, bodyCls, highlighted }: { label: string; text: string; bodyCls: string; highlighted?: boolean }) {
  if (!text || text === 'Not identified in available documentation') {
    return (
      <div className={`flex gap-3 ${bodyCls}`}>
        <span className="text-ink-muted w-44 shrink-0">{label}</span>
        <span className="text-ink-faint italic">Not identified</span>
      </div>
    );
  }
  return (
    <div className={`${bodyCls} ${highlighted ? 'bg-accent-soft border-l-2 border-accent-border/60 pl-2 py-1 rounded-r' : ''}`}>
      <span className="text-ink-muted mr-2">{label}:</span>
      <span className="text-ink-2 leading-relaxed whitespace-pre-wrap">{text}</span>
    </div>
  );
}

function ExtLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="text-[10px] px-2 py-0.5 rounded bg-accent-soft text-accent-text border border-accent-border/50 hover:bg-accent-soft transition-colors"
    >
      ↗ {label}
    </a>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}
