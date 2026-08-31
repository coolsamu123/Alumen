'use client';

import { useState, useEffect } from 'react';
import type { StageDef } from '../stages';
import type { StromStats } from '../index';
import { getSample } from '../samples';
import SampleBlock from './SampleBlock';

type TabKey = 'overview' | 'inputs' | 'output' | 'code' | 'run' | 'stats';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'inputs',   label: 'Inputs' },
  { key: 'output',   label: 'Output' },
  { key: 'code',     label: 'Code / Prompt' },
  { key: 'run',      label: 'Run' },
  { key: 'stats',    label: 'Stats' },
];

export default function DetailPanel({ stage, stats, onClose }: {
  stage: StageDef;
  stats: StromStats | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState<TabKey>('overview');

  return (
    <aside className="w-[480px] shrink-0 border-l border-line bg-surface-1 flex flex-col h-full">
      <header className="px-5 pt-4 pb-3 border-b border-line shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="text-3xl leading-none">{stage.icon}</span>
            <div className="min-w-0">
              <div className="text-base font-bold text-ink-1 leading-tight">{stage.name}</div>
              {stage.subtitle && <div className="text-xs text-ink-muted mt-0.5">{stage.subtitle}</div>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-muted hover:text-ink-1 text-xl leading-none px-2"
            title="Close"
          >
            ×
          </button>
        </div>
      </header>

      <nav className="flex border-b border-line shrink-0 px-2">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors border-b-2 ${
              active === t.key
                ? 'text-accent-text border-accent-border'
                : 'text-ink-muted border-transparent hover:text-ink-3'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {/* Tabs are rendered as separate modules so each can fetch its own
            data on demand and keep this container thin. */}
        {active === 'overview' && <OverviewTab stage={stage} />}
        {active === 'inputs'   && <InputsTab stage={stage} />}
        {active === 'output'   && <OutputTab stage={stage} />}
        {active === 'code'     && <CodePromptTab stage={stage} />}
        {active === 'run'      && <RunTab stage={stage} />}
        {active === 'stats'    && <StatsTab stage={stage} stats={stats} />}
      </div>
    </aside>
  );
}

// Tab bodies live here for now (move to /panels/*.tsx during Onda B/C/D
// when each gets fleshed out).

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-line/40 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-ink-muted shrink-0 w-24">{label}</span>
      <span className="text-xs text-ink-2 flex-1 break-words">{value}</span>
    </div>
  );
}

function OverviewTab({ stage }: { stage: StageDef }) {
  const d = stage.details;
  return (
    <div className="p-5 space-y-5">
      <p className="text-sm text-ink-2 leading-relaxed font-medium">{stage.blurb}</p>

      <div className="bg-surface-2/40 border border-line rounded-lg p-3 space-y-0.5">
        <Row label="Type" value={<span className="font-mono">{stage.type}</span>} />
        {stage.latency && <Row label="Latency" value={stage.latency} />}
        {stage.source && (
          <Row
            label="Source"
            value={<code className="text-[11px] text-accent-text2 break-all">{stage.source}</code>}
          />
        )}
      </div>

      {d?.whatItDoes && (
        <Section title="What it does">
          <p className="text-sm text-ink-2 leading-relaxed">{d.whatItDoes}</p>
        </Section>
      )}

      {d?.whyItExists && (
        <Section title="Why it exists">
          <p className="text-sm text-ink-2 leading-relaxed">{d.whyItExists}</p>
        </Section>
      )}

      {d?.howItWorks && d.howItWorks.length > 0 && (
        <Section title="How it works">
          <ul className="space-y-1.5">
            {d.howItWorks.map((step, i) => (
              <li key={i} className="text-sm text-ink-2 leading-relaxed flex gap-2.5">
                <span className="text-accent-text2 font-mono text-[10px] mt-1 shrink-0">{(i + 1).toString().padStart(2, '0')}</span>
                <span className="flex-1">{step}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d?.failureModes && d.failureModes.length > 0 && (
        <Section title="Failure modes" tone="warn">
          <ul className="space-y-1.5">
            {d.failureModes.map((f, i) => (
              <li key={i} className="text-sm text-ink-2 leading-relaxed flex gap-2.5">
                <span className="text-amber-400 mt-0.5">⚠</span>
                <span className="flex-1">{f}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d?.relatedStages && d.relatedStages.length > 0 && (
        <Section title="Related stages">
          <div className="flex flex-wrap gap-1.5">
            {d.relatedStages.map(id => (
              <code key={id} className="text-[11px] px-2 py-0.5 rounded bg-surface-2 border border-line text-accent-text2">
                {id}
              </code>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone?: 'warn'; children: React.ReactNode }) {
  const titleColor = tone === 'warn' ? 'text-amber-300' : 'text-ink-1';
  return (
    <div className="space-y-2">
      <h3 className={`text-[11px] font-bold uppercase tracking-wider ${titleColor}`}>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function InputsTab({ stage }: { stage: StageDef }) {
  if (!stage.inputs.length) {
    return (
      <div className="p-5 text-sm text-ink-muted italic">
        This stage takes no parameters — it&apos;s a data store or external source.
      </div>
    );
  }
  return (
    <div className="p-5 space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-muted">{stage.inputs.length} input{stage.inputs.length > 1 ? 's' : ''}</div>
      {stage.inputs.map((inp, i) => (
        <div key={i} className="bg-surface-2/40 border border-line rounded-lg p-3 space-y-1.5">
          <div className="text-sm font-semibold text-ink-1">{inp.name}</div>
          <Row label="Type" value={<code className="text-[11px]">{inp.type}</code>} />
          <Row label="Origin" value={inp.origin} />
          {inp.example && <Row label="Example" value={<code className="text-[11px] text-accent-text2 break-all">{inp.example}</code>} />}
        </div>
      ))}
    </div>
  );
}

function OutputTab({ stage }: { stage: StageDef }) {
  const sample = getSample(stage.outputExampleKey);
  return (
    <div className="p-5 space-y-4">
      <div className="bg-surface-2/40 border border-line rounded-lg p-3">
        <Row label="Schema" value={<code className="text-[11px]">{stage.outputSchema}</code>} />
      </div>
      {sample ? <SampleBlock sample={sample} /> : (
        <p className="text-[11px] text-ink-faint italic">No curated example registered for this stage.</p>
      )}
    </div>
  );
}

function CodePromptTab({ stage }: { stage: StageDef }) {
  if (!stage.promptKey) {
    return (
      <div className="p-5 text-sm text-ink-muted">
        {stage.source
          ? <>Source pointer: <code className="text-accent-text2">{stage.source}</code></>
          : <span className="italic">No editable code/prompt for this stage.</span>}
      </div>
    );
  }
  return <PromptEditor promptKey={stage.promptKey} />;
}

function PromptEditor({ promptKey }: { promptKey: 'goals' | 'impact' | 'deep-dive' }) {
  // Server stores all editable prompts under /api/prompts and keys them by
  // <key>Prompt (goalsPrompt, impactPrompt). Deep-dive prompt isn't currently
  // editable server-side — we surface a placeholder for that case.
  const fieldKey = promptKey === 'goals' ? 'goalsPrompt'
                 : promptKey === 'impact' ? 'impactPrompt'
                 : null;
  const [value, setValue] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!fieldKey) { setLoading(false); return; }
    fetch('/api/prompts').then(r => r.json()).then(d => {
      const v = d[fieldKey] || '';
      setValue(v); setOriginal(v);
    }).finally(() => setLoading(false));
  }, [fieldKey]);

  const handleSave = async () => {
    if (!fieldKey) return;
    setSaving(true); setMsg(null);
    try {
      const current = await fetch('/api/prompts').then(r => r.json());
      const payload = { ...current, [fieldKey]: value };
      const res = await fetch('/api/prompts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('save failed');
      setOriginal(value);
      setMsg('Saved.');
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  if (promptKey === 'deep-dive') {
    return (
      <div className="p-5 text-sm text-ink-muted italic">
        Deep-dive prompt is composed at call time from <code className="text-accent-text2">src/lib/deep-dive-engine.ts:buildPrompt</code>. Not currently exposed as a freely editable template.
      </div>
    );
  }

  if (loading) return <div className="p-5 text-sm text-ink-muted">Loading prompt…</div>;

  const dirty = value !== original;
  return (
    <div className="p-5 space-y-3 flex flex-col h-full">
      <div className="text-[11px] uppercase tracking-wider text-ink-muted">
        Active prompt — {promptKey} · Gemini 2.0 Flash
      </div>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        className="flex-1 min-h-[300px] w-full bg-surface-deep text-ink-2 font-mono text-[11px] p-3 rounded border border-line focus:border-accent-border focus:outline-none resize-y"
        spellCheck={false}
      />
      <div className="flex items-center justify-between text-[11px] text-ink-muted">
        <span>{dirty ? 'Unsaved changes' : 'In sync with server'}</span>
        <div className="flex items-center gap-2">
          {msg && <span className="text-emerald-400">{msg}</span>}
          {dirty && (
            <button
              onClick={() => setValue(original)}
              className="px-2 py-1 rounded text-ink-3 hover:bg-surface-2 border border-line-strong"
            >
              Reset
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-3 py-1 rounded bg-accent-hover text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunTab({ stage }: { stage: StageDef }) {
  if (!stage.trigger) {
    return <div className="p-5 text-sm text-ink-muted italic">This stage isn&apos;t user-triggerable — it runs as part of the pipeline.</div>;
  }
  return <TriggerForm stage={stage} />;
}

function TriggerForm({ stage }: { stage: StageDef }) {
  const trigger = stage.trigger!;
  const [body, setBody] = useState(() => trigger.body ? JSON.stringify(trigger.body, null, 2) : '');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const handleRun = async () => {
    setRunning(true); setResult(null);
    try {
      const opts: RequestInit = { method: trigger.method };
      if (body.trim()) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = body;
      }
      const res = await fetch(trigger.url, opts);
      const text = await res.text();
      setResult({ ok: res.ok, text });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'unknown error' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-5 space-y-3">
      <div className="bg-surface-2/40 border border-line rounded-lg p-3 space-y-1.5">
        <Row label="Method" value={<code className="text-[11px]">{trigger.method}</code>} />
        <Row label="URL" value={<code className="text-[11px] text-accent-text2">{trigger.url}</code>} />
        {trigger.note && <Row label="Note" value={<span className="italic">{trigger.note}</span>} />}
      </div>
      {trigger.body && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">Request body (editable)</div>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            className="w-full min-h-[100px] bg-surface-deep text-ink-2 font-mono text-[11px] p-2.5 rounded border border-line focus:border-accent-border focus:outline-none"
            spellCheck={false}
          />
        </div>
      )}
      <button
        onClick={handleRun}
        disabled={running}
        className="w-full px-4 py-2 rounded bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {running ? 'Calling…' : `▶ ${trigger.label}`}
      </button>
      {result && (
        <div className={`border rounded-lg p-3 ${result.ok ? 'border-emerald-700/40 bg-emerald-950/30' : 'border-red-700/40 bg-red-950/30'}`}>
          <div className={`text-[10px] uppercase tracking-wider font-bold mb-1 ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {result.ok ? 'OK' : 'Error'}
          </div>
          <pre className="text-[11px] text-ink-2 whitespace-pre-wrap font-mono break-words">
{result.text.slice(0, 2000)}{result.text.length > 2000 ? '…' : ''}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatsTab({ stage, stats }: { stage: StageDef; stats: StromStats | null }) {
  if (!stats) {
    return <div className="p-5 text-sm text-ink-muted italic">Loading…</div>;
  }
  // Pick a subset of stats relevant to each stage. Adding more stages =
  // adding a case here.
  const cards: { label: string; value: string | number; hint?: string }[] = [];
  switch (stage.id) {
    case 'store-projects':
      cards.push({ label: 'Total rows', value: stats.projects });
      break;
    case 'store-docs':
    case 's2-download':
    case 's3-hygiene':
    case 's4-extract':
      cards.push({ label: 'Success', value: stats.documents.success });
      cards.push({ label: 'Skipped (hygiene)', value: stats.documents.skipped });
      cards.push({ label: 'Errors', value: stats.documents.error });
      cards.push({ label: 'Total', value: stats.documents.total });
      break;
    case 'store-goals':
    case 's5-goals-llm':
    case 's6-sanitize':
      cards.push({ label: 'Success rows', value: stats.goals.success });
      cards.push({ label: 'At v4 prompt', value: stats.goals.v4, hint: 'v4 = Onda 3 schema (impact_claims, etc.)' });
      break;
    case 'store-impacts':
    case 's7-impact-llm':
    case 's9-universe':
      cards.push({ label: 'Impact rows', value: stats.impacts.total });
      cards.push({ label: 'With LLM citations', value: `${stats.impacts.withCitations} (${pct(stats.impacts.withCitations, stats.impacts.total)}%)` });
      cards.push({ label: 'With evidence_chain', value: `${stats.impacts.withChain} (${pct(stats.impacts.withChain, stats.impacts.total)}%)`, hint: 'evidence_chain = Onda 4 trace back to source claim.' });
      break;
    case 's8-deepdive':
    case 'store-deepdives':
      cards.push({ label: 'Cached dives', value: stats.deepDives, hint: 'Cascade-invalidated by clearAllImpacts.' });
      break;
    default:
      cards.push({ label: 'No stage-specific stats', value: '—', hint: 'This step is stateless or external; nothing in the DB to count.' });
  }
  return (
    <div className="p-5 space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-muted">Live numbers · polled every 30s</div>
      <div className="grid grid-cols-2 gap-2">
        {cards.map((c, i) => (
          <div key={i} className="bg-surface-2/40 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-ink-muted">{c.label}</div>
            <div className="text-base font-mono font-bold text-ink-1 mt-0.5">{c.value}</div>
            {c.hint && <div className="text-[10px] text-ink-faint mt-1 italic">{c.hint}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function pct(num: number, den: number): string {
  if (!den) return '0.0';
  return (100 * num / den).toFixed(1);
}
