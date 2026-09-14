'use client';

import { useProjectContext } from '@/context/ProjectContext';
import { ADMIN_ONLY_TITLE } from '@/lib/constants';
import UserMenu from './UserMenu';
import ThemeMenu from './ThemeMenu';
import type { ViewType } from '@/lib/types';

// Plain labels. The unicode glyphs that used to prefix them (→ ⬡ ⟶ ≡ ✦ ☁) read
// as noise at 13px, and Goals Extractor and Alumen shared the same ✦.
const NAV_ITEMS: { key: ViewType; label: string }[] = [
  { key: 'impact', label: 'Impact' },
  { key: 'graph', label: 'Graph' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'detail', label: 'Details' },
  { key: 'goals', label: 'Goals Extractor' },
  { key: 'drive', label: 'Drive Sync' },
  { key: 'strom', label: 'Alumen' },
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
  const { view, setView, isAdmin } = useProjectContext();

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

      <nav className="flex items-center gap-1">
        {NAV_ITEMS.map(({ key, label }) => {
          const locked = ADMIN_ONLY_VIEWS.has(key) && !isAdmin;
          const active = view === key;
          return (
            <button
              key={key}
              onClick={() => !locked && setView(key)}
              disabled={locked}
              title={locked ? ADMIN_ONLY_TITLE : undefined}
              aria-current={active ? 'page' : undefined}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-medium transition-colors
                ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                ${active
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-ink-4 hover:bg-surface-2 hover:text-ink-2'
                }`}
            >
              {locked ? `🔒 ${label}` : label}
            </button>
          );
        })}
      </nav>

      <ThemeMenu />

      <div className="w-px h-6 bg-line-strong" />
      <a
        href="/admin"
        title={isAdmin ? 'Admin' : ADMIN_ONLY_TITLE}
        className="px-4 py-1.5 rounded-md border border-line-strong text-[13px] font-medium text-ink-4 hover:bg-surface-2 hover:text-ink-2 transition-colors"
      >
        {isAdmin ? 'Admin' : '🔒 Admin'}
      </a>

      <UserMenu />
    </div>
  );
}
