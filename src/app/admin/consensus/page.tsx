'use client';

import { useState } from 'react';

/**
 * Consensus re-analysis of one project.
 *
 * Extraction is not deterministic: measured on 2026-09-14, the same prompt
 * version returns different targets between runs — only 58.6% repeat across
 * three. A claim seen once may not exist on the next pass.
 *
 * This screen runs N times and shows how often each target came back. Nothing
 * is written: it serves the moment someone is about to look closely at a
 * project and needs to know what holds. 3 of 3 supports a conversation; 1 of 3
 * does not.
 *
 * The unstable ones are shown too, deliberately — hiding them would project a
 * certainty the measurement does not have.
 */

interface ConsensusClaim {
  target_kind: string;
  target: string;
  runs: number;
  role: string | null;
  severity: string | null;
  roleVariants?: string[];
  severityVariants?: string[];
  evidence_quote: string;
  evidence_file: string;
}

export default function ConsensusPage() {
  const [projectId, setProjectId] = useState('');
  const [runs, setRuns] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ claims: ConsensusClaim[]; runs: number } | null>(null);

  const run = async () => {
    const id = projectId.trim().toUpperCase();
    if (!id || busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const res = await fetch(
        `/api/admin/goals-consensus?projectId=${encodeURIComponent(id)}&runs=${runs}`,
        { method: 'POST' }
      );
      const d = await res.json();
      if (d.error) setError(d.error);
      else setResult({ claims: d.claims ?? [], runs: d.runs });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tone = (c: ConsensusClaim, total: number) =>
    c.runs === total ? { fg: 'var(--tone-ok-fg)', bg: 'var(--tone-ok-bg)', label: 'solid' }
    : c.runs === 1 ? { fg: 'var(--tone-warn-fg)', bg: 'var(--tone-warn-bg)', label: 'unstable' }
    : { fg: 'var(--ink-3)', bg: 'var(--surface-2)', label: 'partial' };

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>
        Consensus re-analysis
      </h1>
      <p style={{ fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1.6, marginBottom: 20 }}>
        Runs the extraction several times and shows how often each target came back.
        Nothing is written to the database. Use it before looking closely at a
        project: what appears in every run is what holds.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') run(); }}
          placeholder="PRJ0021172"
          disabled={busy}
          style={{
            flex: 1, padding: '10px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
            color: 'var(--ink-1)', fontSize: 14, outline: 'none',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        />
        <select
          value={runs}
          onChange={e => setRuns(Number(e.target.value))}
          disabled={busy}
          style={{
            padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)', color: 'var(--ink-1)', fontSize: 13,
          }}
        >
          {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n} runs</option>)}
        </select>
        <button
          onClick={run}
          disabled={busy || !projectId.trim()}
          style={{
            padding: '10px 18px', borderRadius: 8, border: 'none',
            background: 'var(--accent-hover)', color: '#fff',
            fontSize: 13, fontWeight: 600,
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? `running ${runs}×…` : 'Run'}
        </button>
      </div>

      {busy && (
        <p style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
          One LLM call per run — roughly 40 seconds each.
        </p>
      )}
      {error && <p style={{ fontSize: 13, color: 'var(--tone-bad-fg)' }}>{error}</p>}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
            {result.claims.filter(c => c.runs === result.runs).length} of {result.claims.length}
            {' '}target(s) appeared in all {result.runs} runs
          </div>

          {result.claims.map(c => {
            const t = tone(c, result.runs);
            return (
              <div key={`${c.target_kind}:${c.target}`} style={{
                border: '1px solid var(--border)', borderRadius: 10,
                background: 'var(--surface-1)', padding: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, background: t.bg, color: t.fg,
                    fontSize: 11, fontWeight: 700,
                  }}>
                    {c.runs}/{result.runs} · {t.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--ink-faint)', textTransform: 'uppercase' }}>
                    {c.target_kind}
                  </span>
                  <strong style={{ fontSize: 14, color: 'var(--ink-1)' }}>{c.target}</strong>
                </div>

                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
                  {/* Disagreement is shown, not resolved: silently picking one
                      of the variants would erase the signal itself. */}
                  role: {c.role ?? <em style={{ color: 'var(--tone-warn-fg)' }}>
                    varies — {c.roleVariants?.join(' / ')}
                  </em>}
                  {'  ·  '}
                  severity: {c.severity ?? <em style={{ color: 'var(--tone-warn-fg)' }}>
                    varies — {c.severityVariants?.join(' / ')}
                  </em>}
                </div>

                <p style={{
                  fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.5,
                  margin: 0, fontStyle: 'italic',
                }}>
                  “{c.evidence_quote}”
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
