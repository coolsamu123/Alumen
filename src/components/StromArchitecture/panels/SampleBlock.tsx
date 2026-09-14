import type { Sample } from '../samples';

// Light syntax tinting based on the declared language.
// Keeps the bundle small (no shiki/highlight.js dep) while giving the eye
// enough cues to scan a JSON vs SQL vs prompt block.

const LANG_LABEL: Record<Sample['language'], string> = {
  json: 'JSON',
  sql: 'SQL row',
  typescript: 'TypeScript',
  markdown: 'Markdown',
  text: 'Plain text',
  http: 'HTTP',
};

const LANG_COLOR: Record<Sample['language'], string> = {
  json: 'text-amber-200',
  sql: 'text-cyan-200',
  typescript: 'text-purple-200',
  markdown: 'text-emerald-100',
  text: 'text-ink-2',
  http: 'text-blue-200',
};

export default function SampleBlock({ sample }: { sample: Sample }) {
  return (
    <div className="space-y-2">
      {sample.intro && (
        <p className="text-xs text-ink-3 leading-relaxed">{sample.intro}</p>
      )}
      <div className="bg-surface-deep border border-line rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-2/40 border-b border-line">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
            {LANG_LABEL[sample.language]}
          </span>
          <CopyButton text={sample.code} />
        </div>
        <pre className={`p-3 text-[11px] font-mono leading-relaxed overflow-x-auto ${LANG_COLOR[sample.language]}`}>
{sample.code}
        </pre>
      </div>
      {sample.caption && (
        <p className="text-[11px] text-ink-muted italic leading-snug">{sample.caption}</p>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
      className="text-[11px] text-ink-muted hover:text-ink-2 px-1.5 py-0.5 rounded hover:bg-surface-2 transition-colors"
      title="Copy to clipboard"
    >
      copy
    </button>
  );
}
