'use client';

import { useEffect, useRef, useState } from 'react';
import { useProjectContext, type ThemePreference } from '@/context/ProjectContext';

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follows your OS' },
  { value: 'light', label: 'Light', hint: 'Bright rooms' },
  { value: 'dark', label: 'Dark', hint: 'Graphite' },
  { value: 'dim', label: 'Dim', hint: 'Softer contrast' },
];

function ThemeIcon({ pref }: { pref: ThemePreference }) {
  const svg = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (pref === 'light') {
    return (
      <svg {...svg}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (pref === 'dark') {
    return <svg {...svg}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>;
  }
  if (pref === 'dim') {
    return (
      <svg {...svg}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...svg}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export default function ThemeMenu() {
  const { themePreference, setThemePreference } = useProjectContext();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — same behavior as UserMenu.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = OPTIONS.find(o => o.value === themePreference) ?? OPTIONS[0];

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        className={`w-8 h-8 flex items-center justify-center rounded-md border transition-colors
          ${open
            ? 'bg-accent-soft border-accent-border text-accent-text'
            : 'border-line-strong text-ink-3 hover:bg-surface-2 hover:text-ink-1'
          }`}
      >
        <ThemeIcon pref={current.value} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 top-10 z-50 w-48 rounded-lg border border-line bg-surface-1 shadow-xl overflow-hidden py-1"
        >
          {OPTIONS.map(opt => {
            const active = opt.value === themePreference;
            return (
              <button
                key={opt.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { setThemePreference(opt.value); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
                  ${active ? 'bg-accent-soft text-accent-text' : 'text-ink-2 hover:bg-surface-2'}`}
              >
                <ThemeIcon pref={opt.value} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium">{opt.label}</span>
                  <span className={`block text-[11px] ${active ? 'text-accent-text' : 'text-ink-muted'}`}>{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
