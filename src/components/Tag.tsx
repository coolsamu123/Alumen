import type { ReactNode } from 'react';

// Every tag family in Alumen maps to one semantic tone, and each tone is a
// fg/bg/border triple defined per theme in globals.css (--tone-*). Components
// pick a tone, never a Tailwind hue, so a new theme only redefines tokens.
export type Tone = 'tech' | 'vendor' | 'data' | 'dds' | 'gio' | 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

// Spelled out in full: Tailwind only generates classes it finds verbatim.
const TONE_CLASS: Record<Tone, string> = {
  tech: 'bg-tone-tech-bg text-tone-tech-fg border-tone-tech-bd',
  vendor: 'bg-tone-vendor-bg text-tone-vendor-fg border-tone-vendor-bd',
  data: 'bg-tone-data-bg text-tone-data-fg border-tone-data-bd',
  dds: 'bg-tone-dds-bg text-tone-dds-fg border-tone-dds-bd',
  gio: 'bg-tone-gio-bg text-tone-gio-fg border-tone-gio-bd',
  neutral: 'bg-tone-neutral-bg text-tone-neutral-fg border-tone-neutral-bd',
  ok: 'bg-tone-ok-bg text-tone-ok-fg border-tone-ok-bd',
  warn: 'bg-tone-warn-bg text-tone-warn-fg border-tone-warn-bd',
  bad: 'bg-tone-bad-bg text-tone-bad-fg border-tone-bad-bd',
  info: 'bg-tone-info-bg text-tone-info-fg border-tone-info-bd',
};

export function severityTone(severity: string | null | undefined): Tone {
  if (severity === 'high') return 'bad';
  // 'medium' is a legacy alias of low (see SEVERITY_COLORS).
  if (severity === 'low' || severity === 'medium') return 'info';
  return 'neutral';
}

export default function Tag({ tone, children, mono = false, title, onClick, className = '' }: {
  tone: Tone;
  children: ReactNode;
  /** Identifiers (PRJ/PGM ids) keep the mono face; names and labels don't. */
  mono?: boolean;
  title?: string;
  /** Makes the tag a button — use for tags that navigate, e.g. a cited project. */
  onClick?: () => void;
  className?: string;
}) {
  const cls = `inline-flex items-center px-2 py-0.5 rounded-md border leading-[18px] font-medium whitespace-nowrap
    ${mono ? 'font-mono text-[11px]' : 'text-[12px]'} ${TONE_CLASS[tone]} ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${cls} cursor-pointer hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-border/50`}
      >
        {children}
      </button>
    );
  }
  return <span title={title} className={cls}>{children}</span>;
}
