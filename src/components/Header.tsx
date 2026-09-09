'use client';

import { useProjectContext } from '@/context/ProjectContext';
import type { ViewType } from '@/lib/types';

const NAV_ITEMS: { key: ViewType; label: string }[] = [
  { key: 'impact', label: '→ Impact' },
  { key: 'graph', label: '⬡ Graph' },
  { key: 'timeline', label: '⟶ Timeline' },
  { key: 'detail', label: '≡ Details' },
  { key: 'goals', label: '✦ Goals Extractor' },
  { key: 'drive', label: '☁ Drive Sync' },
  { key: 'strom', label: '✦ Alumen' },
];

// Views that don't fetch anything protected. Anonymous external visitors can
// land on these directly; clicking a gated view still works for GETs (Goals
// is read-open — see middleware.ts) but its write actions render disabled
// (ImpactView/GoalsView/DetailView check `isAdmin` themselves).

// Drive Sync is the one nav item gated by role rather than by button: every
// method on /api/drive/* requires admin server-side (middleware.ts), so a
// basic user landing there would see a view built entirely of 401s. Locking
// the nav item itself (same treatment as the Admin link below) is the
// correct level for an all-or-nothing view, vs. disabling individual buttons
// inside a view basic users can otherwise use normally.
const ADMIN_ONLY_VIEWS = new Set<ViewType>(['drive']);

export default function Header() {
  const { view, setView, isPublic, isAdmin, theme, toggleTheme } = useProjectContext();
  const navItems = NAV_ITEMS;

  return (
    <div className="px-6 py-3 border-b border-line flex items-center gap-4 bg-surface">
      <div className="flex items-center gap-3">
        <img src="/icon-192.png" alt="Alumen" className="w-10 h-10 rounded-lg" />
        <div className="leading-none">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold text-ink-1 tracking-tight">Alumen</span>
            <span className="text-sm font-medium text-ink-4 tracking-tight">— Portfolio Intelligence</span>
          </div>
          <div className="text-xs text-ink-muted mt-1">Air Liquide</div>
        </div>
      </div>

      <div className="flex-1" />

      {navItems.map(({ key, label }) => {
        const locked = ADMIN_ONLY_VIEWS.has(key) && !isAdmin;
        return (
          <button
            key={key}
            onClick={() => !locked && setView(key)}
            disabled={locked}
            title={locked ? 'Requer perfil administrador' : undefined}
            className={`px-4 py-1.5 rounded-md border text-[13px] font-medium transition-all
              ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
              ${view === key
                ? 'bg-accent-soft border-accent-border text-accent-text'
                : 'bg-transparent border-transparent text-ink-4 hover:bg-surface-2'
              }`}
          >
            {locked ? `🔒 ${label}` : label}
          </button>
        );
      })}

      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="w-8 h-8 flex items-center justify-center rounded-md border border-line-strong text-ink-3 hover:bg-surface-2 hover:text-ink-1 transition-all"
      >
        <span className="text-base leading-none">{theme === 'dark' ? '☀' : '☾'}</span>
      </button>

      <div className="w-px h-6 bg-surface-3" />
      <a
        href="/admin"
        title={isPublic ? 'Sign in required' : !isAdmin ? 'Requer perfil administrador' : 'Admin'}
        className="px-4 py-1.5 rounded-md border border-line-strong text-[13px] font-medium text-ink-4 hover:bg-surface-2 hover:text-ink-2 transition-all"
      >
        {isAdmin ? 'Admin' : '🔒 Admin'}
      </a>
    </div>
  );
}
