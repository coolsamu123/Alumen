'use client';

import { useEffect, useRef, useState } from 'react';
import { useProjectContext } from '@/context/ProjectContext';

function initials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  if (!source) return '?';
  // "Samuel Ramos" → SR; "samuel.ramos@..." → S
  const words = source.split(/[\s.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source[0].toUpperCase();
}

export default function UserMenu() {
  const { user } = useProjectContext();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
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

  // Rendered by the app shell, which only exists behind the session gate —
  // but /login shares the same layout, so guard rather than assume.
  if (!user) return null;

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Even if the request fails the cookie may already be gone; the reload
      // below lands on /login either way, since middleware gates everything.
    }
    // Full reload rather than a client-side push: drops every bit of cached
    // portfolio data held in ProjectContext, so the next user on this browser
    // never sees the previous one's projects flash before the redirect.
    window.location.href = '/login';
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${user.name || user.email} — ${user.role === 'admin' ? 'Administrador' : 'Básico'}`}
        className={`w-8 h-8 flex items-center justify-center rounded-full border text-[11px] font-bold transition-all
          ${open
            ? 'bg-accent-soft border-accent-border text-accent-text'
            : 'bg-surface-2 border-line-strong text-ink-3 hover:text-ink-1 hover:border-accent-border'
          }`}
      >
        {initials(user.name, user.email)}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-60 rounded-lg border border-line bg-surface-1 shadow-xl overflow-hidden"
        >
          <div className="px-3.5 py-3 border-b border-line">
            <div className="text-[13px] font-semibold text-ink-1 truncate">{user.name || '—'}</div>
            <div className="text-[11px] text-ink-muted truncate mt-0.5">{user.email}</div>
            <span
              className={`inline-block mt-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                user.role === 'admin'
                  ? 'bg-accent-soft text-accent-text border border-accent-border'
                  : 'bg-surface-2 text-ink-4 border border-line'
              }`}
            >
              {user.role === 'admin' ? 'Administrador' : 'Básico'}
            </span>
          </div>

          <button
            role="menuitem"
            onClick={handleLogout}
            disabled={signingOut}
            className="w-full text-left px-3.5 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            {signingOut ? 'Saindo…' : '↪ Sair'}
          </button>
        </div>
      )}
    </div>
  );
}
