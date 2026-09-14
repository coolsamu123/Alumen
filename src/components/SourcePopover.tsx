'use client';

import { useEffect, useRef, useState } from 'react';

// Shape used by both Impact citations and Deep-Dive sources. The two backend
// types are structurally identical from the popover's point of view, so we
// accept a thin shared interface and let callers map their own arrays in.
export interface SourceRef {
  doc_url: string;
  file_name: string;
  snippet: string;
}

// Small clickable icon that opens a floating panel with the source list.
// Used in two places:
//   • Impact "Reason for the impact" — one popover per explanation.
//   • Deep-Dive — one popover per section, fed from the trailing
//     `_Sources: [n]_` markers parsed out of the markdown.
// Clicking a file name opens the GDrive URL in a new tab.
export function SourcePopover({ sources, label }: { sources: SourceRef[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  // Close when clicking outside. Bound only while the popover is open so
  // closed instances don't carry an idle listener around.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!sources || sources.length === 0) return null;

  return (
    <span ref={containerRef} className="relative inline-block align-middle ml-1.5">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title={label || `${sources.length} source${sources.length > 1 ? 's' : ''}`}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-accent-soft border border-accent-border/60 text-[11px] font-bold text-accent-text hover:bg-accent-border/40 transition-colors"
      >
        {sources.length}
      </button>
      {open && (
        <span
          role="dialog"
          className="absolute z-50 right-0 top-full mt-1.5 w-80 max-w-[90vw] rounded-md border border-line-strong bg-surface-2 shadow-2xl p-3 text-left animate-fadeIn"
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[11px] uppercase tracking-wider text-ink-2 mb-2 font-bold">
            {label || 'Sources'}
          </div>
          <ul className="space-y-3">
            {sources.map((s, i) => (
              <li key={`${s.doc_url}-${i}`} className="text-[11px] leading-snug">
                <a
                  href={s.doc_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block font-semibold text-accent-text hover:text-accent-text2 hover:underline break-words"
                  title={s.doc_url}
                >
                  📄 {s.file_name || s.doc_url}
                </a>
                {s.snippet && (
                  <div className="text-ink-2 italic mt-1 line-clamp-3">&ldquo;{s.snippet}&rdquo;</div>
                )}
              </li>
            ))}
          </ul>
        </span>
      )}
    </span>
  );
}
